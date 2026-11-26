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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "ca-archives"


def load_module():
    loader = SourceFileLoader("ca_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("ca_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_CA_ARCHIVES_CACHE_DIR"] = _TEST_CACHE.name

ca = load_module()

PORTAL_SEARCH_HTML = (
    "<html><body><p>Search Results 1 to 1 of 1</p>"
    '<a href="/Items/Details/42">Lincoln Petition, Sacramento</a>'
    "</body></html>"
)

PORTAL_ITEM_HTML = "<html><head><title>Lincoln Petition | California Archives Search</title></head></html>"

EXHIBITS_SEARCH_JSON = [
    {"o:id": 99, "o:title": "Sacramento Exhibit", "@type": ["o:Item", "dctype:Image"]}
]

EXHIBITS_ITEM_JSON = {
    "o:id": 99,
    "o:title": "Sacramento Exhibit",
    "@type": ["o:Item", "dctype:Image"],
    "dcterms:description": [{"@value": "Historic photo"}],
}


class TestCaArchivesCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_CA_ARCHIVES_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def test_portal_and_exhibits_search_caches_with_zero_repeat_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if "archives.sos.ca.gov" in str(request.url):
                return httpx.Response(200, text=PORTAL_SEARCH_HTML)
            return httpx.Response(200, json=EXHIBITS_SEARCH_JSON, headers={"Omeka-S-Total-Results": "1"})

        with patch.object(ca, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(
                ca.cli, ["search", "Sacramento", "--source", "portal", "--source", "exhibits", "--json"],
                env=self.env,
            )
            r2 = self.runner.invoke(
                ca.cli, ["search", "Sacramento", "--source", "portal", "--source", "exhibits", "--json"],
                env=self.env,
            )
            r3 = self.runner.invoke(
                ca.cli, ["search", "Sacramento", "--source", "portal"],
                env=self.env,
            )

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 2)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertTrue(json.loads(r2.output)["cache_hit"])
        self.assertIn("[cache]", r3.output)

    def test_refresh_and_zero_ttl_bypass_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, text=PORTAL_SEARCH_HTML)

        with patch.object(ca, "_client", self._mock_client(handler)):
            self.runner.invoke(ca.cli, ["search", "Lincoln", "--source", "portal", "--json"], env=self.env)
            r_ref = self.runner.invoke(
                ca.cli, ["search", "Lincoln", "--source", "portal", "--refresh", "--json"], env=self.env
            )
            r_ttl = self.runner.invoke(
                ca.cli,
                ["search", "Lincoln", "--source", "portal", "--cache-ttl-hours", "0", "--json"],
                env=self.env,
            )

        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(r_ref.output)["cache_hit"])
        self.assertFalse(json.loads(r_ttl.output)["cache_hit"])

    def test_get_portal_and_exhibits_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if "Items/Details" in str(request.url):
                return httpx.Response(200, text=PORTAL_ITEM_HTML)
            return httpx.Response(200, json=EXHIBITS_ITEM_JSON)

        with patch.object(ca, "_client", self._mock_client(handler)):
            rp1 = self.runner.invoke(ca.cli, ["get", "--portal", "42", "--json"], env=self.env)
            rp2 = self.runner.invoke(ca.cli, ["get", "--portal", "42"], env=self.env)
            re1 = self.runner.invoke(ca.cli, ["get", "--exhibits", "99", "--json"], env=self.env)
            re2 = self.runner.invoke(ca.cli, ["get", "--exhibits", "99", "--json"], env=self.env)

        self.assertEqual(calls, 2)
        self.assertFalse(json.loads(rp1.output)["cache_hit"])
        self.assertIn("[cache]", rp2.output)
        self.assertFalse(json.loads(re1.output)["cache_hit"])
        self.assertTrue(json.loads(re2.output)["cache_hit"])

    def test_http_error_and_blocked_empty_portal_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(500, text="error")
            if calls == 2:
                return httpx.Response(200, text="<html><body>Temporary block</body></html>")
            return httpx.Response(200, text=PORTAL_SEARCH_HTML)

        with patch.object(ca, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(ca.cli, ["search", "Lincoln", "--source", "portal"], env=self.env)
            r2 = self.runner.invoke(ca.cli, ["search", "Lincoln", "--source", "portal", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r3 = self.runner.invoke(ca.cli, ["search", "Lincoln", "--source", "portal", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 3)


if __name__ == "__main__":
    unittest.main()
