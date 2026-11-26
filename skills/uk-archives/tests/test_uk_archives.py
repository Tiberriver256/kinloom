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
uk.RETRY_BASE_SECONDS = 0.0

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
        mode = {"step": "http500"}

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if mode["step"] == "http500":
                return httpx.Response(500, text="server error")
            if mode["step"] == "freereg_no_token":
                return httpx.Response(200, text="<html>no token here</html>")
            if mode["step"] == "empty":
                return httpx.Response(200, json={"count": 0, "records": []})
            return httpx.Response(200, json=DISCOVERY_SEARCH_PAYLOAD)

        with patch.object(uk, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(uk.cli, ["discovery", "search", "Smith"], env=self.env)
            mode["step"] = "freereg_no_token"
            r2 = self.runner.invoke(uk.cli, ["freereg", "search", "--surname", "Smith"], env=self.env)
            mode["step"] = "empty"
            r3 = self.runner.invoke(uk.cli, ["discovery", "search", "Smith", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            mode["step"] = "ok"
            r4 = self.runner.invoke(uk.cli, ["discovery", "search", "Smith", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 1)
        self.assertNotIn("Traceback", r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertFalse(json.loads(r3.output)["cache_hit"])
        self.assertEqual(r4.exit_code, 0, r4.output)
        # 3 attempts on persistent 500 + 1 FreeREG GET + 1 empty + 1 ok = 6
        self.assertEqual(calls, 6)
        self.assertEqual(len(list(Path(self.tmp.name).glob("*.json"))), 1)

    def test_tna_search_and_get_cache_dates_and_collection_filter(self) -> None:
        seen: list[httpx.Request] = []
        multi_payload = {
            "count": 2,
            "records": [
                {
                    "id": "D980036",
                    "reference": "PROB 11/44/39",
                    "title": "Will of Richard Smith of Norfolk",
                    "description": "Probate copy of will.",
                    "coveringDates": "04 February 1561",
                    "department": "PROB",
                    "places": ["Norfolk"],
                    "heldBy": ["The National Archives, Kew"],
                },
                {
                    "id": "C999999",
                    "reference": "WARD 7/29/17",
                    "title": "Inquisition post mortem",
                    "description": "Non-PROB record that should be filtered out.",
                    "coveringDates": "1590",
                    "department": "WARD",
                    "places": ["Norfolk"],
                    "heldBy": ["The National Archives, Kew"],
                },
            ],
        }
        detail_payload = {
            "id": "D980036",
            "citableReference": "PROB 11/44/39",
            "coveringDates": "04 February 1561",
            "coveringFromDate": 15610204,
            "coveringToDate": 15610204,
            "scopeContent": {
                "description": '<emph altrender="doctype">W</emph><persname>Richard Smith</persname><geogname>Norfolk</geogname>'
            },
            "heldBy": [{"xReferenceName": "The National Archives, Kew"}],
            "digitised": True,
            "legalStatus": "Public Record(s)",
            "catalogueLevel": 7,
            "parentId": "C1903347",
        }

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if "/API/records/v1/details/D980036" in str(request.url):
                return httpx.Response(200, json=detail_payload)
            return httpx.Response(200, json=multi_payload)

        with patch.object(uk, "_client", self._mock_client(handler)):
            s1 = self.runner.invoke(
                uk.cli,
                [
                    "tna",
                    "search",
                    "--query",
                    "Smith Norfolk",
                    "--collection",
                    "PROB 11",
                    "--start-date",
                    "1550",
                    "--end-date",
                    "1620",
                    "--limit",
                    "5",
                    "--json",
                ],
                env=self.env,
            )
            s2 = self.runner.invoke(
                uk.cli,
                [
                    "tna",
                    "search",
                    "--query",
                    "Smith Norfolk",
                    "--collection",
                    "PROB 11",
                    "--start-date",
                    "1550",
                    "--end-date",
                    "1620",
                    "--limit",
                    "5",
                    "--json",
                ],
                env=self.env,
            )
            g1 = self.runner.invoke(uk.cli, ["tna", "get", "D980036", "--json"], env=self.env)
            g2 = self.runner.invoke(uk.cli, ["tna", "get", "D980036", "--json"], env=self.env)

        self.assertEqual(s1.exit_code, 0, s1.output)
        self.assertEqual(s2.exit_code, 0, s2.output)
        self.assertEqual(g1.exit_code, 0, g1.output)
        self.assertEqual(g2.exit_code, 0, g2.output)
        self.assertEqual(len(seen), 2)
        search_params = seen[0].url.params
        self.assertEqual(search_params["sps.dateFrom"], "1550-01-01")
        self.assertEqual(search_params["sps.dateTo"], "1620-12-31")
        self.assertEqual(search_params["sps.departments"], "PROB")

        body1 = json.loads(s1.output)
        body2 = json.loads(s2.output)
        self.assertIs(body1["cache_hit"], False)
        self.assertIs(body2["cache_hit"], True)
        self.assertEqual(body1["returned"], 1)
        self.assertEqual(body1["records"][0]["reference"], "PROB 11/44/39")
        self.assertEqual(body1["records"][0]["iaid"], "D980036")

        det1 = json.loads(g1.output)
        det2 = json.loads(g2.output)
        self.assertIs(det1["cache_hit"], False)
        self.assertIs(det2["cache_hit"], True)
        self.assertEqual(det1["citable_reference"], "PROB 11/44/39")
        self.assertEqual(det1["description"], "W Richard Smith Norfolk")
        self.assertEqual(det1["parent_id"], "C1903347")

    def test_tna_retries_transient_429_and_503_with_retry_after(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(429, headers={"Retry-After": "0"}, text="rate limited")
            if calls == 2:
                return httpx.Response(503, text="temporarily unavailable")
            return httpx.Response(200, json=DISCOVERY_SEARCH_PAYLOAD)

        with patch.object(uk, "_client", self._mock_client(handler)):
            res = self.runner.invoke(
                uk.cli, ["tna", "search", "--query", "Smith", "--json"], env=self.env
            )

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(calls, 3)
        payload = json.loads(res.output)
        self.assertIs(payload["cache_hit"], False)
        self.assertEqual(payload["returned"], 1)

    def test_tna_host_allowlist_and_iaid_validation(self) -> None:
        bad_iaid = self.runner.invoke(uk.cli, ["tna", "get", "../etc/passwd"], env=self.env)
        self.assertEqual(bad_iaid.exit_code, 2)

        bad_dates = self.runner.invoke(
            uk.cli,
            ["tna", "search", "--query", "Smith", "--start-date", "1620", "--end-date", "1550"],
            env=self.env,
        )
        self.assertEqual(bad_dates.exit_code, 2)

        with self.assertRaises(uk.click.ClickException):
            uk.validate_url("http://discovery.nationalarchives.gov.uk/API/search/v1/records", allowed_hosts=uk.ALLOWED_TNA_HOSTS)
        with self.assertRaises(uk.click.ClickException):
            uk.validate_url("https://evil.example/API/search/v1/records", allowed_hosts=uk.ALLOWED_TNA_HOSTS)
        with self.assertRaises(uk.click.ClickException):
            uk.validate_url("https://user:pass@discovery.nationalarchives.gov.uk/API/search/v1/records", allowed_hosts=uk.ALLOWED_TNA_HOSTS)

        # Redirect to an off-allowlist host must be rejected before returning data.
        def redirect_handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "discovery.nationalarchives.gov.uk":
                return httpx.Response(302, headers={"Location": "https://evil.example/leak"})
            return httpx.Response(200, json=DISCOVERY_SEARCH_PAYLOAD)

        with patch.object(uk, "_client", self._mock_client(redirect_handler)):
            blocked = self.runner.invoke(uk.cli, ["tna", "search", "--query", "Smith"], env=self.env)
        self.assertEqual(blocked.exit_code, 1)
        self.assertIn("Refusing host", blocked.output)


if __name__ == "__main__":
    unittest.main()
