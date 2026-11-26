from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
import os
from pathlib import Path
import tempfile
import threading
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
        def overlapping_api(expected_inflight: int):
            lock = threading.Lock()
            state = {"current": 0, "peak": 0}
            release = threading.Event()

            def fake(url: str, _api_key: str, *, client: httpx.Client | None = None):
                with lock:
                    state["current"] += 1
                    state["peak"] = max(state["peak"], state["current"])
                    if state["current"] >= expected_inflight:
                        release.set()
                if not release.wait(5):
                    raise AssertionError(
                        f"catalog calls did not overlap (peak {state['peak']} of {expected_inflight})"
                    )
                with lock:
                    state["current"] -= 1
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

            return fake, state

        search_fake, search_state = overlapping_api(3)
        get_fake, get_state = overlapping_api(3)
        runner = CliRunner()
        with patch.object(nara, "_api_get_json", side_effect=search_fake):
            res_search = runner.invoke(
                nara.cli,
                ["search", "Harriet", "Clara", "Frederick", "--api-key", "test-key", "--json"],
            )
        with patch.object(nara, "_api_get_json", side_effect=get_fake):
            res_get = runner.invoke(
                nara.cli,
                ["get", "300398", "300357", "595367", "--api-key", "test-key", "--json"],
            )

        self.assertEqual(res_search.exit_code, 0, res_search.output)
        self.assertEqual(res_get.exit_code, 0, res_get.output)
        self.assertEqual(search_state["peak"], 3)
        self.assertEqual(get_state["peak"], 3)
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

            # Second identical call -> ZERO HTTP requests and cache_hit: True.
            r2 = runner.invoke(
                nara.cli,
                ["search", "Harriet Tubman", "--rg", "15", "--online", "--api-key", "k", "--json"],
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(api_calls), 1)
            p1 = json.loads(r1.output)
            p2 = json.loads(r2.output)
            self.assertIs(p1["cache_hit"], False)
            self.assertIs(p2["cache_hit"], True)
            self.assertEqual(
                {k: v for k, v in p2.items() if k != "cache_hit"},
                {k: v for k, v in p1.items() if k != "cache_hit"},
            )

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
            p3 = json.loads(r3.output)
            self.assertIs(p3["cache_hit"], False)
            self.assertEqual(p3["results"][0]["naId"], "1002")

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
            p4 = json.loads(r4.output)
            self.assertIs(p4["cache_hit"], False)
            self.assertEqual(p4["results"][0]["naId"], "1003")

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


class TestCensus1950Cache(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-nara-census1950-")
        self.cache_root = Path(self._tmp.name)
        self._env_patch = patch.dict(
            os.environ, {"KINLOOM_NARA_CACHE_DIR": str(self.cache_root)}
        )
        self._env_patch.start()
        self.urls: list[str] = []
        self.payload = {
            "total": 1,
            "size": 25,
            "page": 1,
            "results": [
                {
                    "scheduleId": "1001",
                    "state": "Illinois",
                    "abbr": "IL",
                    "county": "Sangamon",
                    "reservation": None,
                    "ed": "84-1",
                    "names": [{"row": 1, "name": "Lincoln Smith"}],
                    "image": "https://1950census.archives.gov/example.jpg",
                    "maps": "1",
                    "transcribe": [],
                    "highlight": {"transcribe.name": "Lincoln"},
                    "iiifUrl": "https://1950census.archives.gov/iiif/example",
                }
            ],
        }

        def fake_fetch(url: str) -> dict:
            self.urls.append(url)
            return json.loads(json.dumps(self.payload))

        self._fetch = patch.object(nara, "_census1950_fetch_json", side_effect=fake_fetch)
        self._fetch.start()

    def tearDown(self) -> None:
        self._fetch.stop()
        self._env_patch.stop()
        self._tmp.cleanup()

    def test_repeat_search_hits_disk_and_refresh_bypasses(self) -> None:
        runner = CliRunner()
        args = ["census1950", "--state", "Illinois", "--name", "Lincoln", "--json"]
        first = runner.invoke(nara.cli, args)
        self.assertEqual(first.exit_code, 0, first.output)
        first_body = json.loads(first.output)
        self.assertFalse(first_body["cache_hit"])
        self.assertEqual(first_body["results"][0]["names"][0]["name"], "Lincoln Smith")
        self.assertEqual(first_body["results"][0]["scheduleId"], "1001")
        self.assertEqual(len(self.urls), 1)
        self.assertIn("state=IL", self.urls[0])
        self.assertIn("name=Lincoln", self.urls[0])
        self.assertIn("size=25", self.urls[0])
        self.assertTrue(self.urls[0].startswith("https://1950census.archives.gov/api/search?"))
        cached_files = list((self.cache_root / "census1950").glob("*.json"))
        self.assertEqual(len(cached_files), 1)
        self.assertEqual(len(cached_files[0].stem), 64)

        second = runner.invoke(nara.cli, args)
        self.assertEqual(second.exit_code, 0, second.output)
        second_body = json.loads(second.output)
        self.assertTrue(second_body["cache_hit"])
        self.assertEqual(second_body["results"], first_body["results"])
        self.assertEqual(len(self.urls), 1)

        refreshed = runner.invoke(nara.cli, [*args, "--refresh"])
        self.assertEqual(refreshed.exit_code, 0, refreshed.output)
        self.assertFalse(json.loads(refreshed.output)["cache_hit"])
        self.assertEqual(json.loads(refreshed.output)["results"][0]["scheduleId"], "1001")
        self.assertEqual(len(self.urls), 2)

        expired = runner.invoke(nara.cli, [*args, "--cache-ttl-hours", "0"])
        self.assertEqual(expired.exit_code, 0, expired.output)
        self.assertFalse(json.loads(expired.output)["cache_hit"])
        self.assertEqual(len(self.urls), 3)

    def test_missing_filters_and_bad_state_make_no_request(self) -> None:
        runner = CliRunner()
        missing = runner.invoke(nara.cli, ["census1950", "--json"])
        self.assertEqual(missing.exit_code, 2, missing.output)
        bad_state = runner.invoke(nara.cli, ["census1950", "--state", "Atlantis", "--json"])
        self.assertNotEqual(bad_state.exit_code, 0, bad_state.output)
        traversal = runner.invoke(
            nara.cli, ["census1950", "--state", "IL", "--county", "../secret", "--json"]
        )
        self.assertNotEqual(traversal.exit_code, 0, traversal.output)
        self.assertEqual(self.urls, [])
        self.assertEqual(list(self.cache_root.rglob("*.json")), [])

    def test_page_selects_api_page_and_keeps_page_one_cache_key(self) -> None:
        runner = CliRunner()
        base = ["census1950", "--state", "IL", "--name", "Lincoln", "--json"]
        first = runner.invoke(nara.cli, base)
        self.assertEqual(first.exit_code, 0, first.output)
        self.assertIn("page=1", self.urls[0])
        page_one_files = list((self.cache_root / "census1950").glob("*.json"))
        self.assertEqual(len(page_one_files), 1)
        page_one_name = page_one_files[0].name

        explicit = runner.invoke(nara.cli, [*base, "--page", "1"])
        self.assertEqual(explicit.exit_code, 0, explicit.output)
        self.assertTrue(json.loads(explicit.output)["cache_hit"])
        self.assertEqual(len(self.urls), 1)
        self.assertEqual(
            [path.name for path in (self.cache_root / "census1950").glob("*.json")],
            [page_one_name],
        )

        self.payload["page"] = 2
        self.payload["results"][0]["scheduleId"] = "2002"
        second = runner.invoke(nara.cli, [*base, "--page", "2"])
        self.assertEqual(second.exit_code, 0, second.output)
        body = json.loads(second.output)
        self.assertFalse(body["cache_hit"])
        self.assertEqual(body["results"][0]["scheduleId"], "2002")
        self.assertEqual(len(self.urls), 2)
        self.assertIn("page=2", self.urls[1])
        self.assertNotIn("page=1", self.urls[1])
        cached_names = sorted(path.name for path in (self.cache_root / "census1950").glob("*.json"))
        self.assertEqual(len(cached_names), 2)
        self.assertIn(page_one_name, cached_names)

        rejected = runner.invoke(nara.cli, [*base, "--page", "0"])
        self.assertNotEqual(rejected.exit_code, 0, rejected.output)
        self.assertIn("must be >= 1", rejected.output)
        self.assertEqual(len(self.urls), 2)

    def test_text_line_includes_image_and_json_stays_the_api_row(self) -> None:
        image = (
            "1950census/43290879-Illinois/43290879-Illinois-087558/"
            "43290879-Illinois-087558-0002.jpg"
        )
        self.payload["results"][0]["image"] = image
        runner = CliRunner()
        text = runner.invoke(nara.cli, ["census1950", "--state", "IL", "--name", "Lincoln"])
        self.assertEqual(text.exit_code, 0, text.output)
        self.assertIn(f"image {image}", text.output)
        as_json = runner.invoke(
            nara.cli, ["census1950", "--state", "IL", "--name", "Lincoln", "--json"]
        )
        self.assertEqual(as_json.exit_code, 0, as_json.output)
        body = json.loads(as_json.output)
        self.assertEqual(
            set(body),
            {"cache_hit", "total", "page", "size", "results"},
        )
        self.assertEqual(body["results"][0], self.payload["results"][0])
        self.assertTrue(body["cache_hit"])
        self.assertEqual(len(self.urls), 1)


LINCOLN_ED_IMAGE = (
    "1950census/43290879-Illinois/43290879-Illinois-087558/"
    "43290879-Illinois-087558-0002.jpg"
)
LINCOLN_ED_INFO = (
    "https://1950census.archives.gov/iiif/2/"
    "1950census%2F43290879-Illinois%2F43290879-Illinois-087558%2F"
    "43290879-Illinois-087558-0002.jpg/info.json"
)
JPEG_FULL = b"\xff\xd8\xff\xd9full-schedule"
JPEG_PREVIEW = b"\xff\xd8\xff\xd9width-preview"
JPEG_REFRESHED = b"\xff\xd8\xff\xd9refreshed-schedule"


class TestCensus1950Image(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-nara-census1950-image-")
        self.cache_root = Path(self._tmp.name)
        self.out_dir = self.cache_root / "out"
        self.out_dir.mkdir()
        self._env_patch = patch.dict(
            os.environ, {"KINLOOM_NARA_CACHE_DIR": str(self.cache_root)}
        )
        self._env_patch.start()
        self.urls: list[str] = []
        self.bodies = {
            "full": JPEG_FULL,
            "2400": JPEG_PREVIEW,
        }

        def fake_fetch(url: str, *, client: httpx.Client | None = None) -> bytes:
            del client
            self.urls.append(url)
            if "/full/2400,/0/default.jpg" in url:
                return self.bodies["2400"]
            if "/full/full/0/default.jpg" in url:
                return self.bodies["full"]
            raise AssertionError(f"unexpected image url: {url}")

        self._fetch = patch.object(nara, "_census1950_fetch_jpeg", side_effect=fake_fetch)
        self._fetch.start()

    def tearDown(self) -> None:
        self._fetch.stop()
        self._env_patch.stop()
        self._tmp.cleanup()

    def _cached_jpegs(self) -> list[Path]:
        directory = self.cache_root / "census1950-images"
        if not directory.is_dir():
            return []
        return sorted(path for path in directory.glob("*.jpg") if path.is_file())

    def test_image_path_miss_then_hit_makes_one_request(self) -> None:
        runner = CliRunner()
        args = [
            "census1950-image",
            LINCOLN_ED_IMAGE,
            "--out",
            str(self.out_dir),
            "--json",
        ]
        first = runner.invoke(nara.cli, args)
        self.assertEqual(first.exit_code, 0, first.output)
        first_body = json.loads(first.output)
        dest = self.out_dir / "43290879-Illinois-087558-0002.jpg"
        self.assertFalse(first_body["cache_hit"])
        self.assertEqual(first_body["image"], LINCOLN_ED_IMAGE)
        self.assertIsNone(first_body["width"])
        self.assertEqual(first_body["bytes"], len(JPEG_FULL))
        self.assertEqual(first_body["path"], str(dest))
        self.assertEqual(
            first_body["url"],
            "https://1950census.archives.gov/iiif/2/"
            "1950census%2F43290879-Illinois%2F43290879-Illinois-087558%2F"
            "43290879-Illinois-087558-0002.jpg/full/full/0/default.jpg",
        )
        self.assertEqual(dest.read_bytes(), JPEG_FULL)
        self.assertEqual(len(self.urls), 1)
        self.assertEqual(len(self._cached_jpegs()), 1)
        self.assertEqual(self._cached_jpegs()[0].read_bytes(), JPEG_FULL)

        second = runner.invoke(nara.cli, args)
        self.assertEqual(second.exit_code, 0, second.output)
        second_body = json.loads(second.output)
        self.assertTrue(second_body["cache_hit"])
        self.assertEqual(second_body["bytes"], len(JPEG_FULL))
        self.assertEqual(dest.read_bytes(), JPEG_FULL)
        self.assertEqual(len(self.urls), 1)

    def test_info_json_url_uses_the_same_cache_entry_as_the_image_path(self) -> None:
        runner = CliRunner()
        by_path = runner.invoke(
            nara.cli,
            ["census1950-image", LINCOLN_ED_IMAGE, "--out", str(self.out_dir), "--json"],
        )
        self.assertEqual(by_path.exit_code, 0, by_path.output)
        by_url = runner.invoke(
            nara.cli,
            ["census1950-image", LINCOLN_ED_INFO, "--out", str(self.out_dir), "--json"],
        )
        self.assertEqual(by_url.exit_code, 0, by_url.output)
        body = json.loads(by_url.output)
        self.assertTrue(body["cache_hit"])
        self.assertEqual(body["image"], LINCOLN_ED_IMAGE)
        self.assertEqual(json.loads(by_path.output)["url"], body["url"])
        self.assertEqual(len(self.urls), 1)
        self.assertEqual(len(self._cached_jpegs()), 1)

    def test_width_selects_iiif_size_and_a_distinct_cache_file(self) -> None:
        runner = CliRunner()
        full = runner.invoke(
            nara.cli,
            ["census1950-image", LINCOLN_ED_IMAGE, "--out", str(self.out_dir), "--json"],
        )
        self.assertEqual(full.exit_code, 0, full.output)
        preview_path = self.out_dir / "preview.jpg"
        preview = runner.invoke(
            nara.cli,
            [
                "census1950-image",
                LINCOLN_ED_IMAGE,
                "--width",
                "2400",
                "--out",
                str(preview_path),
                "--json",
            ],
        )
        self.assertEqual(preview.exit_code, 0, preview.output)
        body = json.loads(preview.output)
        self.assertFalse(body["cache_hit"])
        self.assertEqual(body["width"], 2400)
        self.assertEqual(body["bytes"], len(JPEG_PREVIEW))
        self.assertEqual(body["path"], str(preview_path))
        self.assertIn("/full/2400,/0/default.jpg", body["url"])
        self.assertEqual(self.urls[1], body["url"])
        self.assertEqual(preview_path.read_bytes(), JPEG_PREVIEW)
        cached = self._cached_jpegs()
        self.assertEqual(len(cached), 2)
        self.assertEqual({path.read_bytes() for path in cached}, {JPEG_FULL, JPEG_PREVIEW})

        again = runner.invoke(
            nara.cli,
            [
                "census1950-image",
                LINCOLN_ED_IMAGE,
                "--width",
                "2400",
                "--out",
                str(preview_path),
                "--json",
            ],
        )
        self.assertTrue(json.loads(again.output)["cache_hit"])
        self.assertEqual(len(self.urls), 2)

    def test_refresh_replaces_the_cached_jpeg(self) -> None:
        runner = CliRunner()
        args = [
            "census1950-image",
            LINCOLN_ED_IMAGE,
            "--out",
            str(self.out_dir / "page.jpg"),
            "--json",
        ]
        first = runner.invoke(nara.cli, args)
        self.assertEqual(first.exit_code, 0, first.output)
        self.assertFalse(json.loads(first.output)["cache_hit"])
        self.bodies["full"] = JPEG_REFRESHED
        refreshed = runner.invoke(nara.cli, [*args, "--refresh"])
        self.assertEqual(refreshed.exit_code, 0, refreshed.output)
        body = json.loads(refreshed.output)
        self.assertFalse(body["cache_hit"])
        self.assertEqual(body["bytes"], len(JPEG_REFRESHED))
        self.assertEqual((self.out_dir / "page.jpg").read_bytes(), JPEG_REFRESHED)
        self.assertEqual(self._cached_jpegs()[0].read_bytes(), JPEG_REFRESHED)
        self.assertEqual(len(self.urls), 2)
        self.assertEqual(len(self._cached_jpegs()), 1)

        skipped = runner.invoke(nara.cli, [*args, "--cache-ttl-hours", "0"])
        self.assertFalse(json.loads(skipped.output)["cache_hit"])
        self.assertEqual(len(self.urls), 3)

    def test_rejects_traversal_and_other_hosts_without_a_request(self) -> None:
        runner = CliRunner()
        rejected = [
            "1950census/../secret.jpg",
            "1950census/ed/../../secret.jpg",
            "https://evil.example/iiif/2/1950census%2Fpage.jpg/info.json",
            "http://1950census.archives.gov/iiif/2/1950census%2Fpage.jpg/info.json",
            "https://user@1950census.archives.gov/iiif/2/1950census%2Fpage.jpg/info.json",
            (
                "https://1950census.archives.gov/iiif/2/"
                "1950census%2F..%2Fsecret.jpg/info.json"
            ),
            "https://1950census.archives.gov/not-iiif/page.jpg",
        ]
        for raw in rejected:
            result = runner.invoke(
                nara.cli,
                ["census1950-image", raw, "--out", str(self.out_dir), "--json"],
            )
            self.assertNotEqual(result.exit_code, 0, raw)
        self.assertEqual(self.urls, [])
        self.assertEqual(self._cached_jpegs(), [])
        width = runner.invoke(
            nara.cli,
            ["census1950-image", LINCOLN_ED_IMAGE, "--width", "0", "--json"],
        )
        self.assertNotEqual(width.exit_code, 0, width.output)
        self.assertEqual(self.urls, [])

    def test_html_and_non_jpeg_payloads_are_not_cached(self) -> None:
        runner = CliRunner()
        html = runner.invoke(
            nara.cli,
            ["census1950-image", LINCOLN_ED_IMAGE, "--out", str(self.out_dir), "--json"],
        )
        self.assertEqual(html.exit_code, 0, html.output)

        def bad_fetch(url: str, *, client: httpx.Client | None = None) -> bytes:
            del client
            self.urls.append(url)
            if url.endswith("/full/800,/0/default.jpg"):
                return b"GIF89a-not-a-jpeg"
            return b"<html><body>error page</body></html>"

        with patch.object(nara, "_census1950_fetch_jpeg", side_effect=bad_fetch):
            html_result = runner.invoke(
                nara.cli,
                [
                    "census1950-image",
                    LINCOLN_ED_IMAGE,
                    "--width",
                    "400",
                    "--refresh",
                    "--out",
                    str(self.out_dir / "bad.jpg"),
                    "--json",
                ],
            )
            gif_result = runner.invoke(
                nara.cli,
                [
                    "census1950-image",
                    LINCOLN_ED_IMAGE,
                    "--width",
                    "800",
                    "--out",
                    str(self.out_dir / "gif.jpg"),
                    "--json",
                ],
            )
        self.assertNotEqual(html_result.exit_code, 0, html_result.output)
        self.assertNotEqual(gif_result.exit_code, 0, gif_result.output)
        self.assertIn("not a JPEG", html_result.output)
        self.assertIn("not a JPEG", gif_result.output)
        self.assertFalse((self.out_dir / "bad.jpg").exists())
        self.assertFalse((self.out_dir / "gif.jpg").exists())
        cached = self._cached_jpegs()
        self.assertEqual(len(cached), 1)
        self.assertEqual(cached[0].read_bytes(), JPEG_FULL)
        for path in self.cache_root.rglob("*"):
            if path.is_file() and path.suffix != ".lock":
                self.assertFalse(path.read_bytes().startswith(b"<html"))
                self.assertFalse(path.read_bytes().startswith(b"GIF89a"))

    def test_fetch_jpeg_rejects_html_and_http_errors(self) -> None:
        self._fetch.stop()
        try:
            def handler(request: httpx.Request) -> httpx.Response:
                if request.url.path.endswith("/missing.jpg"):
                    return httpx.Response(404, text="missing")
                return httpx.Response(
                    200,
                    headers={"content-type": "text/html; charset=utf-8"},
                    text="<!doctype html><title>blocked</title>",
                )

            with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                with self.assertRaises(nara.click.ClickException) as caught:
                    nara._census1950_fetch_jpeg(
                        "https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg",
                        client=client,
                    )
                self.assertIn("not a JPEG", str(caught.exception))
                with self.assertRaises(httpx.HTTPStatusError):
                    nara._census1950_fetch_jpeg(
                        "https://1950census.archives.gov/iiif/2/missing.jpg",
                        client=client,
                    )
        finally:
            self._fetch.start()

    def test_transient_503_retries_then_returns_jpeg(self) -> None:
        self._fetch.stop()
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            del request
            calls += 1
            if calls == 1:
                return httpx.Response(503, headers={"Retry-After": "12"}, text="busy")
            return httpx.Response(
                200,
                headers={"content-type": "image/jpeg"},
                content=JPEG_FULL,
            )

        try:
            with (
                patch.object(nara.time, "sleep") as slept,
                httpx.Client(transport=httpx.MockTransport(handler)) as client,
            ):
                data = nara._census1950_fetch_jpeg(
                    "https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg",
                    client=client,
                )
            self.assertEqual(data, JPEG_FULL)
            self.assertEqual(calls, 2)
            slept.assert_called_once_with(5.0)
        finally:
            self._fetch.start()

    def test_timeout_retries_then_returns_jpeg(self) -> None:
        self._fetch.stop()
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise httpx.ReadTimeout("slow", request=request)
            return httpx.Response(
                200,
                headers={"content-type": "image/jpeg"},
                content=JPEG_PREVIEW,
            )

        try:
            with (
                patch.object(nara.time, "sleep") as slept,
                httpx.Client(transport=httpx.MockTransport(handler)) as client,
            ):
                data = nara._census1950_fetch_jpeg(
                    "https://1950census.archives.gov/iiif/2/x/full/2400,/0/default.jpg",
                    client=client,
                )
            self.assertEqual(data, JPEG_PREVIEW)
            self.assertEqual(calls, 2)
            slept.assert_called_once_with(0.25)
        finally:
            self._fetch.start()

    def test_permanent_4xx_and_exhausted_503_do_not_keep_retrying(self) -> None:
        self._fetch.stop()
        try:
            for status in (400, 403, 404):
                calls = 0

                def handler(request: httpx.Request, status: int = status) -> httpx.Response:
                    nonlocal calls
                    del request
                    calls += 1
                    return httpx.Response(status, text="no")

                with (
                    patch.object(nara.time, "sleep") as slept,
                    httpx.Client(transport=httpx.MockTransport(handler)) as client,
                ):
                    with self.assertRaises(httpx.HTTPStatusError):
                        nara._census1950_fetch_jpeg(
                            "https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg",
                            client=client,
                        )
                self.assertEqual(calls, 1, status)
                slept.assert_not_called()

            exhausted = 0

            def always_503(request: httpx.Request) -> httpx.Response:
                nonlocal exhausted
                del request
                exhausted += 1
                return httpx.Response(503, text="busy")

            with (
                patch.object(nara.time, "sleep") as slept,
                httpx.Client(transport=httpx.MockTransport(always_503)) as client,
            ):
                with self.assertRaises(httpx.HTTPStatusError) as caught:
                    nara._census1950_fetch_jpeg(
                        "https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg",
                        client=client,
                    )
            self.assertEqual(caught.exception.response.status_code, 503)
            self.assertEqual(exhausted, 3)
            self.assertEqual(slept.call_count, 2)
            self.assertEqual(
                [call.args[0] for call in slept.call_args_list],
                [0.25, 0.5],
            )
        finally:
            self._fetch.start()

    def test_failed_fetch_does_not_write_cache_or_output(self) -> None:
        def boom(url: str, *, client: httpx.Client | None = None) -> bytes:
            del client
            request = httpx.Request("GET", url)
            response = httpx.Response(404, request=request, text="missing")
            raise httpx.HTTPStatusError("missing", request=request, response=response)

        with patch.object(nara, "_census1950_fetch_jpeg", side_effect=boom):
            result = CliRunner().invoke(
                nara.cli,
                ["census1950-image", LINCOLN_ED_IMAGE, "--out", str(self.out_dir), "--json"],
            )
        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(self._cached_jpegs(), [])
        self.assertFalse((self.out_dir / "43290879-Illinois-087558-0002.jpg").exists())

    def test_batch_rejects_jpg_out_and_bad_paths_before_download(self) -> None:
        runner = CliRunner()
        jpg_out = self.out_dir / "batch.jpg"
        rejected = runner.invoke(
            nara.cli,
            [
                "census1950-image",
                LINCOLN_ED_IMAGE,
                _census_sheet(3),
                "--out",
                str(jpg_out),
                "--json",
            ],
        )
        self.assertNotEqual(rejected.exit_code, 0, rejected.output)
        self.assertIn("directory", rejected.output.lower())
        self.assertFalse(jpg_out.exists())
        self.assertEqual(self.urls, [])
        self.assertEqual(self._cached_jpegs(), [])

        invalid = runner.invoke(
            nara.cli,
            [
                "census1950-image",
                LINCOLN_ED_IMAGE,
                "1950census/../secret.jpg",
                "--out",
                str(self.out_dir),
                "--json",
            ],
        )
        self.assertNotEqual(invalid.exit_code, 0, invalid.output)
        self.assertEqual(self.urls, [])

        too_many = runner.invoke(
            nara.cli,
            [
                "census1950-image",
                *[_census_sheet(index) for index in range(1, 27)],
                "--out",
                str(self.out_dir),
            ],
        )
        self.assertNotEqual(too_many.exit_code, 0, too_many.output)
        self.assertIn("25", too_many.output)
        self.assertEqual(self.urls, [])
        self.assertEqual(self._cached_jpegs(), [])

    def test_batch_downloads_overlap_keep_order_and_then_hit_cache(self) -> None:
        self._fetch.stop()
        slow = _census_sheet(4)
        fast = _census_sheet(3)
        slow_bytes = b"\xff\xd8\xff\xd9sheet-0004"
        fast_bytes = b"\xff\xd8\xff\xd9sheet-0003"
        barrier = threading.Barrier(2)
        fast_recorded = threading.Event()
        order: list[str] = []
        lock = threading.Lock()
        slow_name = slow.rsplit("/", 1)[-1]
        fast_name = fast.rsplit("/", 1)[-1]

        def fake_fetch(url: str, *, client: httpx.Client | None = None) -> bytes:
            del client
            barrier.wait(timeout=5)
            if slow_name in url:
                if not fast_recorded.wait(timeout=5):
                    raise AssertionError("sheet downloads did not overlap")
                body = slow_bytes
            elif fast_name in url:
                body = fast_bytes
            else:
                raise AssertionError(url)
            with lock:
                order.append(url)
            if fast_name in url:
                fast_recorded.set()
            return body

        try:
            with patch.object(nara, "_census1950_fetch_jpeg", side_effect=fake_fetch):
                runner = CliRunner()
                args = [
                    "census1950-image",
                    slow,
                    fast,
                    "--out",
                    str(self.out_dir),
                    "--json",
                ]
                first = runner.invoke(nara.cli, args)
                self.assertEqual(first.exit_code, 0, first.output)
                body = json.loads(first.output)
                self.assertEqual(body["count"], 2)
                self.assertFalse(body["cache_hit"])
                self.assertEqual([item["image"] for item in body["files"]], [slow, fast])
                self.assertEqual([item["cache_hit"] for item in body["files"]], [False, False])
                self.assertEqual(body["files"][0]["bytes"], len(slow_bytes))
                self.assertEqual(body["files"][1]["bytes"], len(fast_bytes))
                self.assertEqual((self.out_dir / slow.rsplit("/", 1)[-1]).read_bytes(), slow_bytes)
                self.assertEqual((self.out_dir / fast.rsplit("/", 1)[-1]).read_bytes(), fast_bytes)
                self.assertIn("0003", order[0])
                self.assertIn("0004", order[1])

                second = runner.invoke(nara.cli, args)
                self.assertEqual(second.exit_code, 0, second.output)
                again = json.loads(second.output)
                self.assertTrue(again["cache_hit"])
                self.assertEqual([item["cache_hit"] for item in again["files"]], [True, True])
                self.assertEqual([item["image"] for item in again["files"]], [slow, fast])
                self.assertEqual(len(order), 2)
        finally:
            self._fetch.start()

    def test_batch_cache_hit_is_false_when_any_sheet_is_downloaded(self) -> None:
        runner = CliRunner()
        cached_sheet = _census_sheet(3)
        fresh_sheet = _census_sheet(5)
        first = runner.invoke(
            nara.cli,
            ["census1950-image", cached_sheet, "--out", str(self.out_dir), "--json"],
        )
        self.assertEqual(first.exit_code, 0, first.output)
        self.assertFalse(json.loads(first.output)["cache_hit"])
        mixed = runner.invoke(
            nara.cli,
            [
                "census1950-image",
                fresh_sheet,
                cached_sheet,
                "--out",
                str(self.out_dir),
                "--json",
            ],
        )
        self.assertEqual(mixed.exit_code, 0, mixed.output)
        body = json.loads(mixed.output)
        self.assertEqual(body["count"], 2)
        self.assertFalse(body["cache_hit"])
        self.assertEqual([item["image"] for item in body["files"]], [fresh_sheet, cached_sheet])
        self.assertEqual([item["cache_hit"] for item in body["files"]], [False, True])
        self.assertEqual(len(self.urls), 2)


def _census_sheet(index: int) -> str:
    return (
        "1950census/43290879-Illinois/43290879-Illinois-087558/"
        f"43290879-Illinois-087558-{index:04d}.jpg"
    )


class TestNaraDownloadHardeningAndTelemetry(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-nara-hardening-")
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

    def test_get_emits_boolean_cache_hit_in_json_mode(self) -> None:
        api_calls: list[str] = []

        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            del client
            api_calls.append(url)
            return TestNaraDiskCaching._sample_record_response("595367", "Census Roll", page_count=2)

        runner = CliRunner()
        with patch.object(nara, "_api_get_json", side_effect=fake_api_get_json):
            r1 = runner.invoke(nara.cli, ["get", "595367", "--api-key", "k", "--json"])
            r2 = runner.invoke(nara.cli, ["get", "595367", "--api-key", "k", "--json"])
            r3 = runner.invoke(nara.cli, ["get", "595367", "--refresh", "--api-key", "k", "--json"])

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(len(api_calls), 2)
        self.assertIs(json.loads(r1.output)["cache_hit"], False)
        self.assertIs(json.loads(r2.output)["cache_hit"], True)
        self.assertIs(json.loads(r3.output)["cache_hit"], False)

    def test_direct_url_download_caches_atomically_emits_json_and_honors_refresh(self) -> None:
        url = "https://s3.amazonaws.com/NARAprodstorage/opastorage/live/12/34/sheet_001.jpg"
        calls: list[str] = []
        version = {"v": 1}

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            body = b"\xff\xd8\xff\xe0" + f"scan-v{version['v']}".encode()
            return httpx.Response(
                200,
                headers={"content-type": "image/jpeg", "content-length": str(len(body))},
                content=body,
            )

        def fake_client() -> httpx.Client:
            return httpx.Client(transport=httpx.MockTransport(handler))

        out1 = self.work_dir / "first.jpg"
        out2 = self.work_dir / "second.jpg"
        out3 = self.work_dir / "third.jpg"
        runner = CliRunner()

        with patch.object(nara, "_new_download_client", side_effect=fake_client):
            r1 = runner.invoke(nara.cli, ["download", url, "--out", str(out1), "--json"])
            self.assertEqual(r1.exit_code, 0, r1.output)
            p1 = json.loads(r1.output)
            self.assertIs(p1["cache_hit"], False)
            self.assertEqual(p1["url"], url)
            self.assertEqual(p1["path"], str(out1))
            self.assertEqual(p1["content_type"], "image/jpeg")
            self.assertEqual(p1["bytes"], len(b"\xff\xd8\xff\xe0scan-v1"))
            self.assertEqual(out1.read_bytes(), b"\xff\xd8\xff\xe0scan-v1")
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(list((self.cache_root / "downloads").glob("*.bin"))), 1)

            r2 = runner.invoke(nara.cli, ["download", url, "--out", str(out2), "--json"])
            self.assertEqual(r2.exit_code, 0, r2.output)
            p2 = json.loads(r2.output)
            self.assertIs(p2["cache_hit"], True)
            self.assertEqual(p2["content_type"], "image/jpeg")
            self.assertEqual(p2["bytes"], len(b"\xff\xd8\xff\xe0scan-v1"))
            self.assertEqual(out2.read_bytes(), b"\xff\xd8\xff\xe0scan-v1")
            self.assertEqual(len(calls), 1)

            version["v"] = 2
            r3 = runner.invoke(nara.cli, ["download", url, "--out", str(out3), "--refresh", "--json"])
            self.assertEqual(r3.exit_code, 0, r3.output)
            p3 = json.loads(r3.output)
            self.assertIs(p3["cache_hit"], False)
            self.assertEqual(out3.read_bytes(), b"\xff\xd8\xff\xe0scan-v2")
            self.assertEqual(len(calls), 2)

    def test_naid_download_json_reports_cache_hit_and_accepts_catalog_url(self) -> None:
        meta_calls: list[str] = []
        obj_calls: list[str] = []

        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            del client
            meta_calls.append(url)
            return TestNaraDiskCaching._sample_record_response("595367", "Census Roll", page_count=2)

        def handler(request: httpx.Request) -> httpx.Response:
            obj_calls.append(str(request.url))
            return httpx.Response(
                200,
                headers={"content-type": "image/jpeg"},
                content=b"\xff\xd8\xff\xe0valid-jpeg",
            )

        out1 = self.work_dir / "naid1"
        out2 = self.work_dir / "naid2"
        runner = CliRunner()
        with (
            patch.object(nara, "_api_get_json", side_effect=fake_api_get_json),
            patch.object(
                nara,
                "_new_download_client",
                side_effect=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
            ),
        ):
            r1 = runner.invoke(
                nara.cli,
                ["download", "https://catalog.archives.gov/id/595367", "--pages", "1", "--out", str(out1), "--api-key", "k", "--json"],
            )
            self.assertEqual(r1.exit_code, 0, r1.output)
            p1 = json.loads(r1.output)
            self.assertEqual(p1["naId"], "595367")
            self.assertIs(p1["cache_hit"], False)
            self.assertIs(p1["metadata_cache_hit"], False)
            self.assertEqual(p1["content_type"], "image/jpeg")
            self.assertEqual(p1["count"], 1)
            self.assertIs(p1["files"][0]["cache_hit"], False)

            r2 = runner.invoke(
                nara.cli,
                ["download", "595367", "--pages", "1", "--out", str(out2), "--api-key", "k", "--json"],
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            p2 = json.loads(r2.output)
            self.assertIs(p2["cache_hit"], True)
            self.assertIs(p2["metadata_cache_hit"], True)
            self.assertIs(p2["files"][0]["cache_hit"], True)
            self.assertEqual(len(meta_calls), 1)
            self.assertEqual(len(obj_calls), 1)

    def test_download_retries_on_429_503_timeout_protocol_error_and_incomplete_body(self) -> None:
        url = "https://s3.amazonaws.com/NARAprodstorage/opastorage/live/retry.pdf"
        pdf_bytes = b"%PDF-1.4\nvalid-pdf-body"
        cases: list[tuple[str, list[object], list[float] | None]] = [
            (
                "429",
                [
                    httpx.Response(429, headers={"Retry-After": "4"}, text="slow down"),
                    httpx.Response(200, headers={"content-type": "application/pdf"}, content=pdf_bytes),
                ],
                [4.0],
            ),
            (
                "503",
                [
                    httpx.Response(503, text="busy"),
                    httpx.Response(200, headers={"content-type": "application/pdf"}, content=pdf_bytes),
                ],
                None,
            ),
            (
                "timeout",
                [
                    httpx.ReadTimeout("timed out"),
                    httpx.Response(200, headers={"content-type": "application/pdf"}, content=pdf_bytes),
                ],
                None,
            ),
            (
                "protocol",
                [
                    httpx.RemoteProtocolError("peer reset"),
                    httpx.Response(200, headers={"content-type": "application/pdf"}, content=pdf_bytes),
                ],
                None,
            ),
            (
                "incomplete",
                [
                    httpx.Response(
                        200,
                        headers={"content-type": "application/pdf", "content-length": "200"},
                        content=b"%PDF-1.4\ntrunc",
                    ),
                    httpx.Response(
                        200,
                        headers={"content-type": "application/pdf", "content-length": str(len(pdf_bytes))},
                        content=pdf_bytes,
                    ),
                ],
                None,
            ),
        ]

        for label, outcomes, expected_sleeps in cases:
            attempts = 0
            sleeps: list[float] = []

            def handler(request: httpx.Request, outcomes=outcomes) -> httpx.Response:
                nonlocal attempts
                item = outcomes[attempts]
                attempts += 1
                if isinstance(item, Exception):
                    item.request = request
                    raise item
                return item

            dest = self.work_dir / f"retry_{label}.pdf"
            with (
                patch.object(nara.time, "sleep", side_effect=sleeps.append),
                patch.object(
                    nara,
                    "_new_download_client",
                    side_effect=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
                ),
            ):
                res = CliRunner().invoke(
                    nara.cli, ["download", url, "--out", str(dest), "--refresh", "--json"]
                )
            self.assertEqual(res.exit_code, 0, f"{label}: {res.output}")
            self.assertEqual(attempts, 2, label)
            self.assertEqual(dest.read_bytes(), pdf_bytes, label)
            if expected_sleeps is not None:
                self.assertEqual(sleeps, expected_sleeps, label)
            else:
                self.assertEqual(len(sleeps), 1, label)

    def test_api_get_json_retries_transient_503_and_timeout(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(503, headers={"Retry-After": "2"}, text="unavailable")
            if attempts == 2:
                raise httpx.ReadTimeout("slow api", request=request)
            return httpx.Response(200, json={"body": {"hits": {"total": 1, "hits": []}}})

        sleeps: list[float] = []
        with (
            patch.object(nara.time, "sleep", side_effect=sleeps.append),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            data = nara._api_get_json(
                "https://catalog.archives.gov/api/v2/records/search?q=Lincoln",
                "k",
                client=client,
            )
        self.assertEqual(attempts, 3)
        self.assertEqual(sleeps[0], 2.0)
        self.assertEqual(data["body"]["hits"]["total"], 1)

    def test_download_refuses_html_error_pages_and_disallowed_hosts_and_traversal(self) -> None:
        runner = CliRunner()
        bad_urls = [
            "https://evil.example/NARAprodstorage/page.jpg",
            "http://s3.amazonaws.com/NARAprodstorage/page.jpg",
            "https://s3.amazonaws.com/unrelated-bucket/page.jpg",
            "https://user@catalog.archives.gov/file.pdf",
        ]
        for bad_url in bad_urls:
            res = runner.invoke(
                nara.cli, ["download", bad_url, "--out", str(self.work_dir / "x.jpg"), "--json"]
            )
            self.assertNotEqual(res.exit_code, 0, bad_url)
            self.assertFalse((self.work_dir / "x.jpg").exists())

        traversal = runner.invoke(
            nara.cli,
            [
                "download",
                "https://s3.amazonaws.com/NARAprodstorage/mock/page.jpg",
                "--out",
                "../escape.jpg",
                "--json",
            ],
        )
        self.assertNotEqual(traversal.exit_code, 0, traversal.output)

        def html_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<!doctype html><html><body>Access Denied</body></html>",
            )

        out_pdf = self.work_dir / "bad.pdf"
        out_jpg = self.work_dir / "bad.jpg"
        with patch.object(
            nara,
            "_new_download_client",
            side_effect=lambda: httpx.Client(transport=httpx.MockTransport(html_handler)),
        ):
            r_pdf = runner.invoke(
                nara.cli,
                [
                    "download",
                    "https://s3.amazonaws.com/NARAprodstorage/mock/doc.pdf",
                    "--out",
                    str(out_pdf),
                    "--json",
                ],
            )
            r_jpg = runner.invoke(
                nara.cli,
                [
                    "download",
                    "https://s3.amazonaws.com/NARAprodstorage/mock/scan.jpg",
                    "--out",
                    str(out_jpg),
                    "--json",
                ],
            )

        self.assertNotEqual(r_pdf.exit_code, 0, r_pdf.output)
        self.assertNotEqual(r_jpg.exit_code, 0, r_jpg.output)
        self.assertIn("HTML", r_pdf.output)
        self.assertIn("HTML", r_jpg.output)
        self.assertFalse(out_pdf.exists())
        self.assertFalse(out_jpg.exists())
        self.assertEqual(list((self.cache_root / "downloads").glob("*.bin")), [])


class TestCensus1950Wave38Reliability(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-nara-w38-")
        self.cache_root = Path(self._tmp.name) / "cache"
        self.out_dir = Path(self._tmp.name) / "out"
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self._env_patch = patch.dict(
            os.environ, {"KINLOOM_NARA_CACHE_DIR": str(self.cache_root)}
        )
        self._env_patch.start()

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmp.cleanup()

    def test_census1950_image_url_normalization_aliases_and_jpeg_output(self) -> None:
        encoded = (
            "1950census%2F43290879-Illinois%2F43290879-Illinois-087558%2F"
            "43290879-Illinois-087558-0002.jpg"
        )
        variants = [
            f"/{LINCOLN_ED_IMAGE}",
            encoded,
            f"https://1950census.archives.gov/iiif/2/{encoded}",
            f"https://1950census.archives.gov/iiif/2/{encoded}/",
            f"HTTPS://1950CENSUS.ARCHIVES.GOV/iiif/2/{encoded}/full/1200,/0/default.jpg",
            f"https://1950census.archives.gov/iiif/2/{LINCOLN_ED_IMAGE}/info.json",
        ]
        for raw in variants:
            self.assertEqual(nara.parse_census1950_image_source(raw), LINCOLN_ED_IMAGE, raw)

        calls: list[str] = []

        def fake_fetch(url: str, *, client: httpx.Client | None = None) -> bytes:
            del client
            calls.append(url)
            return JPEG_PREVIEW if "/full/1800,/0/default.jpg" in url else JPEG_FULL

        runner = CliRunner()
        with patch.object(nara, "_census1950_fetch_jpeg", side_effect=fake_fetch):
            r1 = runner.invoke(
                nara.cli,
                [
                    "census1950-image",
                    f"https://1950census.archives.gov/iiif/2/{encoded}",
                    "--out-dir",
                    str(self.out_dir),
                    "--max-width",
                    "1800",
                    "--timeout",
                    "20",
                    "--json",
                ],
            )
            self.assertEqual(r1.exit_code, 0, r1.output)
            p1 = json.loads(r1.output)
            self.assertFalse(p1["cache_hit"])
            self.assertEqual(p1["width"], 1800)
            self.assertEqual(p1["image"], LINCOLN_ED_IMAGE)
            self.assertEqual(len(calls), 1)

            # Second call with leading slash and .jpeg target reuses cache with zero HTTP calls.
            jpeg_dest = self.out_dir / "sheet.jpeg"
            r2 = runner.invoke(
                nara.cli,
                [
                    "census1950-image",
                    f"/{LINCOLN_ED_IMAGE}",
                    "-o",
                    str(jpeg_dest),
                    "--width",
                    "1800",
                    "--json",
                ],
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            p2 = json.loads(r2.output)
            self.assertTrue(p2["cache_hit"])
            self.assertEqual(p2["path"], str(jpeg_dest))
            self.assertTrue(jpeg_dest.is_file())
            self.assertEqual(jpeg_dest.read_bytes(), JPEG_PREVIEW)
            self.assertEqual(len(calls), 1)

            # Relative traversal in --out and non-positive --timeout fail before HTTP.
            bad_out = runner.invoke(
                nara.cli, ["census1950-image", LINCOLN_ED_IMAGE, "--out", "../escape.jpg"]
            )
            self.assertNotEqual(bad_out.exit_code, 0)
            bad_timeout = runner.invoke(
                nara.cli, ["census1950-image", LINCOLN_ED_IMAGE, "--timeout", "0"]
            )
            self.assertEqual(bad_timeout.exit_code, 2)
            self.assertEqual(len(calls), 1)

    def test_census1950_image_retries_522_truncated_stream_and_http_date_retry_after(self) -> None:
        from datetime import datetime, timedelta, timezone
        from email.utils import format_datetime

        future_date = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=2), usegmt=True)
        attempts = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(522, headers={"Retry-After": future_date}, text="origin timeout")
            if attempts == 2:
                return httpx.Response(
                    200,
                    headers={"content-type": "image/jpeg", "content-length": "500"},
                    content=JPEG_FULL[:8],
                )
            return httpx.Response(
                200,
                headers={"content-type": "image/jpeg", "content-length": str(len(JPEG_FULL))},
                content=JPEG_FULL,
            )

        sleeps: list[float] = []
        with (
            patch.object(nara.time, "sleep", side_effect=sleeps.append),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            body = nara._census1950_fetch_jpeg(
                "https://1950census.archives.gov/iiif/2/x/full/full/0/default.jpg",
                client=client,
            )
        self.assertEqual(body, JPEG_FULL)
        self.assertEqual(attempts, 3)
        self.assertEqual(len(sleeps), 2)
        self.assertTrue(0.0 <= sleeps[0] <= nara.CENSUS1950_RETRY_AFTER_CAP_S)
        self.assertEqual(sleeps[1], 0.5)

    def test_census1950_search_retries_transient_503_and_timeout(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(503, headers={"Retry-After": "1"}, text="busy")
            if attempts == 2:
                raise httpx.ReadTimeout("slow", request=request)
            return httpx.Response(
                200,
                json={"total": 1, "page": 1, "size": 25, "results": [{"scheduleId": "42"}]},
            )

        sleeps: list[float] = []
        with (
            patch.object(nara.time, "sleep", side_effect=sleeps.append),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            data = nara._census1950_fetch_json(
                "https://1950census.archives.gov/api/search?state=IL&name=Lincoln",
                client=client,
            )
        self.assertEqual(attempts, 3)
        self.assertEqual(sleeps[0], 1.0)
        self.assertEqual(data["results"][0]["scheduleId"], "42")

    def test_exit_broken_pipe_exits_zero(self) -> None:
        with self.assertRaises(SystemExit) as cm:
            nara._exit_broken_pipe()
        self.assertEqual(cm.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
