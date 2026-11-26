from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from click.testing import CliRunner
import httpx


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "chronam"


def load_chronam_module():
    loader = SourceFileLoader("chronam_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("chronam_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


# Never let a test read or write the real user cache: point every test at a
# throwaway directory before the CLI module loads. Tests that inspect the
# cache override this with their own temp dir.
_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_CHRONAM_CACHE_DIR"] = _TEST_CACHE.name

chronam = load_chronam_module()


class TestChronamCli(unittest.TestCase):
    def test_search_sends_at_search_results_and_aliases(self) -> None:
        captured: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured.append(request)
            return httpx.Response(
                200,
                json={
                    "search": {"hits": 1},
                    "results": [
                        {
                            "partof_title": ["Chicago daily tribune"],
                            "date": "1860-11-07",
                            "location_state": ["illinois"],
                            "location_county": ["cook"],
                            "location_city": ["chicago"],
                            "number_lccn": ["sn84031490"],
                            "number_page": ["1"],
                            "url": "https://www.loc.gov/resource/sn84031490/1860-11-07/ed-1/?sp=1",
                            "id": "http://www.loc.gov/resource/sn84031490/1860-11-07/ed-1/?sp=1",
                        }
                    ],
                },
            )

        runner = CliRunner()
        mock_client = httpx.Client(transport=httpx.MockTransport(handler))
        orig_get_json = chronam._get_json

        def patched_get_json(url, params=None, *, timeout=chronam.DEFAULT_TIMEOUT, client=None):
            return orig_get_json(url, params=params, timeout=timeout, client=mock_client)

        with patch.object(chronam, "_get_json", side_effect=patched_get_json):
            res = runner.invoke(
                chronam.cli,
                [
                    "search",
                    "--terms",
                    "Lincoln",
                    "--date-from",
                    "1860",
                    "--date-to",
                    "1865",
                    "--state",
                    "Illinois",
                    "--per-page",
                    "5",
                    "--json",
                ],
            )
        mock_client.close()

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(len(captured), 1)
        params = dict(captured[0].url.params.multi_items())
        self.assertEqual(params["q"], "Lincoln")
        self.assertEqual(params["at"], "search,results")
        self.assertEqual(params["dates"], "1860/1865")
        self.assertEqual(params["c"], "5")
        self.assertEqual(params["fa"], "location_state:illinois")
        payload = json.loads(res.output)
        self.assertEqual(payload["hits"], 1)
        self.assertEqual(payload["results"][0]["title"], "Chicago daily tribune")

    def test_read_timeout_fails_fast_without_retrying(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ReadTimeout("The read operation timed out", request=request)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            t0 = time.monotonic()
            with self.assertRaises(chronam.click.ClickException) as ctx:
                chronam._get_json(chronam.COLLECTION_BASE, params=[("q", "Lincoln")], timeout=5.0, client=client)
            elapsed = time.monotonic() - t0

        self.assertEqual(attempts, 1)
        self.assertLess(elapsed, 2.0)
        self.assertIn("timed out after 5.0s", str(ctx.exception))
        self.assertIn("chronam url", str(ctx.exception))

    def test_503_retries_once_and_raises_actionable_error(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            return httpx.Response(503, text="Service Unavailable", request=request)

        with (
            patch.object(chronam.time, "sleep", return_value=None),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            with self.assertRaises(chronam.click.ClickException) as ctx:
                chronam._get_json(chronam.COLLECTION_BASE, params=[("q", "Lincoln")], timeout=8.0, client=client)

        self.assertEqual(attempts, 2)
        self.assertIn("HTTP 503", str(ctx.exception))

    def test_remote_protocol_error_recovers_on_retry(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.RemoteProtocolError("peer closed connection", request=request)
            return httpx.Response(200, json={"search": {"hits": 2}, "results": []})

        with (
            patch.object(chronam.time, "sleep", return_value=None),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            data = chronam._get_json(chronam.COLLECTION_BASE, params=[("q", "Lincoln")], timeout=8.0, client=client)

        self.assertEqual(attempts, 2)
        self.assertEqual(data["search"]["hits"], 2)

    def test_429_honors_retry_after_then_succeeds(self) -> None:
        attempts = 0
        sleeps: list[float] = []

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, headers={"Retry-After": "3"}, text="slow down")
            return httpx.Response(200, json={"search": {"hits": 1}, "results": [{"date": "1880"}]})

        with (
            patch.object(chronam.time, "sleep", side_effect=sleeps.append),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            data = chronam._get_json(chronam.COLLECTION_BASE, params=[("q", "x")], timeout=60.0, client=client)

        self.assertEqual(attempts, 2)
        self.assertEqual(sleeps, [3.0])
        self.assertEqual(data["search"]["hits"], 1)

    def test_default_timeout_covers_measured_loc_gov_latency(self) -> None:
        # loc.gov search TTFB measured 19-70 s on 2026-11-25; 8 s failed 80%+ of calls.
        self.assertGreaterEqual(chronam.DEFAULT_TIMEOUT, 90.0)


class TestChronamCacheAndAliases(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._env = patch.dict(os.environ, {"KINLOOM_CHRONAM_CACHE_DIR": self._tmp.name})
        self._env.start()
        self.calls: list[list[tuple[str, str]]] = []
        self.response: dict = {
            "search": {"hits": 3},
            "results": [{"partof_title": ["Sacramento daily union"], "date": "1885-01-02",
                         "location_state": ["california"], "url": "https://www.loc.gov/resource/x/"}],
        }

        def fake_get_json(url, params=None, *, timeout=chronam.DEFAULT_TIMEOUT, client=None):
            self.calls.append(list(params or []))
            return json.loads(json.dumps(self.response))

        self._patch = patch.object(chronam, "_get_json", side_effect=fake_get_json)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._env.stop()
        self._tmp.cleanup()

    def invoke(self, *args: str):
        return CliRunner().invoke(chronam.cli, ["search", *args, "--json"])

    def test_repeat_search_is_served_from_disk_cache(self) -> None:
        first = self.invoke("Sacramento", "--state", "California", "--dates", "1880/1900")
        t0 = time.monotonic()
        second = self.invoke("Sacramento", "--state", "California", "--dates", "1880/1900")
        elapsed = time.monotonic() - t0

        self.assertEqual(first.exit_code, 0, first.output)
        self.assertEqual(second.exit_code, 0, second.output)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(json.loads(first.output)["cache_hit"])
        self.assertTrue(json.loads(second.output)["cache_hit"])
        self.assertEqual(json.loads(second.output)["results"][0]["title"], "Sacramento daily union")
        self.assertLess(elapsed, 1.0)
        self.assertEqual(len(list(Path(self._tmp.name).glob("*.json"))), 1)

    def test_refresh_bypasses_cache(self) -> None:
        self.invoke("Merced")
        self.invoke("Merced", "--refresh")
        self.assertEqual(len(self.calls), 2)

    def test_expired_ttl_refetches(self) -> None:
        self.invoke("Merced")
        self.invoke("Merced", "--cache-ttl-hours", "0")
        self.assertEqual(len(self.calls), 2)

    def test_zero_hit_answers_are_not_cached(self) -> None:
        self.response = {"search": {"hits": 0}, "results": []}
        first = self.invoke("Zzyzx")
        self.invoke("Zzyzx")
        self.assertEqual(first.exit_code, 0, first.output)
        self.assertIn("never cached", first.output)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(list(Path(self._tmp.name).glob("*.json")), [])

    def test_unquoted_multiword_query_and_flag_aliases(self) -> None:
        res = self.invoke("Abraham", "Lincoln", "--state", "IL", "--date1", "1860", "--date2", "1865",
                          "--rows", "5")
        self.assertEqual(res.exit_code, 0, res.output)
        params = dict(self.calls[0])
        self.assertEqual(params["q"], "Abraham Lincoln")
        self.assertEqual(params["fa"], "location_state:illinois")
        self.assertEqual(params["dates"], "1860/1865")
        self.assertEqual(params["c"], "5")

    def test_query_flag_alias_and_single_year_dates(self) -> None:
        res = self.invoke("--query", "Lincoln", "--dates", "1865")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(dict(self.calls[0])["dates"], "1865/1865")

    def test_bad_dates_exit_2_without_network(self) -> None:
        res = self.invoke("Lincoln", "--dates", "18601865")
        self.assertEqual(res.exit_code, 2)
        self.assertEqual(self.calls, [])

    def test_missing_query_exit_2(self) -> None:
        res = self.invoke()
        self.assertEqual(res.exit_code, 2)
        self.assertIn("QUERY", res.output)


class TestChronamGetAndDownloadCache(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._env = patch.dict(os.environ, {"KINLOOM_CHRONAM_CACHE_DIR": self._tmp.name})
        self._env.start()
        self.get_calls: list[str] = []
        self.download_calls: list[str] = []
        self.item = {
            "item": {
                "title": "Evening Star",
                "date": "1865-04-15",
                "number_lccn": ["sn83045462"],
                "location_city": ["washington"],
                "location_state": ["district of columbia"],
            },
            "resource": {"title": "Evening Star"},
            "resources": [
                {
                    "pdf": "https://tile.loc.gov/storage-services/service/ndnp/sn83045462/print.pdf",
                    "image": "https://tile.loc.gov/image-services/iiif/example/full/pct:50/0/default.jpg",
                    "fulltext_file": "https://tile.loc.gov/storage-services/service/ndnp/sn83045462/ocr.xml",
                }
            ],
        }

        def fake_get_json(url, params=None, *, timeout=chronam.DEFAULT_TIMEOUT, client=None):
            self.get_calls.append(url)
            return json.loads(json.dumps(self.item))

        def fake_download(url, *, timeout):
            self.download_calls.append(url)
            return b"%PDF-1.4 Lincoln"

        self._get = patch.object(chronam, "_get_json", side_effect=fake_get_json)
        self._download = patch.object(chronam, "_download_bytes", side_effect=fake_download)
        self._get.start()
        self._download.start()

    def tearDown(self) -> None:
        self._download.stop()
        self._get.stop()
        self._env.stop()
        self._tmp.cleanup()

    def test_get_repeat_is_a_cache_hit_and_refresh_fetches(self) -> None:
        runner = CliRunner()
        args = ["get", "--lccn", "sn83045462", "--date", "1865-04-15", "--seq", "1"]
        first = runner.invoke(chronam.cli, args)
        second = runner.invoke(chronam.cli, args)
        self.assertEqual(first.exit_code, 0, first.output)
        self.assertEqual(second.exit_code, 0, second.output)
        self.assertIn("Evening Star", second.output)
        self.assertEqual(self.get_calls, [
            "https://www.loc.gov/resource/sn83045462/1865-04-15/ed-1/?sp=1&fo=json"
        ])
        self.assertEqual(len(self.get_calls), 1)
        self.assertEqual(self.download_calls, [])

        refreshed = runner.invoke(chronam.cli, [*args, "--refresh"])
        self.assertEqual(refreshed.exit_code, 0, refreshed.output)
        self.assertIn("Evening Star", refreshed.output)
        self.assertEqual(len(self.get_calls), 2)

    def test_download_repeat_copies_bytes_with_no_http_and_refresh_bypasses(self) -> None:
        runner = CliRunner()
        with tempfile.TemporaryDirectory() as work:
            out = Path(work) / "papers"
            args = [
                "download",
                "--lccn",
                "sn83045462",
                "--date",
                "1865-04-15",
                "--seq",
                "1",
                "--out",
                str(out),
                "--no-image",
                "--no-text",
            ]
            first = runner.invoke(chronam.cli, args)
            self.assertEqual(first.exit_code, 0, first.output)
            pdfs = list(out.glob("*.pdf"))
            self.assertEqual(len(pdfs), 1)
            self.assertEqual(pdfs[0].read_bytes(), b"%PDF-1.4 Lincoln")
            self.assertNotIn("[cache]", first.output)
            self.assertEqual(len(self.get_calls), 1)
            self.assertEqual(len(self.download_calls), 1)
            self.assertTrue(self.download_calls[0].startswith("https://tile.loc.gov/"))

            second = runner.invoke(chronam.cli, args)
            self.assertEqual(second.exit_code, 0, second.output)
            self.assertIn("[cache]", second.output)
            self.assertEqual(pdfs[0].read_bytes(), b"%PDF-1.4 Lincoln")
            self.assertEqual(len(self.get_calls), 1)
            self.assertEqual(len(self.download_calls), 1)

            refreshed = runner.invoke(chronam.cli, [*args, "--refresh"])
            self.assertEqual(refreshed.exit_code, 0, refreshed.output)
            self.assertNotIn("[cache]", refreshed.output)
            self.assertEqual(pdfs[0].read_bytes(), b"%PDF-1.4 Lincoln")
            self.assertEqual(len(self.get_calls), 2)
            self.assertEqual(len(self.download_calls), 2)

            expired = runner.invoke(chronam.cli, [*args, "--cache-ttl-hours", "0"])
            self.assertEqual(expired.exit_code, 0, expired.output)
            self.assertEqual(len(self.download_calls), 3)
            self.assertEqual(pdfs[0].read_bytes(), b"%PDF-1.4 Lincoln")

    def test_download_rejects_path_traversal_in_item_fields(self) -> None:
        self.item["item"]["date"] = "../../outside"
        self.item["item"]["number_lccn"] = ["../sn83045462"]
        runner = CliRunner()
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            out = root / "out"
            res = runner.invoke(
                chronam.cli,
                [
                    "download",
                    "--lccn",
                    "sn83045462",
                    "--date",
                    "1865-04-15",
                    "--seq",
                    "1",
                    "--out",
                    str(out),
                ],
            )
            self.assertEqual(res.exit_code, 0, res.output)
            written = [path for path in root.rglob("*") if path.is_file()]
            pdfs = [path for path in written if path.suffix == ".pdf"]
            self.assertEqual(len(pdfs), 1)
            self.assertEqual(pdfs[0].read_bytes(), b"%PDF-1.4 Lincoln")
            for path in written:
                self.assertTrue(path.resolve().is_relative_to(out.resolve()), path)
                self.assertNotIn("..", path.name)


if __name__ == "__main__":
    unittest.main()
