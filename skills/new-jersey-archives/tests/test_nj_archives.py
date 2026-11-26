from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from click.testing import CliRunner
import httpx


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "nj-archives"


def load_nj_module():
    loader = SourceFileLoader("nj_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("nj_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


# Never let a test read or write the real user cache: point every test at a
# throwaway directory before the CLI module loads. Tests that inspect the
# cache override this with their own temp dir.
_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_NJ_ARCHIVES_CACHE_DIR"] = _TEST_CACHE.name

nj = load_nj_module()

INDEX_HTML = (
    '<form action="./index.aspx">'
    '<input type="hidden" name="__VIEWSTATE" value="vs_idx" />'
    "</form>"
)

SEARCH_FORM_HTML = (
    '<form action="./DeathIndex1848.aspx">'
    '<input type="hidden" name="__VIEWSTATE" value="vs_form" />'
    '<select name="ctl00$ContentPlaceHolder1$ddlCountyList">'
    '<option value="">All</option>'
    '<option value="Hunterdon">Hunterdon</option>'
    '<option value="Mercer">Mercer</option>'
    "</select>"
    "</form>"
)

ONE_PAGE_RESULT_HTML = (
    '<form action="./DeathIndex1848.aspx">'
    '<input type="hidden" name="__VIEWSTATE" value="vs_res1" />'
    '<table id="ctl00_ContentPlaceHolder1_GridView1">'
    "<tr><th>Name</th><th>County</th><th>Date</th></tr>"
    "<tr><td>Lincoln, A.</td><td>Hunterdon County</td><td>April 1865</td></tr>"
    "</table>"
    "</form>"
)


class TestNjArchivesPaginationAndRetries(unittest.TestCase):
    def test_pagination_stops_cleanly_when_no_page2_link_exists(self) -> None:
        posted_events: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "GET":
                return httpx.Response(200, text=INDEX_HTML)
            body = request.content.decode("utf-8")
            if "lbtnColonialMarriages" in body:
                return httpx.Response(200, text=SEARCH_FORM_HTML)
            if "Page%242" in body or "Page$2" in body:
                posted_events.append(("page2", body))
                return httpx.Response(500, text="ASP.NET EventValidation error")
            posted_events.append(("search", body))
            return httpx.Response(200, text=ONE_PAGE_RESULT_HTML)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with nj.Portal(client=client) as portal:
                result = portal.search(
                    "deaths-1848-1878",
                    {"surname": "Lincoln", "county": "hunterdon county"},
                    pages=3,
                )

        self.assertEqual([ev[0] for ev in posted_events], ["search"])
        self.assertIn("ddlCountyList=Hunterdon", posted_events[0][1])
        self.assertEqual(result["pages_read"], 1)
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(result["rows"][0]["Name"], "Lincoln, A.")

    def test_transient_500_retries_once_and_recovers(self) -> None:
        search_posts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal search_posts
            if request.method == "GET":
                return httpx.Response(200, text=INDEX_HTML)
            body = request.content.decode("utf-8")
            if "lbtnColonialMarriages" in body:
                return httpx.Response(200, text=SEARCH_FORM_HTML)
            search_posts += 1
            if search_posts == 1:
                return httpx.Response(500, text="Transient IIS 500")
            return httpx.Response(200, text=ONE_PAGE_RESULT_HTML)

        with (
            patch.object(nj.time, "sleep", return_value=None),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            with nj.Portal(client=client) as portal:
                result = portal.search("deaths-1848-1878", {"surname": "Lincoln"}, pages=1)

        self.assertEqual(search_posts, 2)
        self.assertEqual(len(result["rows"]), 1)

    def test_parse_grid_skips_multicell_pager_row(self) -> None:
        html_with_pager = (
            '<table id="ctl00_ContentPlaceHolder1_GridView1">'
            "<tr><th>Name</th><th>Year</th></tr>"
            "<tr><td>Smith, John</td><td>1862</td></tr>"
            "<tr>"
            "<td><span>1</span></td>"
            '<td><a href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$GridView1&#39;,&#39;Page$2&#39;)">2</a></td>'
            '<td><a href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$GridView1&#39;,&#39;Page$3&#39;)">3</a></td>'
            "</tr>"
            "</table>"
        )
        headers, rows = nj.parse_grid(html_with_pager, "GridView1")
        self.assertEqual(headers, ["Name", "Year"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["Name"], "Smith, John")
        self.assertTrue(nj.has_page_link(html_with_pager, 2))
        self.assertFalse(nj.has_page_link(html_with_pager, 4))


class TestNjArchivesCacheAndAliases(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._env = patch.dict(os.environ, {"KINLOOM_NJ_ARCHIVES_CACHE_DIR": self._tmp.name})
        self._env.start()
        self.searches: list[tuple[str, dict, int]] = []

        def fake_search(portal, key, criteria, pages=1):
            self.searches.append((key, dict(criteria), pages))
            return {"database": key, "title": nj.DATABASES[key]["title"], "headers": ["Name"],
                    "rows": [{"Name": "Smith, John", "links": []}], "capped_500": False,
                    "pages_read": 1}

        self._patch = patch.object(nj.Portal, "search", fake_search)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._env.stop()
        self._tmp.cleanup()

    def invoke(self, *args: str):
        return CliRunner().invoke(nj.cli, ["search", *args])

    def test_repeat_search_is_served_from_disk_cache_quickly(self) -> None:
        first = self.invoke("land", "--surname", "Smith", "--json")
        t0 = time.monotonic()
        second = self.invoke("land", "--surname", "Smith", "--json")
        elapsed = time.monotonic() - t0

        self.assertEqual(first.exit_code, 0, first.output)
        self.assertEqual(second.exit_code, 0, second.output)
        self.assertEqual(len(self.searches), 1)
        self.assertFalse(json.loads(first.output)["cache_hit"])
        self.assertTrue(json.loads(second.output)["cache_hit"])
        self.assertEqual(json.loads(second.output)["rows"][0]["Name"], "Smith, John")
        self.assertLess(elapsed, 0.05)

    def test_refresh_and_distinct_criteria_bypass_cache(self) -> None:
        self.invoke("land", "--surname", "Smith")
        self.invoke("land", "--surname", "Smith", "--refresh")
        self.invoke("land", "--surname", "Smith", "--pages", "2")
        self.assertEqual(len(self.searches), 3)
        self.assertEqual(self.searches[2][2], 2)

    def test_text_output_marks_cache_hits(self) -> None:
        self.invoke("land", "--surname", "Smith")
        res = self.invoke("land", "--surname", "Smith")
        self.assertIn("[cache]", res.output)

    def test_database_aliases_resolve(self) -> None:
        for typed in ("marriages-colonial", "marriage-colonial", "Colonial_Marriages"):
            res = self.invoke(typed, "--surname", "Lincoln")
            self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual({s[0] for s in self.searches}, {"colonial-marriages"})

    def test_unknown_database_suggests_close_match_without_network(self) -> None:
        res = self.invoke("colonial-mariages", "--surname", "Lincoln")
        self.assertEqual(res.exit_code, 2)
        self.assertIn("Did you mean: colonial-marriages", res.output)
        self.assertEqual(self.searches, [])

    def test_spouse_only_search_allowed_on_marriage_databases(self) -> None:
        res = self.invoke("colonial-marriages", "--spouse-surname", "Lincoln", "--spouse-given", "Mary")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(self.searches[0][1]["spouse_surname"], "Lincoln")

    def test_surname_still_required_elsewhere_with_flag_aliases(self) -> None:
        missing = self.invoke("land", "--given", "John")
        self.assertEqual(missing.exit_code, 2)
        self.assertIn("--surname", missing.output)
        ok = self.invoke("land", "--last", "Smith", "--first", "John")
        self.assertEqual(ok.exit_code, 0, ok.output)
        self.assertEqual(self.searches[0][1]["given"], "John")

    def test_order_only_database_is_refused_with_url(self) -> None:
        res = self.invoke("probate", "--surname", "Smith")
        self.assertEqual(res.exit_code, 2)
        self.assertIn("ProbateRecordRequest.aspx", res.output)


if __name__ == "__main__":
    unittest.main()
