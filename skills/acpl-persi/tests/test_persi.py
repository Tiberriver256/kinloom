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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "persi"


def load_module():
    loader = SourceFileLoader("persi_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("persi_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_PERSI_CACHE_DIR"] = _TEST_CACHE.name

persi = load_module()
persi.RETRY_WAIT_S = 0.0

SURNAME_HTML = """
<html><body>
<table>
  <tr><th>Article Title</th><th>Periodical</th><th>Year</th><th>Publisher</th></tr>
  <tr>
    <td>Lincoln family in Sangamon County</td>
    <td>Illinois State Genealogical Quarterly</td>
    <td>1985</td>
    <td><a href="https://example.org/issue-1985">ISGS</a></td>
  </tr>
  <tr>
    <td>Lincoln letters, 1858</td>
    <td>Sangamon Circuit Notes</td>
    <td>1992</td>
    <td>Sangamon Historical Society</td>
  </tr>
</table>
</body></html>
"""

LOCATION_HTML = """
<html><body>
<table>
  <tr><th>Category</th><th>Articles</th></tr>
  <tr><td>Cemeteries</td><td>1,240</td></tr>
  <tr><td>Court Records</td><td>315</td></tr>
</table>
</body></html>
"""


class TestPersiCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_PERSI_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda headers: httpx.Client(transport=transport, headers=headers, follow_redirects=True)

    def test_surname_and_search_alias_cache_with_zero_repeat_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, text=SURNAME_HTML)

        with patch.object(persi, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(persi.cli, ["surname", "Lincoln", "--limit", "1", "--json"], env=self.env)
            r2 = self.runner.invoke(persi.cli, ["surname", "lincoln", "--limit", "2", "--json"], env=self.env)
            r3 = self.runner.invoke(persi.cli, ["search", "Lincoln"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 1)
        self.assertEqual(len(json.loads(r1.output)), 1)
        self.assertEqual(len(json.loads(r2.output)), 2)
        self.assertIn("[cache]", r3.output)
        self.assertIn("Lincoln family in Sangamon County", r3.output)

    def test_title_and_location_cache_and_refresh_bypasses(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if "location" in str(request.url):
                return httpx.Response(200, text=LOCATION_HTML)
            return httpx.Response(200, text=SURNAME_HTML)

        with patch.object(persi, "_client", self._mock_client(handler)):
            rt1 = self.runner.invoke(persi.cli, ["title", "Lincoln", "--json"], env=self.env)
            rt2 = self.runner.invoke(persi.cli, ["title", "Lincoln"], env=self.env)
            rt_ref = self.runner.invoke(persi.cli, ["title", "Lincoln", "--refresh"], env=self.env)
            rt_ttl = self.runner.invoke(
                persi.cli, ["search", "--title", "Lincoln", "--cache-ttl-hours", "0"], env=self.env
            )
            rl1 = self.runner.invoke(
                persi.cli, ["location", "--state", "IL", "--county", "Sangamon", "--json"], env=self.env
            )
            rl2 = self.runner.invoke(
                persi.cli, ["location", "--state", "IL", "--county", "Sangamon"], env=self.env
            )

        self.assertEqual(rt1.exit_code, 0, rt1.output)
        self.assertEqual(rt2.exit_code, 0, rt2.output)
        self.assertEqual(rt_ref.exit_code, 0, rt_ref.output)
        self.assertEqual(rt_ttl.exit_code, 0, rt_ttl.output)
        self.assertEqual(rl1.exit_code, 0, rl1.output)
        self.assertEqual(rl2.exit_code, 0, rl2.output)
        self.assertEqual(calls, 4)
        self.assertIn("[cache]", rt2.output)
        self.assertNotIn("[cache]", rt_ref.output)
        self.assertNotIn("[cache]", rt_ttl.output)
        self.assertIn("[cache]", rl2.output)
        self.assertEqual(json.loads(rl1.output)[0], {"category": "Cemeteries", "articles": 1240})

    def test_http_errors_and_empty_pages_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls <= 2:
                return httpx.Response(500, text="server error")
            if calls == 3:
                return httpx.Response(200, text="<html><body>Maintenance</body></html>")
            return httpx.Response(200, text=SURNAME_HTML)

        with patch.object(persi, "_client", self._mock_client(handler)):
            r_err = self.runner.invoke(persi.cli, ["surname", "Alder"], env=self.env)
            r_empty = self.runner.invoke(persi.cli, ["surname", "Alder"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r_ok = self.runner.invoke(persi.cli, ["surname", "Alder", "--json"], env=self.env)

        self.assertEqual(r_err.exit_code, 1)
        self.assertNotIn("Traceback", r_err.output)
        self.assertEqual(r_empty.exit_code, 0, r_empty.output)
        self.assertIn("No results.", r_empty.output)
        self.assertEqual(r_ok.exit_code, 0, r_ok.output)
        self.assertEqual(len(json.loads(r_ok.output)), 2)
        self.assertEqual(len(list(Path(self.tmp.name).glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
