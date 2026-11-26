from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "nj-archives"


def load_nj_module():
    loader = SourceFileLoader("nj_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("nj_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


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


if __name__ == "__main__":
    unittest.main()
