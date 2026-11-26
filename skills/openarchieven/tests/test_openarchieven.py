from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from click.testing import CliRunner
import httpx


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "openarchieven"


def load_module():
    loader = SourceFileLoader("openarchieven_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("openarchieven_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_OPENARCHIEVEN_CACHE_DIR"] = _TEST_CACHE.name

oa = load_module()
oa.MIN_INTERVAL_S = 0.0

SEARCH_PAYLOAD = {
    "response": {
        "number_found": 1,
        "docs": [
            {
                "archive_code": "bhi",
                "identifier": "11111111-2222-3333-4444-555555555555",
                "personname": "Jan Jansen",
                "relationtype": "Kind",
                "sourcetype": "BS Geboorte",
                "eventdate": {"year": 1853, "month": 3, "day": 30},
                "eventplace": ["Zundert"],
                "url": "https://www.openarchieven.nl/bhi:11111111-2222-3333-4444-555555555555",
            }
        ],
    }
}

SHOW_PAYLOAD = {
    "a2a_Source": {
        "a2a_SourceType": {"a2a_SourceType": "BS Geboorte"},
        "a2a_SourcePlace": {"a2a_Place": "Zundert"},
        "a2a_SourceReference": {"a2a_InstitutionName": "BHIC"},
    },
    "a2a_Event": {
        "a2a_EventType": "Geboorte",
        "a2a_EventDate": {"a2a_Year": "1853", "a2a_Month": "3", "a2a_Day": "30"},
        "a2a_EventPlace": {"a2a_Place": "Zundert"},
    },
    "a2a_Person": [
        {
            "pid": "Person:1",
            "a2a_PersonName": {
                "a2a_PersonNameFirstName": "Jan",
                "a2a_PersonNameLastName": "Jansen",
            },
        }
    ],
    "a2a_RelationEP": [{"a2a_PersonKeyRef": "Person:1", "a2a_RelationType": "Kind"}],
}


class TestOpenArchievenCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_OPENARCHIEVEN_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def test_search_caches_and_second_run_makes_zero_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        with patch.object(oa, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(oa.cli, ["search", "--name", "Jan Jansen", "--json"], env=self.env)
            r2 = self.runner.invoke(oa.cli, ["search", "--name", "Jan Jansen", "--json"], env=self.env)
            r3 = self.runner.invoke(oa.cli, ["search", "--name", "Jan Jansen"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 1)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertTrue(json.loads(r2.output)["cache_hit"])
        self.assertIn("[cache]", r3.output)

    def test_refresh_and_zero_ttl_bypass_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        with patch.object(oa, "_client", self._mock_client(handler)):
            self.runner.invoke(oa.cli, ["search", "--name", "Jan Jansen", "--json"], env=self.env)
            r_ref = self.runner.invoke(
                oa.cli, ["search", "--name", "Jan Jansen", "--refresh", "--json"], env=self.env
            )
            r_ttl = self.runner.invoke(
                oa.cli, ["search", "--name", "Jan Jansen", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(r_ref.output)["cache_hit"])
        self.assertFalse(json.loads(r_ttl.output)["cache_hit"])

    def test_show_caches_and_marks_text_hit(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=SHOW_PAYLOAD)

        with patch.object(oa, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(
                oa.cli, ["show", "bhi:11111111-2222-3333-4444-555555555555", "--json"], env=self.env
            )
            r2 = self.runner.invoke(
                oa.cli, ["show", "bhi:11111111-2222-3333-4444-555555555555"], env=self.env
            )

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(calls, 1)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertIn("[cache]", r2.output)
        self.assertIn("Jan Jansen", r2.output)

    def test_http_and_api_errors_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(500, text="server error")
            if calls == 2:
                return httpx.Response(200, json={"error_code": 1, "error_description": "Invalid archive"})
            return httpx.Response(200, json=SEARCH_PAYLOAD)

        with patch.object(oa, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(oa.cli, ["search", "--name", "Jan Jansen"], env=self.env)
            r2 = self.runner.invoke(oa.cli, ["search", "--name", "Jan Jansen"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r3 = self.runner.invoke(oa.cli, ["search", "--name", "Jan Jansen", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 1)
        self.assertNotIn("Traceback", r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 3)


JPEG_ONE = b"\xff\xd8\xff\x01"
JPEG_TWO = b"\xff\xd8\xff\x02"
RECORD_REF = "11111111-2222-3333-4444-555555555555"
FULL_ONE = "https://scans.invalid/full-1.jpg"
FULL_TWO = "https://scans.invalid/full-2.jpg"
PREVIEW_ONE = "https://scans.invalid/preview-1.jpg"

SCAN_RECORD = {
    "a2a_Source": {
        "a2a_SourceAvailableScans": {
            "a2a_Scan": [
                {
                    "a2a_OrderSequenceNumber": {"a2a_OrderSequenceNumber": "2"},
                    "a2a_Uri": {"a2a_Uri": FULL_TWO},
                    "a2a_UriPreview": {"a2a_UriPreview": "https://scans.invalid/preview-2.jpg"},
                    "a2a_Label": {"a2a_Label": "page two"},
                },
                {
                    "uri": FULL_ONE,
                    "uri_preview": PREVIEW_ONE,
                    "order": 1,
                    "label": "page one",
                },
            ]
        }
    }
}


class TestOpenArchievenDownload(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_OPENARCHIEVEN_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _clients(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def _combined(self, result) -> str:
        return f"{result.output}\n{result.stderr or ''}"

    def test_single_scan_downloads_then_hits_cache(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            if request.url.path.endswith("show.json"):
                return httpx.Response(200, json=[SCAN_RECORD])
            if str(request.url) == FULL_ONE:
                return httpx.Response(200, content=JPEG_ONE, headers={"content-type": "image/jpeg"})
            return httpx.Response(404, text="missing")

        out = Path(self.tmp.name) / "one.jpg"
        factory = self._clients(handler)
        with patch.object(oa, "_client", factory), patch.object(oa, "_binary_client", factory):
            first = self.runner.invoke(
                oa.cli,
                ["download", f"https://www.openarchieven.nl/bhi:{RECORD_REF}", "--out", str(out), "--json"],
                env=self.env,
            )
            second = self.runner.invoke(
                oa.cli,
                ["download", "bhi", RECORD_REF, "-o", str(out), "--json"],
                env=self.env,
            )

        self.assertEqual(first.exit_code, 0, self._combined(first))
        self.assertEqual(second.exit_code, 0, self._combined(second))
        first_body = json.loads(first.output)
        second_body = json.loads(second.output)
        self.assertFalse(first_body["cache_hit"])
        self.assertTrue(second_body["cache_hit"])
        self.assertEqual(first_body["files"][0]["url"], FULL_ONE)
        self.assertEqual(first_body["files"][0]["bytes"], len(JPEG_ONE))
        self.assertEqual(out.read_bytes(), JPEG_ONE)
        self.assertEqual(sum(1 for url in calls if "show.json" in url), 1)
        self.assertEqual(sum(1 for url in calls if url == FULL_ONE), 1)
        self.assertNotIn(PREVIEW_ONE, calls)

    def test_all_scans_use_order_and_deterministic_names(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            if request.url.path.endswith("show.json"):
                return httpx.Response(200, json=[SCAN_RECORD])
            if str(request.url) == FULL_ONE:
                return httpx.Response(200, content=JPEG_ONE, headers={"content-type": "image/jpeg"})
            if str(request.url) == FULL_TWO:
                return httpx.Response(200, content=JPEG_TWO, headers={"content-type": "image/jpeg"})
            return httpx.Response(404, text="missing")

        out_dir = Path(self.tmp.name) / "scans-out"
        factory = self._clients(handler)
        with patch.object(oa, "_client", factory), patch.object(oa, "_binary_client", factory):
            result = self.runner.invoke(
                oa.cli,
                ["download", f"bhi:{RECORD_REF}", "--all", "--out-dir", str(out_dir), "--json"],
                env=self.env,
            )

        self.assertEqual(result.exit_code, 0, self._combined(result))
        body = json.loads(result.output)
        self.assertEqual([item["index"] for item in body["files"]], [1, 2])
        self.assertEqual(body["files"][0]["label"], "page one")
        self.assertEqual(body["files"][1]["label"], "page two")
        first_path = Path(body["files"][0]["path"])
        second_path = Path(body["files"][1]["path"])
        self.assertEqual(first_path.name, "bhi-11111111-scan-01.jpg")
        self.assertEqual(second_path.name, "bhi-11111111-scan-02.jpg")
        self.assertEqual(first_path.read_bytes(), JPEG_ONE)
        self.assertEqual(second_path.read_bytes(), JPEG_TWO)
        self.assertFalse(body["cache_hit"])

    def test_refresh_and_zero_ttl_download_again(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            if request.url.path.endswith("show.json"):
                return httpx.Response(200, json=[SCAN_RECORD])
            if str(request.url) == FULL_ONE:
                return httpx.Response(200, content=JPEG_ONE, headers={"content-type": "image/jpeg"})
            return httpx.Response(404, text="missing")

        out = Path(self.tmp.name) / "one.jpg"
        factory = self._clients(handler)
        args = ["download", f"bhi:{RECORD_REF}", "--scan-index", "1", "--output", str(out), "--json"]
        with patch.object(oa, "_client", factory), patch.object(oa, "_binary_client", factory):
            self.runner.invoke(oa.cli, args, env=self.env)
            refreshed = self.runner.invoke(oa.cli, [*args, "--refresh"], env=self.env)
            expired = self.runner.invoke(oa.cli, [*args, "--cache-ttl-hours", "0"], env=self.env)

        self.assertEqual(refreshed.exit_code, 0, self._combined(refreshed))
        self.assertEqual(expired.exit_code, 0, self._combined(expired))
        self.assertFalse(json.loads(refreshed.output)["cache_hit"])
        self.assertFalse(json.loads(expired.output)["cache_hit"])
        self.assertEqual(sum(1 for url in calls if url == FULL_ONE), 3)

    def test_list_prints_full_urls_without_downloading(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            if request.url.path.endswith("show.json"):
                return httpx.Response(200, json=[SCAN_RECORD])
            return httpx.Response(500, text="should not download")

        factory = self._clients(handler)
        with patch.object(oa, "_client", factory), patch.object(oa, "_binary_client", factory):
            listed = self.runner.invoke(
                oa.cli, ["download", f"bhi:{RECORD_REF}", "--list", "--json"], env=self.env
            )
            preview = self.runner.invoke(
                oa.cli, ["download", f"bhi:{RECORD_REF}", "--list", "--preview", "--json"], env=self.env
            )

        self.assertEqual(listed.exit_code, 0, self._combined(listed))
        body = json.loads(listed.output)
        self.assertEqual(body["scans"][0]["url"], FULL_ONE)
        self.assertEqual(body["scans"][0]["index"], 1)
        self.assertEqual(body["scans"][0]["label"], "page one")
        self.assertFalse(body["cache_hit"])
        preview_body = json.loads(preview.output)
        self.assertEqual(preview_body["scans"][0]["url"], PREVIEW_ONE)
        self.assertTrue(preview_body["cache_hit"])
        self.assertEqual(sum(1 for url in calls if "scans.invalid" in url), 0)

    def test_html_and_http_errors_are_not_cached_or_saved(self) -> None:
        calls: list[str] = []
        mode = {"kind": "html"}

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            if request.url.path.endswith("show.json"):
                return httpx.Response(200, json=[SCAN_RECORD])
            if mode["kind"] == "html":
                return httpx.Response(
                    200,
                    content=b"<html><body>viewer</body></html>",
                    headers={"content-type": "text/html; charset=utf-8"},
                )
            if mode["kind"] == "http":
                return httpx.Response(502, content=b"bad gateway")
            return httpx.Response(200, content=JPEG_ONE, headers={"content-type": "image/jpeg"})

        out = Path(self.tmp.name) / "one.jpg"
        factory = self._clients(handler)
        args = ["download", f"bhi:{RECORD_REF}", "--out", str(out)]
        with patch.object(oa, "_client", factory), patch.object(oa, "_binary_client", factory):
            html = self.runner.invoke(oa.cli, args, env=self.env)
            html_again = self.runner.invoke(oa.cli, args, env=self.env)
            mode["kind"] = "http"
            http_err = self.runner.invoke(oa.cli, args, env=self.env)
            self.assertEqual(list(Path(self.tmp.name, "scans").glob("*.bin")), [])
            self.assertFalse(out.exists())
            mode["kind"] = "ok"
            ok = self.runner.invoke(oa.cli, [*args, "--json"], env=self.env)

        self.assertEqual(html.exit_code, 1)
        self.assertIn("HTML", self._combined(html))
        self.assertNotIn("Traceback", self._combined(html))
        self.assertEqual(html_again.exit_code, 1)
        self.assertEqual(http_err.exit_code, 1)
        self.assertIn("HTTP 502", self._combined(http_err))
        self.assertEqual(ok.exit_code, 0, self._combined(ok))
        self.assertEqual(out.read_bytes(), JPEG_ONE)
        image_calls = [url for url in calls if "scans.invalid" in url]
        self.assertEqual(len(image_calls), 4)

    def test_zero_scan_record_lists_empty_and_download_fails(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("show.json"):
                return httpx.Response(200, json=SHOW_PAYLOAD)
            return httpx.Response(500, text="no scans to fetch")

        factory = self._clients(handler)
        with patch.object(oa, "_client", factory), patch.object(oa, "_binary_client", factory):
            listed = self.runner.invoke(
                oa.cli, ["download", f"bhi:{RECORD_REF}", "--list", "--json"], env=self.env
            )
            failed = self.runner.invoke(
                oa.cli, ["download", f"bhi:{RECORD_REF}", "--out", str(Path(self.tmp.name) / "x.jpg")], env=self.env
            )

        self.assertEqual(listed.exit_code, 0, self._combined(listed))
        self.assertEqual(json.loads(listed.output)["scans"], [])
        self.assertEqual(failed.exit_code, 1)
        self.assertIn("No scans", self._combined(failed))
        self.assertNotIn("Traceback", self._combined(failed))


if __name__ == "__main__":
    unittest.main()
