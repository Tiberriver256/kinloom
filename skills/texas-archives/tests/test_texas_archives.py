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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "texas-archives"


def load_module():
    loader = SourceFileLoader("texas_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("texas_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_TEXAS_ARCHIVES_CACHE_DIR"] = _TEST_CACHE.name

tx = load_module()

OPENSEARCH_PAYLOAD = {
    "feed": {
        "opensearch:totalResults": "2",
        "entry": [
            {
                "id": "ark:/67531/metapth100001",
                "title": "Austin Gazette (Travis County)",
                "dc:creator": "Austin Publishing Co.",
                "dc:date": "1874-05-12",
                "dc:description": "Weekly newspaper from Travis County mentioning Sam Houston.",
                "dc:type": "text_newspaper",
                "link": "https://texashistory.unt.edu/ark:/67531/metapth100001/",
            },
            {
                "id": "ark:/67531/metapth100002",
                "title": "Travis County Deed Ledger",
                "dc:creator": "Travis County Clerk",
                "dc:date": "1881",
                "dc:description": "Land transfers in Travis County.",
                "dc:type": "text_book",
                "link": "https://texashistory.unt.edu/ark:/67531/metapth100002/",
            },
        ],
    }
}

OAI_XML = """<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"
         xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <GetRecord>
    <record>
      <header>
        <identifier>ark:/67531/metapth100001</identifier>
        <setSpec>partner:TSLAC</setSpec>
      </header>
      <metadata>
        <oai_dc:dc>
          <dc:title>Austin Gazette (Travis County)</dc:title>
          <dc:creator>Austin Publishing Co.</dc:creator>
          <dc:date>1874-05-12</dc:date>
          <dc:type>text_newspaper</dc:type>
          <dc:subject>Travis County (Tex.)</dc:subject>
        </oai_dc:dc>
      </metadata>
    </record>
  </GetRecord>
</OAI-PMH>
"""

OAI_ERROR_XML = """<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <error code="idDoesNotExist">No matching identifier</error>
</OAI-PMH>
"""

TDA_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Houston Correspondence, 1841</title>
    <link>https://tsl.access.preservica.com/uncategorized/IO_1001/</link>
  </item>
  <item>
    <title>Travis County Tax Roll, 1850</title>
    <link>https://tsl.access.preservica.com/uncategorized/IO_1002/</link>
  </item>
</channel></rss>
"""


class TestTexasArchivesCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_TEXAS_ARCHIVES_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def test_portal_search_caches_pages_and_reuses_for_local_filters(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=OPENSEARCH_PAYLOAD)

        with patch.object(tx, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(
                tx.cli,
                ["portal", "search", "Houston", "--county", "Travis", "--pages", "1", "--json"],
                env=self.env,
            )
            r2 = self.runner.invoke(
                tx.cli,
                [
                    "portal",
                    "search",
                    "Houston",
                    "--county",
                    "Travis",
                    "--type",
                    "text_newspaper",
                    "--pages",
                    "1",
                    "--json",
                ],
                env=self.env,
            )
            r3 = self.runner.invoke(
                tx.cli,
                ["portal", "search", "Houston", "--county", "Travis", "--pages", "1"],
                env=self.env,
            )

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 1)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        d2 = json.loads(r2.output)
        self.assertTrue(d2["cache_hit"])
        self.assertEqual(d2["returned"], 1)
        self.assertEqual(d2["records"][0]["ark"], "ark:/67531/metapth100001")
        self.assertIn("[cache]", r3.output)

    def test_portal_item_caches_and_refresh_bypasses(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, text=OAI_XML)

        with patch.object(tx, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(tx.cli, ["portal", "item", "metapth100001", "--json"], env=self.env)
            r2 = self.runner.invoke(tx.cli, ["portal", "item", "ark:/67531/metapth100001"], env=self.env)
            r_ref = self.runner.invoke(
                tx.cli, ["portal", "item", "metapth100001", "--refresh", "--json"], env=self.env
            )
            r_ttl = self.runner.invoke(
                tx.cli, ["portal", "item", "metapth100001", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r_ref.exit_code, 0, r_ref.output)
        self.assertEqual(r_ttl.exit_code, 0, r_ttl.output)
        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertIn("[cache]", r2.output)
        self.assertFalse(json.loads(r_ref.output)["cache_hit"])
        self.assertFalse(json.loads(r_ttl.output)["cache_hit"])

    def test_tda_caches_rss_and_slices_limit_locally(self) -> None:
        calls = 0

        def fake_curl(url: str) -> str:
            nonlocal calls
            calls += 1
            return TDA_RSS

        with patch.object(tx, "_curl_text", side_effect=fake_curl):
            r1 = self.runner.invoke(tx.cli, ["tda", "Houston", "--limit", "1", "--json"], env=self.env)
            r2 = self.runner.invoke(tx.cli, ["tda", "Houston", "--limit", "5", "--json"], env=self.env)
            r3 = self.runner.invoke(tx.cli, ["tda", "Houston"], env=self.env)
            r_ref = self.runner.invoke(tx.cli, ["tda", "Houston", "--refresh", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(r_ref.exit_code, 0, r_ref.output)
        self.assertEqual(calls, 2)
        self.assertEqual(json.loads(r1.output)["returned"], 1)
        d2 = json.loads(r2.output)
        self.assertTrue(d2["cache_hit"])
        self.assertEqual(d2["returned"], 2)
        self.assertIn("[cache]", r3.output)
        self.assertFalse(json.loads(r_ref.output)["cache_hit"])

    def test_errors_and_empty_payloads_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(500, text="server error")
            if calls == 2:
                return httpx.Response(200, text=OAI_ERROR_XML)
            if calls == 3:
                return httpx.Response(200, json={"feed": {"opensearch:totalResults": "0", "entry": []}})
            return httpx.Response(200, json=OPENSEARCH_PAYLOAD)

        with patch.object(tx, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(tx.cli, ["portal", "search", "Smith", "--pages", "1"], env=self.env)
            r2 = self.runner.invoke(tx.cli, ["portal", "item", "metapth999999"], env=self.env)
            r3 = self.runner.invoke(tx.cli, ["portal", "search", "Smith", "--pages", "1", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r4 = self.runner.invoke(tx.cli, ["portal", "search", "Smith", "--pages", "1", "--json"], env=self.env)

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
