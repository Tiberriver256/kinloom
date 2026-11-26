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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "mo-archives"


def load_module():
    loader = SourceFileLoader("mo_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("mo_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_MO_ARCHIVES_CACHE_DIR"] = _TEST_CACHE.name

mo = load_module()

FORM_HTML = '<form><input type="hidden" name="__ncforminfo" value="tok123" /></form>'

DEATH_RESULTS_HTML = (
    "<p>Showing records 1 to 1 of 1</p>"
    "<table>"
    "<tr><th>Name</th><th>Age</th><th>Date of Death</th><th>County</th><th>Cert</th><th>SSN</th><th>Image</th></tr>"
    '<tr><td>Smith, John</td><td>70</td><td>1920-04-02</td><td>Marion</td><td>1001</td><td></td>'
    '<td><a href="/images/archives/deathcerts/1920/0001001.PDF">PDF</a></td></tr>'
    "</table>"
)

PRE1910_RESULTS_HTML = (
    "<p>Showing records 1 to 1 of 1</p>"
    "<table>"
    "<tr><th>Name</th><th>Age</th><th>Sex</th><th>Color</th><th>Date Of Death</th><th>County</th><th>Details</th></tr>"
    '<tr><td>Smith, Jane</td><td>62</td><td>F</td><td>W</td><td>1885-06-10</td><td>Marion</td>'
    '<td><a href="Detail?id=555">View</a></td></tr>'
    "</table>"
)

DETAIL_HTML = (
    "<table>"
    "<tr><th>Name</th><th>County</th></tr>"
    "<tr><td>Smith, Jane</td><td>Marion</td></tr>"
    "</table>"
)


class TestMoArchivesCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_MO_ARCHIVES_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def test_death_search_caches_with_zero_repeat_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if request.method == "GET":
                return httpx.Response(200, text=FORM_HTML)
            return httpx.Response(200, text=DEATH_RESULTS_HTML)

        with patch.object(mo, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(mo.cli, ["death", "--last", "Smith", "--json"], env=self.env)
            r2 = self.runner.invoke(mo.cli, ["death", "--last", "Smith", "--json"], env=self.env)
            r3 = self.runner.invoke(mo.cli, ["death", "--last", "Smith"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 2)  # GET form + POST search on first call only
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertTrue(json.loads(r2.output)["cache_hit"])
        self.assertIn("[cache]", r3.output)

    def test_pre1910_and_detail_cache_and_refresh(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if "Detail" in str(request.url):
                return httpx.Response(200, text=DETAIL_HTML)
            if request.method == "GET":
                return httpx.Response(200, text=FORM_HTML)
            return httpx.Response(200, text=PRE1910_RESULTS_HTML)

        with patch.object(mo, "_client", self._mock_client(handler)):
            p1 = self.runner.invoke(mo.cli, ["pre1910", "--name", "Smith", "--json"], env=self.env)
            p2 = self.runner.invoke(mo.cli, ["pre1910", "--name", "Smith", "--json"], env=self.env)
            p_ref = self.runner.invoke(
                mo.cli, ["pre1910", "--name", "Smith", "--refresh", "--json"], env=self.env
            )
            d1 = self.runner.invoke(mo.cli, ["detail", "555", "--json"], env=self.env)
            d2 = self.runner.invoke(mo.cli, ["detail", "555"], env=self.env)
            d_ttl = self.runner.invoke(
                mo.cli, ["detail", "555", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertFalse(json.loads(p1.output)["cache_hit"])
        self.assertTrue(json.loads(p2.output)["cache_hit"])
        self.assertFalse(json.loads(p_ref.output)["cache_hit"])
        self.assertFalse(json.loads(d1.output)["cache_hit"])
        self.assertIn("[cache]", d2.output)
        self.assertFalse(json.loads(d_ttl.output)["cache_hit"])
        self.assertEqual(calls, 6)  # 2 (pre1910) + 2 (refresh) + 1 (detail) + 1 (ttl 0)

    def test_http_error_and_unverified_empty_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(500, text="server error")
            if request.method == "GET":
                return httpx.Response(200, text=FORM_HTML)
            if calls == 3:
                return httpx.Response(200, text="<html><body>Blocked</body></html>")
            return httpx.Response(200, text=DEATH_RESULTS_HTML)

        with patch.object(mo, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(mo.cli, ["death", "--last", "Smith"], env=self.env)
            r2 = self.runner.invoke(mo.cli, ["death", "--last", "Smith", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r3 = self.runner.invoke(mo.cli, ["death", "--last", "Smith", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(len(list(Path(self.tmp.name).glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
