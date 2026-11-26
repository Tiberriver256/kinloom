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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "nara"


def load_nara_module():
    loader = SourceFileLoader("nara_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("nara_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


nara = load_nara_module()


class TestNaraWafAndParallelism(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-nara-test-")
        self._env_patch = patch.dict(
            os.environ, {"KINLOOM_NARA_CACHE_DIR": self._tmp.name}
        )
        self._env_patch.start()

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmp.cleanup()
    def test_normalize_query_for_waf_retry(self) -> None:
        self.assertEqual(
            nara._normalize_query_for_waf_retry('"Merced" AND "24-7" AND "1940"'),
            "Merced 24-7 1940",
        )
        self.assertEqual(
            nara._normalize_query_for_waf_retry("Merced AND 24-7 AND 1940"),
            "Merced 24-7 1940",
        )
        self.assertEqual(
            nara._normalize_query_for_waf_retry('"Harriet Tubman"'),
            "Harriet Tubman",
        )
        self.assertIsNone(nara._normalize_query_for_waf_retry("Merced 24-7 1940"))
        self.assertIsNone(nara._normalize_query_for_waf_retry('""'))

    def test_api_get_json_raises_typed_error_on_html_waf(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers.get("accept"), "application/json")
            self.assertEqual(request.headers.get("user-agent"), nara.USER_AGENT)
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text="<!doctype html><html><body>WAF challenge</body></html>",
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(nara._NaraWafOrNonJsonError):
                nara._api_get_json("https://catalog.archives.gov/api/v2/records/search?q=test", "k", client=client)

    def test_api_get_json_raises_typed_error_on_403_html(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><body>Forbidden by WAF</body></html>",
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(nara._NaraWafOrNonJsonError):
                nara._api_get_json("https://catalog.archives.gov/api/v2/records/search?q=test", "k", client=client)

    def test_cmd_search_retries_waf_blocked_query_without_quotes_or_and(self) -> None:
        seen_urls: list[str] = []

        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            seen_urls.append(url)
            if "%22" in url or "AND" in url:
                raise nara._NaraWafOrNonJsonError(url, "text/html")
            return {
                "body": {
                    "hits": {
                        "total": {"value": 1},
                        "hits": [
                            {
                                "_source": {
                                    "record": {
                                        "naId": 123456,
                                        "title": "1940 Census Merced ED 24-7",
                                        "levelOfDescription": "fileUnit",
                                        "recordGroupNumber": 29,
                                    }
                                }
                            }
                        ],
                    }
                }
            }

        runner = CliRunner()
        with (
            patch.object(nara, "_api_get_json", side_effect=fake_api_get_json),
            patch.object(nara, "_browser_search_many", side_effect=AssertionError("browser fallback must not run")),
        ):
            res = runner.invoke(
                nara.cli,
                ["search", '"Merced" AND "24-7" AND "1940"', "--rg", "29", "--online", "--limit", "5", "--api-key", "test-key", "--json"],
            )

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(len(seen_urls), 2)
        self.assertIn("q=Merced%2024-7%201940", seen_urls[1])
        payload = nara.json.loads(res.output)
        self.assertEqual(payload["query"], '"Merced" AND "24-7" AND "1940"')
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["results"][0]["naId"], "123456")

    def test_cmd_search_falls_back_to_browser_only_for_failed_queries_preserving_order(self) -> None:
        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            if "AlwaysWaf" in url:
                raise nara._NaraWafOrNonJsonError(url, "text/html")
            naid = "111" if "Harriet" in url else "333"
            return {
                "body": {
                    "hits": {
                        "total": {"value": 1},
                        "hits": [{"_source": {"record": {"naId": naid, "title": f"Record {naid}"}}}],
                    }
                }
            }

        browser_calls: list[list[tuple[str | None, str]]] = []

        def fake_browser_search_many(pairs: list[tuple[str | None, str]]):
            browser_calls.append(pairs)
            return [
                {
                    "query": q,
                    "searchUrl": u,
                    "total": 1,
                    "results": [{"naId": "222", "title": "Browser Fallback Record", "url": "https://catalog.archives.gov/id/222"}],
                }
                for q, u in pairs
            ]

        runner = CliRunner()
        with (
            patch.object(nara, "_api_get_json", side_effect=fake_api_get_json),
            patch.object(nara, "_browser_search_many", side_effect=fake_browser_search_many),
        ):
            res = runner.invoke(
                nara.cli,
                ["search", "Harriet Tubman", "AlwaysWaf", "Clara Barton", "--api-key", "test-key", "--json"],
            )

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(len(browser_calls), 1)
        self.assertEqual(len(browser_calls[0]), 1)
        self.assertEqual(browser_calls[0][0][0], "AlwaysWaf")
        payloads = nara.json.loads(res.output)
        self.assertEqual([p["query"] for p in payloads], ["Harriet Tubman", "AlwaysWaf", "Clara Barton"])
        self.assertEqual([p["results"][0]["naId"] for p in payloads], ["111", "222", "333"])

    def test_cmd_search_and_cmd_get_parallelize_and_preserve_order(self) -> None:
        def slow_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            time.sleep(0.15)
            for tag in ("300398", "300357", "595367", "Harriet", "Clara", "Frederick"):
                if tag in url:
                    return {
                        "body": {
                            "hits": {
                                "total": {"value": 1},
                                "hits": [{"_source": {"record": {"naId": tag, "title": f"Title {tag}"}}}],
                            }
                        }
                    }
            raise AssertionError(f"Unexpected URL: {url}")

        runner = CliRunner()
        with patch.object(nara, "_api_get_json", side_effect=slow_api_get_json):
            t0 = time.perf_counter()
            res_search = runner.invoke(
                nara.cli,
                ["search", "Harriet", "Clara", "Frederick", "--api-key", "test-key", "--json"],
            )
            dt_search = time.perf_counter() - t0

            t1 = time.perf_counter()
            res_get = runner.invoke(
                nara.cli,
                ["get", "300398", "300357", "595367", "--api-key", "test-key", "--json"],
            )
            dt_get = time.perf_counter() - t1

        self.assertEqual(res_search.exit_code, 0, res_search.output)
        self.assertEqual(res_get.exit_code, 0, res_get.output)
        # Three 150ms calls run concurrently should complete well under 0.40s (serial would be >= 0.45s).
        self.assertLess(dt_search, 0.40)
        self.assertLess(dt_get, 0.40)
        search_payloads = nara.json.loads(res_search.output)
        self.assertEqual([p["query"] for p in search_payloads], ["Harriet", "Clara", "Frederick"])
        get_records = nara.json.loads(res_get.output)
        self.assertEqual([r["naId"] for r in get_records], ["300398", "300357", "595367"])


class TestNaraDiskCaching(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-nara-cache-test-")
        self.cache_root = Path(self._tmp.name) / "cache"
        self.work_dir = Path(self._tmp.name) / "work"
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._env_patch = patch.dict(
            os.environ, {"KINLOOM_NARA_CACHE_DIR": str(self.cache_root)}
        )
        self._env_patch.start()

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmp.cleanup()

    @staticmethod
    def _sample_record_response(
        naid: str,
        title: str,
        *,
        with_text: bool = False,
        page_count: int = 4,
    ) -> dict:
        digital_objects = []
        for idx in range(1, page_count + 1):
            obj: dict = {
                "objectId": f"obj-{idx}",
                "objectFilename": f"sheet_{idx:03d}.jpg",
                "objectUrl": f"https://s3.amazonaws.com/NARAprodstorage/mock/{naid}/sheet_{idx:03d}.jpg",
            }
            if with_text:
                obj["extractedText"] = f"Transcribed page {idx} for {title}"
            digital_objects.append(obj)
        return {
            "body": {
                "hits": {
                    "total": {"value": 1},
                    "hits": [
                        {
                            "_source": {
                                "record": {
                                    "naId": int(naid),
                                    "title": title,
                                    "levelOfDescription": "fileUnit",
                                    "recordGroupNumber": 29,
                                    "digitalObjects": digital_objects,
                                }
                            }
                        }
                    ],
                }
            }
        }

    def test_get_caches_record_serves_objects_and_upgrades_text_with_refresh(self) -> None:
        api_calls: list[str] = []
        version = {"n": 1}

        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            api_calls.append(url)
            include_text = "includeExtractedText=true" in url
            return self._sample_record_response(
                "595367",
                f"1940 Census Merced ED 24-7 v{version['n']}",
                with_text=include_text,
            )

        runner = CliRunner()
        with patch.object(nara, "_api_get_json", side_effect=fake_api_get_json):
            res1 = runner.invoke(nara.cli, ["get", "595367", "--api-key", "k", "--json"])
            self.assertEqual(res1.exit_code, 0, res1.output)
            self.assertEqual(len(api_calls), 1)
            self.assertTrue((self.cache_root / "records" / "595367.json").is_file())
            self.assertNotIn("objects", json.loads(res1.output))

            # Second call with --objects --pages 2-3 hits disk cache: ZERO HTTP requests.
            res2 = runner.invoke(
                nara.cli,
                ["get", "595367", "--objects", "--pages", "2-3", "--api-key", "k", "--json"],
            )
            self.assertEqual(res2.exit_code, 0, res2.output)
            self.assertEqual(len(api_calls), 1)
            p2 = json.loads(res2.output)
            self.assertEqual([o["page"] for o in p2["objects"]], [2, 3])
            self.assertEqual(p2["title"], "1940 Census Merced ED 24-7 v1")

            # Requesting --text upgrades cache once, then second --text makes ZERO HTTP requests.
            res3 = runner.invoke(
                nara.cli,
                ["get", "595367", "--text", "--pages", "1-2", "--api-key", "k", "--json"],
            )
            self.assertEqual(res3.exit_code, 0, res3.output)
            self.assertEqual(len(api_calls), 2)
            p3 = json.loads(res3.output)
            self.assertEqual(len(p3["extractedText"]), 2)

            res4 = runner.invoke(
                nara.cli,
                ["get", "595367", "--text", "--pages", "2", "--api-key", "k", "--json"],
            )
            self.assertEqual(res4.exit_code, 0, res4.output)
            self.assertEqual(len(api_calls), 2)
            self.assertEqual(json.loads(res4.output)["extractedText"][0]["page"], 2)

            # --refresh bypasses disk cache and updates stored metadata.
            version["n"] = 2
            res5 = runner.invoke(
                nara.cli, ["get", "595367", "--refresh", "--api-key", "k", "--json"]
            )
            self.assertEqual(res5.exit_code, 0, res5.output)
            self.assertEqual(len(api_calls), 3)
            self.assertEqual(json.loads(res5.output)["title"], "1940 Census Merced ED 24-7 v2")

    def test_download_overlapping_ranges_reuses_cached_objects_with_zero_http(self) -> None:
        meta_calls: list[str] = []
        obj_calls: list[str] = []
        byte_version = {"v": 1}

        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            meta_calls.append(url)
            return self._sample_record_response("595367", "Census Roll 595367", page_count=4)

        def transport_handler(request: httpx.Request) -> httpx.Response:
            obj_calls.append(str(request.url))
            page_name = str(request.url).rsplit("/", 1)[-1]
            return httpx.Response(200, content=f"BYTES-{page_name}-v{byte_version['v']}".encode())

        def fake_download_client() -> httpx.Client:
            return httpx.Client(transport=httpx.MockTransport(transport_handler))

        out1 = self.work_dir / "out1"
        out2 = self.work_dir / "out2"
        out3 = self.work_dir / "out3"
        out4 = self.work_dir / "out4"

        runner = CliRunner()
        with (
            patch.object(nara, "_api_get_json", side_effect=fake_api_get_json),
            patch.object(nara, "_new_download_client", side_effect=fake_download_client),
        ):
            # Cold download pages 1-3 -> 1 metadata + 3 object fetches.
            r1 = runner.invoke(
                nara.cli,
                ["download", "595367", "--pages", "1-3", "--out", str(out1), "--api-key", "k"],
            )
            self.assertEqual(r1.exit_code, 0, r1.output)
            self.assertEqual(len(meta_calls), 1)
            self.assertEqual(len(obj_calls), 3)
            self.assertEqual(
                (out1 / "002_sheet_002.jpg").read_bytes(), b"BYTES-sheet_002.jpg-v1"
            )
            self.assertTrue(
                (self.cache_root / "objects" / "595367" / "002_sheet_002.jpg").is_file()
            )

            # Overlapping download pages 2-4 -> 0 metadata calls, ONLY page 4 fetched over HTTP!
            r2 = runner.invoke(
                nara.cli,
                ["download", "595367", "--pages", "2-4", "--out", str(out2), "--api-key", "k"],
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(meta_calls), 1)
            self.assertEqual(len(obj_calls), 4)
            self.assertTrue(obj_calls[-1].endswith("sheet_004.jpg"))
            self.assertEqual(
                (out2 / "002_sheet_002.jpg").read_bytes(), b"BYTES-sheet_002.jpg-v1"
            )
            self.assertEqual(
                (out2 / "004_sheet_004.jpg").read_bytes(), b"BYTES-sheet_004.jpg-v1"
            )

            # Full cache hit into a brand-new directory -> ZERO HTTP requests!
            r3 = runner.invoke(
                nara.cli,
                ["download", "595367", "--pages", "1-4", "--out", str(out3), "--api-key", "k"],
            )
            self.assertEqual(r3.exit_code, 0, r3.output)
            self.assertEqual(len(meta_calls), 1)
            self.assertEqual(len(obj_calls), 4)
            self.assertEqual(
                (out3 / "001_sheet_001.jpg").read_bytes(), b"BYTES-sheet_001.jpg-v1"
            )

            # --refresh bypasses both metadata and object caches.
            byte_version["v"] = 2
            r4 = runner.invoke(
                nara.cli,
                [
                    "download",
                    "595367",
                    "--pages",
                    "2",
                    "--out",
                    str(out4),
                    "--refresh",
                    "--api-key",
                    "k",
                ],
            )
            self.assertEqual(r4.exit_code, 0, r4.output)
            self.assertEqual(len(meta_calls), 2)
            self.assertEqual(len(obj_calls), 5)
            self.assertEqual(
                (out4 / "002_sheet_002.jpg").read_bytes(), b"BYTES-sheet_002.jpg-v2"
            )

    def test_search_caches_by_canonical_sha256_and_honors_refresh_and_ttl(self) -> None:
        api_calls: list[str] = []
        seq = {"n": 0}

        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            api_calls.append(url)
            seq["n"] += 1
            return {
                "body": {
                    "hits": {
                        "total": {"value": seq["n"]},
                        "hits": [
                            {
                                "_source": {
                                    "record": {
                                        "naId": 1000 + seq["n"],
                                        "title": f"Harriet Tubman File v{seq['n']}",
                                    }
                                }
                            }
                        ],
                    }
                }
            }

        runner = CliRunner()
        with patch.object(nara, "_api_get_json", side_effect=fake_api_get_json):
            r1 = runner.invoke(
                nara.cli,
                ["search", "Harriet Tubman", "--rg", "15", "--online", "--api-key", "k", "--json"],
            )
            self.assertEqual(r1.exit_code, 0, r1.output)
            self.assertEqual(len(api_calls), 1)
            query_files = list((self.cache_root / "_queries").glob("*.json"))
            self.assertEqual(len(query_files), 1)
            self.assertEqual(len(query_files[0].stem), 64)

            # Second identical call -> ZERO HTTP requests.
            r2 = runner.invoke(
                nara.cli,
                ["search", "Harriet Tubman", "--rg", "15", "--online", "--api-key", "k", "--json"],
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(api_calls), 1)
            self.assertEqual(json.loads(r2.output), json.loads(r1.output))

            # --refresh bypasses query cache.
            r3 = runner.invoke(
                nara.cli,
                [
                    "search",
                    "Harriet Tubman",
                    "--rg",
                    "15",
                    "--online",
                    "--refresh",
                    "--api-key",
                    "k",
                    "--json",
                ],
            )
            self.assertEqual(r3.exit_code, 0, r3.output)
            self.assertEqual(len(api_calls), 2)
            self.assertEqual(json.loads(r3.output)["results"][0]["naId"], "1002")

            # --cache-ttl-hours 0 bypasses query cache.
            r4 = runner.invoke(
                nara.cli,
                [
                    "search",
                    "Harriet Tubman",
                    "--rg",
                    "15",
                    "--online",
                    "--cache-ttl-hours",
                    "0",
                    "--api-key",
                    "k",
                    "--json",
                ],
            )
            self.assertEqual(r4.exit_code, 0, r4.output)
            self.assertEqual(len(api_calls), 3)
            self.assertEqual(json.loads(r4.output)["results"][0]["naId"], "1003")

    def test_naid_and_filename_path_safety(self) -> None:
        runner = CliRunner()
        for bad_naid in ("../etc/passwd", "123/456", "123\\456", "not-a-number"):
            res = runner.invoke(nara.cli, ["get", bad_naid, "--api-key", "k"])
            self.assertNotEqual(res.exit_code, 0)

        self.assertEqual(nara.safe_object_filename(5, "../../evil.jpg"), "005_evil.jpg")
        self.assertEqual(nara.safe_object_filename(5, "..\\win\\scan.tif"), "005_scan.tif")
        self.assertEqual(nara.safe_object_filename(5, ".."), "005_5.bin")
        self.assertEqual(nara.safe_object_filename(5, ".hidden"), "005_hidden")

        for unsafe in ("../escape", "a/b.jpg", "a\\b.jpg", "..", "", "C:evil"):
            with self.assertRaises(ValueError):
                nara.resolve_safe_child(self.cache_root, unsafe)


if __name__ == "__main__":
    unittest.main()
