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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "ky-archives"


def load_module():
    loader = SourceFileLoader("ky_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("ky_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_KY_ARCHIVES_CACHE_DIR"] = _TEST_CACHE.name

ky = load_module()

CDM_SEARCH_JSON = {
    "totalResults": 1,
    "items": [
        {
            "collectionAlias": "MS",
            "itemId": "101",
            "title": "Lincoln Family Papers",
            "filetype": "pdf",
            "itemLink": "/singleitem/collection/MS/id/101",
            "metadataFields": [{"field": "date", "value": "1845"}],
        }
    ],
}

CDM_ITEM_JSON = {
    "title": "Lincoln Family Papers",
    "contentType": "application/pdf",
    "fields": [{"key": "title", "label": "Title", "value": "Lincoln Family Papers"}],
}

LAND_FORM_HTML = (
    '<form><input name="__VIEWSTATE" value="vs1" />'
    '<input name="__VIEWSTATEGENERATOR" value="vg1" />'
    '<input name="__EVENTVALIDATION" value="ev1" /></form>'
)

LAND_RESULT_HTML = (
    "<div>1 Results found "
    "1) Patent #1234.0 Grantee: Lincoln, Thomas Grant Book &amp; Pg: 12 45 "
    "Acreage: 100 County: Hardin WaterCourse: Nolin Creek "
    "Survey Name: Thomas Lincoln Survey Date: 1838-05-01 Grant Date: 1839-01-10 "
    "Grant Note: none</div>"
)

RSS_XML = (
    "<rss><channel><item><title>Lincoln Pension Packet</title>"
    "<link>https://kdla.access.preservica.com/item/1</link></item></channel></rss>"
)


class TestKyArchivesCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_KY_ARCHIVES_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def test_cdm_and_cdm_item_cache_with_zero_repeat_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if "singleitem" in str(request.url):
                return httpx.Response(200, json=CDM_ITEM_JSON)
            return httpx.Response(200, json=CDM_SEARCH_JSON)

        with patch.object(ky, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(ky.cli, ["cdm", "Lincoln", "--json"], env=self.env)
            r2 = self.runner.invoke(ky.cli, ["cdm", "Lincoln", "--json"], env=self.env)
            r3 = self.runner.invoke(ky.cli, ["cdm", "Lincoln"], env=self.env)
            i1 = self.runner.invoke(ky.cli, ["cdm-item", "MS", "101", "--json"], env=self.env)
            i2 = self.runner.invoke(ky.cli, ["cdm-item", "MS", "101"], env=self.env)

        self.assertEqual(calls, 2)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertTrue(json.loads(r2.output)["cache_hit"])
        self.assertIn("[cache]", r3.output)
        self.assertFalse(json.loads(i1.output)["cache_hit"])
        self.assertIn("[cache]", i2.output)

    def test_land_and_preservica_cache_refresh_and_zero_ttl(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if "preservica" in str(request.url):
                return httpx.Response(200, text=RSS_XML)
            if request.method == "GET":
                return httpx.Response(200, text=LAND_FORM_HTML)
            if "LbAdvSearch" in request.content.decode("utf-8"):
                return httpx.Response(200, text=LAND_FORM_HTML)
            return httpx.Response(200, text=LAND_RESULT_HTML)

        with patch.object(ky, "_client", self._mock_client(handler)):
            l1 = self.runner.invoke(ky.cli, ["land", "Lincoln", "--json"], env=self.env)
            l2 = self.runner.invoke(ky.cli, ["land", "Lincoln", "--json"], env=self.env)
            l_ref = self.runner.invoke(ky.cli, ["land", "Lincoln", "--refresh", "--json"], env=self.env)
            p1 = self.runner.invoke(ky.cli, ["preservica", "Lincoln", "--json"], env=self.env)
            p2 = self.runner.invoke(ky.cli, ["preservica", "Lincoln"], env=self.env)
            p_ttl = self.runner.invoke(
                ky.cli, ["preservica", "Lincoln", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertFalse(json.loads(l1.output)["cache_hit"])
        self.assertTrue(json.loads(l2.output)["cache_hit"])
        self.assertFalse(json.loads(l_ref.output)["cache_hit"])
        self.assertFalse(json.loads(p1.output)["cache_hit"])
        self.assertIn("[cache]", p2.output)
        self.assertFalse(json.loads(p_ttl.output)["cache_hit"])
        self.assertEqual(calls, 8)  # 3 (land) + 3 (land refresh) + 1 (preservica) + 1 (ttl 0)

    def test_http_error_and_blocked_preservica_html_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(403, text="blocked")
            if calls == 2:
                return httpx.Response(200, text="<html><body>Rate limited</body></html>")
            return httpx.Response(200, text=RSS_XML)

        with patch.object(ky, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(ky.cli, ["preservica", "Lincoln"], env=self.env)
            r2 = self.runner.invoke(ky.cli, ["preservica", "Lincoln", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r3 = self.runner.invoke(ky.cli, ["preservica", "Lincoln", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 3)


if __name__ == "__main__":
    unittest.main()
