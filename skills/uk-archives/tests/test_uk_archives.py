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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "uk-archives"


def load_module():
    loader = SourceFileLoader("uk_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("uk_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_UK_ARCHIVES_CACHE_DIR"] = _TEST_CACHE.name

uk = load_module()

DISCOVERY_SEARCH_PAYLOAD = {
    "count": 1,
    "records": [
        {
            "id": "D123456",
            "reference": "PROB 11/200/15",
            "title": "Will of Thomas Lincoln of Hingham, Norfolk",
            "description": "Probate copy of will.",
            "coveringDates": "1638",
            "department": "PROB",
            "places": ["Hingham, Norfolk"],
            "heldBy": ["The National Archives, Kew"],
        }
    ],
}

DISCOVERY_DETAIL_PAYLOAD = {
    "id": "D123456",
    "citableReference": "PROB 11/200/15",
    "coveringDates": "1638",
    "scopeContent": {"description": "<p>Will of Thomas Lincoln of Hingham, Norfolk.</p>"},
    "heldBy": [{"xReferenceName": "The National Archives, Kew"}],
    "digitised": True,
    "legalStatus": "Public Record",
    "catalogueLevel": 7,
}

FREEREG_HOME_HTML = (
    '<html><body><form><input name="authenticity_token" value="csrf-test-token-123" /></form></body></html>'
)

FREEREG_RESULTS_HTML = """
<html><body><table><tbody>
  <tr id="fr_row_1">
    <td><a href="/search_records/fr_row_1">View 1</a></td>
    <td>Samuel LINCOLN</td>
    <td>Baptism</td>
    <td>24 Aug 1622</td>
    <td>Norfolk</td>
    <td>Hingham : St Andrew : Parish Register</td>
  </tr>
  <tr id="fr_row_2">
    <td><a href="/search_records/fr_row_2">View 2</a></td>
    <td>Edward LINCOLN</td>
    <td>Burial</td>
    <td>11 Feb 1639</td>
    <td>Norfolk</td>
    <td>Swanton Morley : All Saints : Parish Register</td>
  </tr>
</tbody></table></body></html>
"""


class TestUkArchivesCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_UK_ARCHIVES_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def test_discovery_search_and_detail_cache_with_zero_repeat_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if "/details/" in str(request.url):
                return httpx.Response(200, json=DISCOVERY_DETAIL_PAYLOAD)
            return httpx.Response(200, json=DISCOVERY_SEARCH_PAYLOAD)

        with patch.object(uk, "_client", self._mock_client(handler)):
            rs1 = self.runner.invoke(
                uk.cli, ["discovery", "search", "Lincoln", "--collection", "PROB 11", "--json"], env=self.env
            )
            rs2 = self.runner.invoke(
                uk.cli, ["discovery", "search", "Lincoln", "--collection", "PROB 11", "--json"], env=self.env
            )
            rs3 = self.runner.invoke(
                uk.cli, ["discovery", "search", "Lincoln", "--collection", "PROB 11"], env=self.env
            )
            rd1 = self.runner.invoke(uk.cli, ["discovery", "detail", "D123456", "--json"], env=self.env)
            rd2 = self.runner.invoke(uk.cli, ["discovery", "inspect", "D123456"], env=self.env)

        self.assertEqual(rs1.exit_code, 0, rs1.output)
        self.assertEqual(rs2.exit_code, 0, rs2.output)
        self.assertEqual(rs3.exit_code, 0, rs3.output)
        self.assertEqual(rd1.exit_code, 0, rd1.output)
        self.assertEqual(rd2.exit_code, 0, rd2.output)
        self.assertEqual(calls, 2)
        self.assertFalse(json.loads(rs1.output)["cache_hit"])
        self.assertTrue(json.loads(rs2.output)["cache_hit"])
        self.assertIn("[cache]", rs3.output)
        self.assertFalse(json.loads(rd1.output)["cache_hit"])
        self.assertIn("[cache]", rd2.output)
        self.assertIn("PROB 11/200/15", rd2.output)

    def test_freereg_caches_and_filters_place_contains_locally(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if request.method == "GET":
                return httpx.Response(200, text=FREEREG_HOME_HTML)
            return httpx.Response(200, text=FREEREG_RESULTS_HTML)

        with patch.object(uk, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(
                uk.cli, ["freereg", "search", "--surname", "Lincoln", "--county", "NFK", "--json"], env=self.env
            )
            r2 = self.runner.invoke(
                uk.cli,
                [
                    "freereg",
                    "search",
                    "--surname",
                    "Lincoln",
                    "--county",
                    "NFK",
                    "--place-contains",
                    "Hingham",
                    "--json",
                ],
                env=self.env,
            )
            r3 = self.runner.invoke(
                uk.cli, ["freereg", "search", "--surname", "Lincoln", "--county", "NFK"], env=self.env
            )

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        # 1 GET (CSRF) + 1 POST on cold run, 0 on both subsequent runs.
        self.assertEqual(calls, 2)
        self.assertEqual(json.loads(r1.output)["returned"], 2)
        d2 = json.loads(r2.output)
        self.assertTrue(d2["cache_hit"])
        self.assertEqual(d2["returned"], 1)
        self.assertEqual(d2["records"][0]["persons"], "Samuel LINCOLN")
        self.assertIn("[cache]", r3.output)

    def test_freereg_limit_slices_after_place_filter_and_reuses_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if request.method == "GET":
                return httpx.Response(200, text=FREEREG_HOME_HTML)
            return httpx.Response(200, text=FREEREG_RESULTS_HTML)

        with patch.object(uk, "_client", self._mock_client(handler)):
            r_all = self.runner.invoke(
                uk.cli, ["freereg", "search", "--surname", "Lincoln", "--county", "NFK", "--json"], env=self.env
            )
            r_limit = self.runner.invoke(
                uk.cli,
                ["freereg", "search", "--surname", "Lincoln", "--county", "NFK", "--limit", "1", "--json"],
                env=self.env,
            )
            r_place = self.runner.invoke(
                uk.cli,
                [
                    "freereg",
                    "search",
                    "--surname",
                    "Lincoln",
                    "--county",
                    "NFK",
                    "--place-contains",
                    "Swanton",
                    "--limit",
                    "1",
                    "--json",
                ],
                env=self.env,
            )
            r_bad = self.runner.invoke(
                uk.cli,
                ["freereg", "search", "--surname", "Lincoln", "--county", "NFK", "--limit", "0"],
                env=self.env,
            )

        self.assertEqual(r_all.exit_code, 0, r_all.output)
        self.assertEqual(r_limit.exit_code, 0, r_limit.output)
        self.assertEqual(r_place.exit_code, 0, r_place.output)
        self.assertEqual(calls, 2)
        self.assertEqual(json.loads(r_all.output)["returned"], 2)
        self.assertFalse(json.loads(r_all.output)["cache_hit"])
        limited = json.loads(r_limit.output)
        self.assertTrue(limited["cache_hit"])
        self.assertEqual(limited["returned"], 1)
        self.assertEqual(limited["records"][0]["persons"], "Samuel LINCOLN")
        placed = json.loads(r_place.output)
        self.assertTrue(placed["cache_hit"])
        self.assertEqual(placed["returned"], 1)
        self.assertEqual(placed["records"][0]["persons"], "Edward LINCOLN")
        self.assertEqual(r_bad.exit_code, 2)
        cache_files = list(Path(self.tmp.name).glob("*.json"))
        self.assertEqual(len(cache_files), 1)
        stored = json.loads(cache_files[0].read_text(encoding="utf-8"))
        self.assertNotIn("limit", stored["query"])
        self.assertNotIn("cache_hit", stored["result"])

    def test_refresh_and_zero_ttl_bypass_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=DISCOVERY_SEARCH_PAYLOAD)

        with patch.object(uk, "_client", self._mock_client(handler)):
            self.runner.invoke(uk.cli, ["discovery", "search", "Lincoln", "--json"], env=self.env)
            r_ref = self.runner.invoke(
                uk.cli, ["discovery", "search", "Lincoln", "--refresh", "--json"], env=self.env
            )
            r_ttl = self.runner.invoke(
                uk.cli, ["discovery", "search", "Lincoln", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(r_ref.output)["cache_hit"])
        self.assertFalse(json.loads(r_ttl.output)["cache_hit"])

    def test_errors_and_empty_payloads_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(500, text="server error")
            if calls == 2:
                return httpx.Response(200, text="<html>no token here</html>")
            if calls == 3:
                return httpx.Response(200, json={"count": 0, "records": []})
            return httpx.Response(200, json=DISCOVERY_SEARCH_PAYLOAD)

        with patch.object(uk, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(uk.cli, ["discovery", "search", "Smith"], env=self.env)
            r2 = self.runner.invoke(uk.cli, ["freereg", "search", "--surname", "Smith"], env=self.env)
            r3 = self.runner.invoke(uk.cli, ["discovery", "search", "Smith", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r4 = self.runner.invoke(uk.cli, ["discovery", "search", "Smith", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 1)
        self.assertNotIn("Traceback", r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertFalse(json.loads(r3.output)["cache_hit"])
        self.assertEqual(r4.exit_code, 0, r4.output)
        self.assertEqual(calls, 4)
        self.assertEqual(len(list(Path(self.tmp.name).glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
