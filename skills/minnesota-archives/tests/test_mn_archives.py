from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "mn_archives.py"


def load_module():
    loader = SourceFileLoader("mn_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("mn_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


mn = load_module()

SAMPLE_DEATH_RESPONSE = {
    "success": True,
    "data": {
        "totalHitCount": 1,
        "pageNum": 1,
        "pageSize": 25,
        "pageCount": 1,
        "hits": [
            {
                "id": "a96a5503-6d05-4bf7-9045-098ca3e7f6fa",
                "deathDateStart": "1916-07-09T00:00:00",
                "county": "Hennepin County",
                "certificateId": "1916-MN-007499",
                "firstName": "Arthur",
                "middleName": "E.",
                "familyName": "Alder",
                "mothersMaidenName": "Maple",
            }
        ],
    },
}

SAMPLE_BIRTH_RESPONSE = {
    "success": True,
    "data": {
        "totalHitCount": 1,
        "pageNum": 1,
        "pageSize": 25,
        "pageCount": 1,
        "hits": [
            {
                "id": "bd6df19c-2e99-4708-9813-cd16386cfd7f",
                "birthDateStart": "1920-01-03T00:00:00",
                "county": "Steele County",
                "certificateId": "DC-78215",
                "firstName": "Helen",
                "middleName": "M.",
                "familyName": "Maple",
                "mothersMaidenName": "Alder",
            }
        ],
    },
}

SAMPLE_CENSUS_RESPONSE = {
    "success": True,
    "data": {
        "totalHitCount": 1,
        "pageNum": 1,
        "pageSize": 25,
        "pageCount": 1,
        "hits": [
            {
                "id": "9d6c96ea-6374-426c-8213-aef509f3572b",
                "censusDateStart": "1895-01-01T00:00:00",
                "county": "Big Stone County",
                "locality": "Prior",
                "age": "15",
                "lineInImage": 38,
                "certificateId": "1895-mnv290_49-0661-38",
                "firstName": "Ezra",
                "familyName": "Maple",
            }
        ],
    },
}

SAMPLE_RECORD_DETAIL = {
    "success": True,
    "data": {
        "id": "a96a5503-6d05-4bf7-9045-098ca3e7f6fa",
        "deathDateStart": "1916-07-09T00:00:00",
        "county": "Hennepin County",
        "certificateId": "1916-MN-007499",
        "firstName": "Arthur",
        "middleName": "E.",
        "familyName": "Alder",
        "mothersMaidenName": "Maple",
    },
}

SAMPLE_NEWS_SEARCH_HTML = """
<html><head><script>var psRecCnt = 42;</script></head><body>
<table><tr>
<td class="ps-result-cell">
  <img class="ps-result-thumb" src="/servlet/PsObjThumb;jsessionid=ABC123?tnName=2802b576-860c-4805-9aea-e1c8bb675319%2Fmnhi0031%2F1H1BCU5B%2F18012301" />
  <a class="ps-result-title ps-truncated" title="Willmar tribune." href="/jsp/PsImageViewer.jsp;jsessionid=ABC123?doc_id=2802b576-860c-4805-9aea-e1c8bb675319%2Fmnhi0031%2F1H1BCU5B%2F18012301">Willmar tribune.</a>
  <div class="ps-result-detail">Publication Date:&nbsp;January 23, 1918</div>
</td>
</tr></table>
</body></html>
"""

SAMPLE_NEWS_METADATA_HTML = """
<html><body><div id="ps-metadata-div"><table id="ps-metadata-table">
<tr><td class="ps-md-field-label">Title</td><td class="ps-md-field-value">Willmar tribune.</td></tr>
<tr><td class="ps-md-field-label">Date Published</td><td class="ps-md-field-value">January 23, 1918</td></tr>
<tr><td class="ps-md-field-label">Subject-County</td><td class="ps-md-field-value">Kandiyohi</td></tr>
<tr><td class="ps-md-field-label">LCCN </td><td class="ps-md-field-value">sn89081022</td></tr>
</table></div></body></html>
"""

MINIMAL_JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"


class TestMnArchivesCli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.tmp.name) / "cache"
        self._env_patch = patch.dict(
            os.environ,
            {
                "KINLOOM_CACHE_DIR": str(self.cache_root),
            },
            clear=False,
        )
        self._env_patch.start()
        os.environ.pop("KINLOOM_MN_ARCHIVES_CACHE_DIR", None)
        os.environ.pop("KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS", None)

    def tearDown(self) -> None:
        self._env_patch.stop()
        self.tmp.cleanup()

    def _run(self, argv: list[str], handler=None) -> tuple[int, str, str]:
        out = io.StringIO()
        err = io.StringIO()
        if handler is None:
            with redirect_stdout(out), redirect_stderr(err):
                code = mn.main(argv)
            return code, out.getvalue(), err.getvalue()

        transport = httpx.MockTransport(handler)
        client_factory = lambda: httpx.Client(transport=transport, follow_redirects=True)
        with (
            patch.object(mn, "_client", client_factory),
            patch.object(mn.time, "sleep", lambda _s: None),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            code = mn.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_death_search_payload_and_disk_cache(self) -> None:
        seen_bodies: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.host, "www.mnhs.org")
            self.assertEqual(request.url.path, "/_hcms/api/death/getAllDeathRecords")
            seen_bodies.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(200, json=SAMPLE_DEATH_RESPONSE)

        args = [
            "death",
            "--last",
            "Alder",
            "--county",
            "Hennepin County",
            "--begin-year",
            "1910",
            "--end-year",
            "1920",
            "--json",
        ]
        code1, out1, err1 = self._run(args, handler)
        code2, out2, err2 = self._run(args, handler)
        code3, out3, err3 = self._run(args[:-1], handler)  # text output hits same cache
        code4, out4, err4 = self._run([*args, "--refresh"], handler)

        self.assertEqual(code1, 0, err1)
        self.assertEqual(code2, 0, err2)
        self.assertEqual(code3, 0, err3)
        self.assertEqual(code4, 0, err4)
        self.assertEqual(len(seen_bodies), 2)

        body = seen_bodies[0]
        self.assertEqual(
            body["filters"],
            [
                {"conjunction": "and", "filters": [{"field": "familyName", "term": "Alder", "op": "="}]},
                {"conjunction": "or", "filters": [{"field": "county", "term": "Hennepin.*", "op": "*"}]},
                {
                    "conjunction": "and",
                    "filters": [
                        {"field": "deathDateStart", "term": "1910-01-01", "op": ">="},
                        {"field": "deathDateStart", "term": "1920-12-31", "op": "<="},
                    ],
                },
            ],
        )

        p1 = json.loads(out1)
        p2 = json.loads(out2)
        p4 = json.loads(out4)
        self.assertFalse(p1["cache_hit"])
        self.assertTrue(p2["cache_hit"])
        self.assertFalse(p4["cache_hit"])
        self.assertEqual(p1["results"][0]["certificate_id"], "1916-MN-007499")
        self.assertEqual(p1["results"][0]["date"], "1916-07-09")
        self.assertIn("[cache]", out3)
        self.assertEqual(len(list((self.cache_root / "mn-archives").glob("*.json"))), 1)

    def test_birth_census_vets_and_record_detail(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path.endswith("getAllBirthRecords"):
                return httpx.Response(200, json=SAMPLE_BIRTH_RESPONSE)
            if request.url.path.endswith("getAllCensusRecords"):
                return httpx.Response(200, json=SAMPLE_CENSUS_RESPONSE)
            if request.url.path.endswith("getAllVetsGravesRecords"):
                body = json.loads(request.content.decode("utf-8"))
                # Verify Fort Snelling county augmentation for Hennepin vets-graves
                county_group = body["filters"][1]["filters"]
                self.assertEqual(
                    county_group,
                    [
                        {"field": "burialLocation", "term": "Hennepin.*", "op": "*"},
                        {"field": "burialLocation", "term": "Fort Snelling.*", "op": "*"},
                    ],
                )
                return httpx.Response(200, json={"success": True, "data": {"totalHitCount": 0, "hits": []}})
            if request.url.path.endswith("getDeathRecordById"):
                return httpx.Response(200, json=SAMPLE_RECORD_DETAIL)
            return httpx.Response(404)

        c_b, out_b, _ = self._run(["birth", "--last", "Maple", "--mother-maiden", "Alder", "--json"], handler)
        c_c, out_c, _ = self._run(["census", "--last", "Maple", "--begin-year", "1895", "--json"], handler)
        c_v, out_v, _ = self._run(["vets", "--last", "Maple", "--county", "Hennepin", "--json"], handler)
        c_r, out_r, _ = self._run(
            ["record", "a96a5503-6d05-4bf7-9045-098ca3e7f6fa", "--type", "death", "--json"], handler
        )

        self.assertEqual((c_b, c_c, c_v, c_r), (0, 0, 0, 0))
        self.assertEqual(json.loads(out_b)["results"][0]["mothers_maiden_name"], "Alder")
        self.assertEqual(json.loads(out_c)["results"][0]["locality"], "Prior")
        self.assertEqual(json.loads(out_v)["total"], 0)
        rec = json.loads(out_r)
        self.assertEqual(rec["summary"]["certificate_id"], "1916-MN-007499")
        self.assertEqual(
            rec["url"],
            "https://www.mnhs.org/search/people/record?uuid=a96a5503-6d05-4bf7-9045-098ca3e7f6fa&recordType=death-records",
        )

    def test_transient_retry_recovers_and_errors_are_never_cached(self) -> None:
        attempts = 0

        def flaky_handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, headers={"Retry-After": "0"})
            if attempts == 2:
                return httpx.Response(503)
            return httpx.Response(200, json=SAMPLE_DEATH_RESPONSE)

        code, out, err = self._run(["death", "--last", "Alder", "--json"], flaky_handler)
        self.assertEqual(code, 0, err)
        self.assertEqual(attempts, 3)
        self.assertFalse(json.loads(out)["cache_hit"])

        # Hard 500 on a new query fails cleanly and writes no cache file.
        def fail_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="internal error")

        before_files = set((self.cache_root / "mn-archives").glob("*.json"))
        fail_code, _fail_out, fail_err = self._run(["death", "--last", "Cedar", "--json"], fail_handler)
        after_files = set((self.cache_root / "mn-archives").glob("*.json"))
        self.assertEqual(fail_code, 1)
        self.assertIn("HTTP 500", fail_err)
        self.assertEqual(before_files, after_files)

    def test_newspapers_search_metadata_and_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if request.url.path == "/jsp/PsSearchResults.jsp":
                self.assertEqual(request.url.params["query1"], "Alder")
                self.assertEqual(request.url.params["query1_field"], "CONTENT")
                self.assertEqual(request.url.params["query2_field"], "DATE_PUBLISHED_MILLIS")
                return httpx.Response(200, text=SAMPLE_NEWS_SEARCH_HTML)
            if request.url.path == "/jsp/PsMetadata.jsp":
                return httpx.Response(200, text=SAMPLE_NEWS_METADATA_HTML)
            return httpx.Response(404)

        s1, so1, se1 = self._run(
            ["newspapers", "search", "Alder", "--begin-year", "1915", "--end-year", "1920", "--json"],
            handler,
        )
        s2, so2, se2 = self._run(
            ["newspapers", "search", "Alder", "--begin-year", "1915", "--end-year", "1920", "--json"],
            handler,
        )
        doc_id = "2802b576-860c-4805-9aea-e1c8bb675319/mnhi0031/1H1BCU5B/18012301"
        m1, mo1, me1 = self._run(["newspapers", "metadata", doc_id, "--json"], handler)
        m2, mo2, me2 = self._run(["newspapers", "metadata", doc_id, "--json"], handler)

        self.assertEqual((s1, s2, m1, m2), (0, 0, 0, 0), f"{se1} {se2} {me1} {me2}")
        self.assertEqual(calls, 2)
        search_payload = json.loads(so1)
        self.assertEqual(search_payload["total"], 42)
        self.assertFalse(search_payload["cache_hit"])
        self.assertTrue(json.loads(so2)["cache_hit"])
        self.assertEqual(search_payload["results"][0]["title"], "Willmar tribune.")
        self.assertEqual(search_payload["results"][0]["publication_date"], "January 23, 1918")
        self.assertEqual(search_payload["results"][0]["doc_id"], doc_id)

        meta_payload = json.loads(mo1)
        self.assertFalse(meta_payload["cache_hit"])
        self.assertTrue(json.loads(mo2)["cache_hit"])
        self.assertEqual(meta_payload["fields"]["Subject-County"], "Kandiyohi")
        self.assertEqual(meta_payload["fields"]["LCCN"], "sn89081022")

    def test_newspapers_download_validates_host_path_and_image_magic(self) -> None:
        doc_id = "2802b576-860c-4805-9aea-e1c8bb675319/mnhi0031/1H1BCU5B/18012301"
        out_jpg = Path(self.tmp.name) / "issue.jpg"

        # 1. Valid JPEG downloads cleanly and skips repeat download without --overwrite.
        calls = 0

        def jpeg_handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(
                200,
                content=MINIMAL_JPEG_BYTES,
                headers={"Content-Type": "image/jpeg"},
            )

        c1, o1, e1 = self._run(["newspapers", "download", doc_id, "--out", str(out_jpg), "--json"], jpeg_handler)
        c2, o2, e2 = self._run(["newspapers", "download", doc_id, "--out", str(out_jpg), "--json"], jpeg_handler)
        self.assertEqual((c1, c2), (0, 0), f"{e1} {e2}")
        self.assertEqual(calls, 1)
        self.assertEqual(json.loads(o1)["format"], "jpeg")
        self.assertFalse(json.loads(o1)["skipped"])
        self.assertTrue(json.loads(o2)["skipped"])
        self.assertEqual(out_jpg.read_bytes(), MINIMAL_JPEG_BYTES)

        # 2. HTML error page returned with HTTP 200 is NEVER saved as an image.
        bad_jpg = Path(self.tmp.name) / "html-trap.jpg"

        def html_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                text="<!DOCTYPE html><html><body>Error page</body></html>",
                headers={"Content-Type": "text/html; charset=utf-8"},
            )

        c_html, _o_html, e_html = self._run(
            ["newspapers", "download", doc_id, "--out", str(bad_jpg)],
            html_handler,
        )
        self.assertEqual(c_html, 1)
        self.assertIn("Refusing to save HTML", e_html)
        self.assertFalse(bad_jpg.exists())

        # 3. Non-allowlisted host and path traversal are rejected with exit code 2.
        c_host, _o_host, e_host = self._run(
            ["newspapers", "download", "https://example.invalid/thumb.jpg", "--out", str(bad_jpg)],
            jpeg_handler,
        )
        self.assertEqual(c_host, 2)
        self.assertIn("Refusing host", e_host)

        c_trav, _o_trav, e_trav = self._run(
            ["newspapers", "download", doc_id, "--out", "../escape.jpg"],
            jpeg_handler,
        )
        self.assertEqual(c_trav, 2)
        self.assertIn("traversal", e_trav)

    def test_mdl_browser_only_subcommand(self) -> None:
        code, out, err = self._run(["mdl", "--json"])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "browser-only")
        self.assertEqual(payload["home_url"], "https://collection.mndigital.org/")


if __name__ == "__main__":
    unittest.main()
