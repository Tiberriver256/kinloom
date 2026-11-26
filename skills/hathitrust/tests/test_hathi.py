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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "hathi"


def load_module():
    loader = SourceFileLoader("hathi_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("hathi_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_HATHI_CACHE_DIR"] = _TEST_CACHE.name

hathi = load_module()

BIB_PAYLOAD_A = {
    "records": {
        "000578050": {
            "recordURL": "https://catalog.hathitrust.org/Record/000578050",
            "titles": ["History of Sangamon County, Illinois"],
            "publishDates": ["1881"],
            "oclcs": ["424023"],
        }
    },
    "items": [
        {
            "orig": "University of Illinois",
            "htid": "uiuo.ark:/13960/t00000001",
            "itemURL": "https://hdl.handle.net/2027/uiuo.ark:/13960/t00000001",
            "rightsCode": "pd",
            "usRightsString": "Full view",
        }
    ],
}

BIB_PAYLOAD_B = {
    "records": {
        "000999001": {
            "recordURL": "https://catalog.hathitrust.org/Record/000999001",
            "titles": ["Springfield City Directory, 1860"],
            "publishDates": ["1860"],
            "oclcs": ["999001"],
        }
    },
    "items": [
        {
            "orig": "University of Michigan",
            "htid": "mdp.39015000000001",
            "itemURL": "https://hdl.handle.net/2027/mdp.39015000000001",
            "rightsCode": "pd",
            "usRightsString": "Full view",
        }
    ],
}


class TestHathiCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_HATHI_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport)

    def test_bib_caches_and_second_run_makes_zero_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=BIB_PAYLOAD_A)

        with patch.object(hathi, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023", "--json"], env=self.env)
            r2 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023", "--json"], env=self.env)
            r3 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 1)
        d1 = json.loads(r1.output)
        d2 = json.loads(r2.output)
        self.assertFalse(d1["cache_hit"])
        self.assertTrue(d2["cache_hit"])
        self.assertEqual(d2["records"]["000578050"]["titles"], ["History of Sangamon County, Illinois"])
        self.assertIn("[cache]", r3.output)
        self.assertIn("History of Sangamon County, Illinois", r3.output)

    def test_multi_id_reuses_per_identifier_cache(self) -> None:
        urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            urls.append(str(request.url))
            if "424023" in str(request.url):
                return httpx.Response(200, json=BIB_PAYLOAD_A)
            return httpx.Response(200, json=BIB_PAYLOAD_B)

        with patch.object(hathi, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023", "--json"], env=self.env)
            r2 = self.runner.invoke(
                hathi.cli,
                ["bib", "--id", "oclc:424023", "--id", "recordnumber:000999001", "--json"],
                env=self.env,
            )
            r3 = self.runner.invoke(
                hathi.cli,
                ["bib", "--id", "oclc:424023", "--id", "recordnumber:000999001", "--json"],
                env=self.env,
            )

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(len(urls), 2)
        self.assertFalse(json.loads(r2.output)["cache_hit"])
        d3 = json.loads(r3.output)
        self.assertTrue(d3["cache_hit"])
        self.assertEqual(sorted(d3["records"].keys()), ["000578050", "000999001"])

    def test_refresh_and_zero_ttl_bypass_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=BIB_PAYLOAD_A)

        with patch.object(hathi, "_client", self._mock_client(handler)):
            self.runner.invoke(hathi.cli, ["bib", "oclc", "424023", "--json"], env=self.env)
            r_ref = self.runner.invoke(
                hathi.cli, ["bib", "oclc", "424023", "--refresh", "--json"], env=self.env
            )
            r_ttl = self.runner.invoke(
                hathi.cli, ["bib", "oclc", "424023", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(r_ref.output)["cache_hit"])
        self.assertFalse(json.loads(r_ttl.output)["cache_hit"])

    def test_http_errors_non_json_and_empty_payloads_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(500, text="server error")
            if calls == 2:
                return httpx.Response(200, text="<html>error</html>")
            if calls == 3:
                return httpx.Response(200, json={"records": {}, "items": []})
            return httpx.Response(200, json=BIB_PAYLOAD_A)

        with patch.object(hathi, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023"], env=self.env)
            r2 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023"], env=self.env)
            r3 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r4 = self.runner.invoke(hathi.cli, ["bib", "oclc", "424023", "--json"], env=self.env)

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
