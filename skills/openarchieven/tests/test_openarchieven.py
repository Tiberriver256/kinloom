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


if __name__ == "__main__":
    unittest.main()
