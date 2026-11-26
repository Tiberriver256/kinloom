from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from email.message import Message
import gzip
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "archive-org"


def load_archive_org_module():
    loader = SourceFileLoader("archive_org_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("archive_org_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


ao = load_archive_org_module()


SYNTHETIC_SCANDATA = b"""<?xml version="1.0" encoding="UTF-8"?>
<book>
  <pageData>
    <page leafNum="0"><pageType>Delete</pageType><addToAccessFormats>false</addToAccessFormats></page>
    <page leafNum="1"><pageType>Cover</pageType><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="2"><pageType>Title</pageType><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="3"><pageType>Normal</pageType><pageNumber>iv</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="4"><pageType>Normal</pageType><pageNumber>1</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
    <page leafNum="5"><pageType>Normal</pageType><pageNumber>2</pageNumber><addToAccessFormats>true</addToAccessFormats></page>
  </pageData>
</book>
"""


class FakeHttpResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeHttpResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


def make_http_error(url: str, code: int, retry_after: str | None = None) -> HTTPError:
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return HTTPError(url, code, f"HTTP {code}", headers, io.BytesIO(b""))


class TestArchiveOrgCachedGrepAndPage(unittest.TestCase):
    def test_parse_scandata_xml_handles_deleted_leaf_offset(self) -> None:
        idx = ao.parse_scandata_xml(SYNTHETIC_SCANDATA)
        self.assertEqual(idx["leaf_count"], 6)
        self.assertEqual(idx["access_leaf_count"], 5)
        self.assertEqual(idx["printed_to_bookreader"]["1"], 3)
        self.assertEqual(idx["printed_to_bookreader"]["2"], 4)
        self.assertEqual(idx["printed_to_bookreader_ci"]["iv"], 2)
        self.assertEqual(idx["bookreader_to_printed"]["3"], "1")
        self.assertEqual(idx["scandata_to_bookreader"]["4"], 3)
        self.assertEqual(idx["bookreader_to_scandata"]["3"], 4)

    def test_grep_populates_cache_skips_hocr_when_djvu_has_breaks_and_hits_cache(self) -> None:
        item_id = "synthetic_town_history_1892"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Synthetic Town History"},
            "files": [
                {"name": f"{item_id}_scandata.xml", "format": "Scandata"},
                {"name": f"{item_id}_djvu.txt", "format": "DjVuTXT"},
                {"name": f"{item_id}_hocr_searchtext.txt.gz", "format": "OCR Search Text"},
                {"name": f"{item_id}_hocr_pageindex.json.gz", "format": "OCR Page Index"},
            ],
        }
        fake_djvu = "\x0c".join(
            [
                "",
                "Cover Text",
                "Title Page: Gazetteer of Oakridge County",
                "Preface signed by Clara Barton on page iv.",
                "Page one records the 1848 mill survey at Oakridge Creek.\nFrederick Douglass spoke here.",
                "Page two lists ferry tolls across Maple River.",
            ]
        ).encode("utf-8")

        fetch_calls: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            fetch_calls.append(url)
            if url.endswith(f"/metadata/{item_id}"):
                return json.dumps(fake_meta).encode("utf-8")
            if url.endswith(f"/{item_id}_scandata.xml"):
                return SYNTHETIC_SCANDATA
            if url.endswith(f"/{item_id}_djvu.txt"):
                return fake_djvu
            raise AssertionError(f"Unexpected eager URL fetch: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    rc1 = ao.main(["grep", item_id, "--pattern", "Frederick Douglass", "--json"])
                self.assertEqual(rc1, 0)
                out1 = json.loads(buf1.getvalue())
                self.assertFalse(out1["cached"])
                self.assertFalse(out1["cache_hit"])
                self.assertEqual(out1["total_matches"], 1)
                # Only metadata, scandata, and _djvu.txt; zero hOCR downloads.
                self.assertEqual(len(fetch_calls), 3)
                self.assertFalse(any("hocr" in u for u in fetch_calls))
                hit = out1["hits"][0]
                self.assertEqual(hit["leaf"], 3)
                self.assertEqual(hit["scandata_leaf"], 4)
                self.assertEqual(hit["printed_page"], "1")
                self.assertEqual(
                    hit["image_url"],
                    f"https://archive.org/download/{item_id}/page/n3_s2.jpg",
                )
                self.assertFalse(hit["cached"])

                item_dir = Path(tmpdir) / item_id
                for fname in ("metadata.json", "scandata.xml", "page_index.json", "djvu.txt"):
                    self.assertTrue((item_dir / fname).is_file(), f"Missing cache file {fname}")

                # Second grep call makes zero HTTP requests.
                fetch_calls.clear()
                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(["grep", item_id, "--pattern", "Clara Barton", "--json"])
                self.assertEqual(rc2, 0)
                self.assertEqual(fetch_calls, [])
                out2 = json.loads(buf2.getvalue())
                self.assertTrue(out2["cached"])
                self.assertTrue(out2["cache_hit"])
                self.assertEqual(out2["hits"][0]["leaf"], 2)
                self.assertEqual(out2["hits"][0]["printed_page"], "iv")
                self.assertTrue(out2["hits"][0]["cached"])

                # --refresh forces fresh fetches and updates cached content.
                buf3 = io.StringIO()
                with patch("sys.stdout", buf3):
                    rc3 = ao.main(["grep", item_id, "--pattern", "Clara Barton", "--refresh", "--json"])
                self.assertEqual(rc3, 0)
                self.assertEqual(len(fetch_calls), 3)
                out3 = json.loads(buf3.getvalue())
                self.assertFalse(out3["cached"])

    def test_grep_falls_back_to_hocr_when_djvu_lacks_breaks_or_is_missing(self) -> None:
        pages = ["", "Cover", "Title", "Intro iv", "Page one alpha", "Page two Harriet Tubman"]
        joined = "".join(pages)
        offsets = []
        pos = 0
        for p in pages:
            offsets.append([pos, pos + len(p), 0, 0])
            pos += len(p)

        for case_name, include_djvu in (("flat_djvu", True), ("missing_djvu", False)):
            with self.subTest(case=case_name):
                item_id = f"synthetic_{case_name}_1901"
                files = [
                    {"name": f"{item_id}_scandata.xml", "format": "Scandata"},
                    {"name": f"{item_id}_hocr_searchtext.txt.gz", "format": "OCR Search Text"},
                    {"name": f"{item_id}_hocr_pageindex.json.gz", "format": "OCR Page Index"},
                ]
                if include_djvu:
                    files.append({"name": f"{item_id}_djvu.txt", "format": "DjVuTXT"})
                fake_meta = {"metadata": {"identifier": item_id, "title": "Synthetic"}, "files": files}
                seen_urls: list[str] = []

                def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
                    seen_urls.append(url)
                    if url.endswith(f"/metadata/{item_id}"):
                        return json.dumps(fake_meta).encode("utf-8")
                    if url.endswith(f"/{item_id}_scandata.xml"):
                        return SYNTHETIC_SCANDATA
                    if url.endswith(f"/{item_id}_djvu.txt"):
                        return b"Flat text with zero form feeds Harriet Tubman"
                    if url.endswith(f"/{item_id}_hocr_searchtext.txt.gz"):
                        return gzip.compress(joined.encode("utf-8"))
                    if url.endswith(f"/{item_id}_hocr_pageindex.json.gz"):
                        return gzip.compress(json.dumps(offsets).encode("utf-8"))
                    raise AssertionError(f"Unexpected URL: {url}")

                with tempfile.TemporaryDirectory() as tmpdir:
                    with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                        ao, "http_get_bytes", side_effect=fake_http_get_bytes
                    ):
                        buf = io.StringIO()
                        with patch("sys.stdout", buf):
                            rc = ao.main(["grep", item_id, "--pattern", "Harriet Tubman", "--json"])
                        self.assertEqual(rc, 0)
                        out = json.loads(buf.getvalue())
                        self.assertEqual(out["hits"][0]["leaf"], 4)
                        self.assertEqual(out["hits"][0]["scandata_leaf"], 5)
                        self.assertEqual(out["hits"][0]["printed_page"], "2")
                        self.assertTrue(any(u.endswith("_hocr_searchtext.txt.gz") for u in seen_urls))
                        self.assertTrue(any(u.endswith("_hocr_pageindex.json.gz") for u in seen_urls))

    def test_get_caches_metadata_and_refreshes_on_flag(self) -> None:
        item_id = "synthetic_get_item_1875"
        version = {"title": "First Edition Gazetteer"}
        fetch_calls: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            fetch_calls.append(url)
            if url.endswith(f"/metadata/{item_id}"):
                return json.dumps(
                    {
                        "metadata": {"identifier": item_id, "title": version["title"]},
                        "files": [{"name": f"{item_id}.pdf", "format": "Text PDF", "size": "123"}],
                    }
                ).encode("utf-8")
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    self.assertEqual(ao.main(["get", item_id, "--json"]), 0)
                self.assertEqual(json.loads(buf1.getvalue())["metadata"]["title"], "First Edition Gazetteer")
                self.assertFalse(json.loads(buf1.getvalue())["cache_hit"])
                self.assertEqual(len(fetch_calls), 1)
                self.assertTrue((Path(tmpdir) / item_id / "metadata.json").is_file())

                # Second call hits disk cache with zero HTTP requests.
                version["title"] = "Updated Edition Gazetteer"
                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    self.assertEqual(ao.main(["get", item_id, "--json"]), 0)
                self.assertEqual(json.loads(buf2.getvalue())["metadata"]["title"], "First Edition Gazetteer")
                self.assertTrue(json.loads(buf2.getvalue())["cache_hit"])
                self.assertEqual(len(fetch_calls), 1)

                # --refresh fetches updated metadata and overwrites metadata.json.
                buf3 = io.StringIO()
                with patch("sys.stdout", buf3):
                    self.assertEqual(ao.main(["get", item_id, "--refresh", "--json"]), 0)
                self.assertEqual(json.loads(buf3.getvalue())["metadata"]["title"], "Updated Edition Gazetteer")
                self.assertEqual(len(fetch_calls), 2)

    def test_page_caches_jpeg_and_respects_refresh(self) -> None:
        item_id = "synthetic_atlas_1888"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Synthetic Atlas"},
            "files": [{"name": f"{item_id}_scandata.xml", "format": "Scandata"}],
        }
        jpeg_state = {"bytes": b"\xff\xd8\xff\xe0" + b"\x01" * 64}
        seen_urls: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            seen_urls.append(url)
            if url.endswith(f"/metadata/{item_id}"):
                return json.dumps(fake_meta).encode("utf-8")
            if url.endswith(f"/{item_id}_scandata.xml"):
                return SYNTHETIC_SCANDATA
            if "/page/n" in url:
                return jpeg_state["bytes"]
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            out_file1 = Path(tmpdir) / "page2_first.jpg"
            out_file2 = Path(tmpdir) / "page2_second.jpg"
            legacy_dir = Path(tmpdir) / "legacy_out"
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    rc1 = ao.main(
                        ["page", item_id, "--printed-page", "2", "--scale", "2", "--out", str(out_file1), "--json"]
                    )
                self.assertEqual(rc1, 0)
                payload1 = json.loads(buf1.getvalue())
                self.assertEqual(payload1["leaf"], 4)
                self.assertEqual(payload1["scandata_leaf"], 5)
                self.assertEqual(payload1["printed_page"], "2")
                self.assertEqual(payload1["url"], f"https://archive.org/download/{item_id}/page/n4_s2.jpg")
                self.assertFalse(payload1["page_cached"])
                self.assertFalse(payload1["cache_hit"])
                self.assertEqual(out_file1.read_bytes(), jpeg_state["bytes"])
                self.assertTrue((Path(tmpdir) / item_id / "pages" / "n4_s2.jpg").is_file())
                call_count_after_first = len(seen_urls)
                self.assertEqual(call_count_after_first, 3)

                # Second call to same page (different --out path) makes zero HTTP calls.
                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(
                        ["page", item_id, "--printed-page", "2", "--scale", "2", "--out", str(out_file2), "--json"]
                    )
                self.assertEqual(rc2, 0)
                self.assertEqual(len(seen_urls), call_count_after_first)
                payload2 = json.loads(buf2.getvalue())
                self.assertTrue(payload2["index_cached"])
                self.assertTrue(payload2["page_cached"])
                self.assertTrue(payload2["cache_hit"])
                self.assertEqual(out_file2.read_bytes(), jpeg_state["bytes"])

                # Text output reports cache-hit on cached leaf fetch.
                buf_txt = io.StringIO()
                with patch("sys.stdout", buf_txt):
                    rc_txt = ao.main(["page", item_id, "--leaf", "4", "--scale", "2", "--out", str(out_file2)])
                self.assertEqual(rc_txt, 0)
                self.assertIn("cache-hit", buf_txt.getvalue())
                self.assertEqual(len(seen_urls), call_count_after_first)

                # --refresh forces fresh page JPEG fetch and updates cache.
                jpeg_state["bytes"] = b"\xff\xd8\xff\xe0" + b"\x02" * 80
                buf_ref = io.StringIO()
                with patch("sys.stdout", buf_ref):
                    rc_ref = ao.main(
                        ["page", item_id, "--leaf", "4", "--scale", "2", "--out", str(out_file2), "--refresh", "--json"]
                    )
                self.assertEqual(rc_ref, 0)
                payload_ref = json.loads(buf_ref.getvalue())
                self.assertFalse(payload_ref["page_cached"])
                self.assertEqual(len(seen_urls), call_count_after_first + 1)
                self.assertEqual(out_file2.read_bytes(), jpeg_state["bytes"])

                # Legacy positional leaf + --width + directory --out caches n3_w1200.jpg.
                buf3 = io.StringIO()
                with patch("sys.stdout", buf3):
                    rc3 = ao.main(["page", item_id, "3", "--width", "1200", "--out", str(legacy_dir)])
                self.assertEqual(rc3, 0)
                expected_legacy = legacy_dir / f"{item_id}_n3_w1200.jpg"
                self.assertTrue(expected_legacy.is_file())
                self.assertTrue((Path(tmpdir) / item_id / "pages" / "n3_w1200.jpg").is_file())
                self.assertIn(f"https://archive.org/download/{item_id}/page/n3_w1200.jpg", seen_urls)

    def test_page_batch_is_parallel_bounded_and_cached_repeat_hits(self) -> None:
        item_id = "synthetic_city_directory_1894"
        leaves = [5, 1, 3, 8, 2, 6]
        state = {"inflight": 0, "max": 0}
        lock = threading.Lock()
        seen: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            if "/page/n" not in url:
                raise AssertionError(f"Unexpected URL: {url}")
            with lock:
                state["inflight"] += 1
                state["max"] = max(state["max"], state["inflight"])
                seen.append(url)
            try:
                time.sleep(0.25)
                match = re.search(r"/page/n(\d+)_", url)
                assert match is not None
                leaf = int(match.group(1))
                return b"\xff\xd8" + bytes([leaf]) + (b"\x00" * 24)
            finally:
                with lock:
                    state["inflight"] -= 1

        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir) / "pages"
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    rc1 = ao.main(
                        ["page", item_id, "--leaves", "5,1,3,8,2,6", "--scale", "2", "--out", str(out_dir), "--json"]
                    )
                self.assertEqual(rc1, 0)
                payload1 = json.loads(buf1.getvalue())
                self.assertEqual(payload1["count"], 6)
                self.assertFalse(payload1["cache_hit"])
                self.assertEqual([page["leaf"] for page in payload1["pages"]], leaves)
                self.assertEqual([page["page_cached"] for page in payload1["pages"]], [False] * 6)
                for page in payload1["pages"]:
                    leaf = page["leaf"]
                    self.assertEqual(Path(page["path"]).read_bytes(), b"\xff\xd8" + bytes([leaf]) + (b"\x00" * 24))
                    self.assertTrue(page["path"].endswith(f"{item_id}_n{leaf}_s2.jpg"))
                self.assertGreaterEqual(state["max"], 2)
                self.assertLessEqual(state["max"], ao.PAGE_BATCH_WORKERS)
                self.assertEqual(len(seen), 6)
                calls_after_miss = len(seen)

                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(
                        ["page", item_id, "--leaves", "5,1,3,8,2,6", "--scale", "2", "--out", str(out_dir), "--json"]
                    )
                self.assertEqual(rc2, 0)
                payload2 = json.loads(buf2.getvalue())
                self.assertTrue(payload2["cache_hit"])
                self.assertEqual([page["page_cached"] for page in payload2["pages"]], [True] * 6)
                self.assertEqual(len(seen), calls_after_miss)

                buf_range = io.StringIO()
                with patch("sys.stdout", buf_range):
                    rc_range = ao.main(
                        ["page", item_id, "--leaves", "1-3,5", "--scale", "2", "--out", str(out_dir), "--json"]
                    )
                self.assertEqual(rc_range, 0, buf_range.getvalue())
                ranged = json.loads(buf_range.getvalue())
                self.assertEqual([page["leaf"] for page in ranged["pages"]], [1, 2, 3, 5])
                self.assertTrue(ranged["cache_hit"])
                self.assertEqual(len(seen), calls_after_miss)

                err = io.StringIO()
                with patch("sys.stderr", err):
                    with self.assertRaises(SystemExit) as conflict:
                        ao.main(["page", item_id, "--leaf", "1", "--leaves", "2,3", "--out", str(out_dir)])
                self.assertEqual(conflict.exception.code, 2)
                self.assertIn("--leaves", err.getvalue())

                err_both = io.StringIO()
                with patch("sys.stderr", err_both):
                    with self.assertRaises(SystemExit) as both:
                        ao.main(["page", item_id, "--leaves", "1,2", "--printed-pages", "1,2", "--out", str(out_dir)])
                self.assertEqual(both.exception.code, 2)
                self.assertIn("--printed-pages", err_both.getvalue())

                err_jpg = io.StringIO()
                with patch("sys.stderr", err_jpg):
                    with self.assertRaises(SystemExit) as jpg:
                        ao.main(["page", item_id, "--leaves", "1,2", "--out", str(Path(tmpdir) / "batch.jpg")])
                self.assertEqual(jpg.exception.code, 2)
                self.assertIn("directory", err_jpg.getvalue())
                self.assertFalse((Path(tmpdir) / "batch.jpg").exists())

                err_cap = io.StringIO()
                with patch("sys.stderr", err_cap):
                    with self.assertRaises(SystemExit) as cap:
                        ao.main(["page", item_id, "--leaves", "0-25", "--out", str(out_dir)])
                self.assertEqual(cap.exception.code, 2)
                self.assertIn("25", err_cap.getvalue())
                self.assertEqual(len(seen), calls_after_miss)

                err_range = io.StringIO()
                with patch("sys.stderr", err_range):
                    with self.assertRaises(SystemExit) as bad_range:
                        ao.main(["page", item_id, "--leaves", "4-2", "--out", str(out_dir)])
                self.assertEqual(bad_range.exception.code, 2)
                self.assertIn("precedes", err_range.getvalue())

    def test_printed_pages_range_resolves_once_and_second_call_is_a_cache_hit(self) -> None:
        item_id = "synthetic_atlas_pages_1888"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Synthetic Atlas"},
            "files": [{"name": f"{item_id}_scandata.xml", "format": "Scandata"}],
        }
        seen: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            seen.append(url)
            if url.endswith(f"/metadata/{item_id}"):
                return json.dumps(fake_meta).encode("utf-8")
            if url.endswith(f"/{item_id}_scandata.xml"):
                return SYNTHETIC_SCANDATA
            if "/page/n" in url:
                match = re.search(r"/page/n(\d+)_", url)
                assert match is not None
                return b"\xff\xd8" + bytes([int(match.group(1))]) + (b"\xab" * 16)
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir) / "printed"
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    rc1 = ao.main(
                        ["page", item_id, "--printed-pages", "1-2", "--scale", "2", "--out", str(out_dir), "--json"]
                    )
                self.assertEqual(rc1, 0, buf1.getvalue())
                payload1 = json.loads(buf1.getvalue())
                self.assertEqual(payload1["count"], 2)
                self.assertFalse(payload1["cache_hit"])
                self.assertEqual([page["printed_page"] for page in payload1["pages"]], ["1", "2"])
                self.assertEqual([page["leaf"] for page in payload1["pages"]], [3, 4])
                self.assertEqual([page["scandata_leaf"] for page in payload1["pages"]], [4, 5])
                self.assertEqual(sum(1 for url in seen if url.endswith(f"/metadata/{item_id}")), 1)
                self.assertEqual(sum(1 for url in seen if url.endswith("_scandata.xml")), 1)
                calls_after_miss = len(seen)

                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(
                        ["page", item_id, "--printed-pages", "1,2", "--scale", "2", "--out", str(out_dir), "--json"]
                    )
                self.assertEqual(rc2, 0, buf2.getvalue())
                payload2 = json.loads(buf2.getvalue())
                self.assertTrue(payload2["cache_hit"])
                self.assertEqual(payload2["count"], 2)
                self.assertEqual(len(seen), calls_after_miss)
                self.assertEqual(Path(payload2["pages"][0]["path"]).read_bytes()[:2], b"\xff\xd8")

                buf_single = io.StringIO()
                with patch("sys.stdout", buf_single):
                    rc_single = ao.main(
                        ["page", item_id, "--printed-page", "2", "--scale", "2", "--out", str(out_dir / "one.jpg"), "--json"]
                    )
                self.assertEqual(rc_single, 0, buf_single.getvalue())
                single = json.loads(buf_single.getvalue())
                self.assertEqual(single["leaf"], 4)
                self.assertNotIn("count", single)
                self.assertTrue(single["cache_hit"])
                self.assertEqual(len(seen), calls_after_miss)

    def test_download_caches_files_reuses_metadata_and_artifacts_and_rejects_traversal(self) -> None:
        item_id = "synthetic_county_record_1865"
        pdf_bytes = {"data": b"%PDF-1.4 synthetic county record v1"}
        djvu_bytes = b"Page zero\x0cPage one Oakridge\x0cPage two"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "County Record"},
            "files": [
                {"name": f"{item_id}_scandata.xml", "format": "Scandata", "size": str(len(SYNTHETIC_SCANDATA))},
                {"name": f"{item_id}_djvu.txt", "format": "DjVuTXT", "size": str(len(djvu_bytes))},
                {"name": f"{item_id}.pdf", "format": "Text PDF", "size": str(len(pdf_bytes["data"]))},
                {"name": "../evil.txt", "format": "Text", "size": "4"},
            ],
        }
        fetch_calls: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            fetch_calls.append(url)
            if url.endswith(f"/metadata/{item_id}"):
                return json.dumps(fake_meta).encode("utf-8")
            if url.endswith(f"/{item_id}_scandata.xml"):
                return SYNTHETIC_SCANDATA
            if url.endswith(f"/{item_id}_djvu.txt"):
                return djvu_bytes
            if url.endswith(f"/{item_id}.pdf"):
                return pdf_bytes["data"]
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            out1 = Path(tmpdir) / "out1"
            out2 = Path(tmpdir) / "out2"
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                # Populate metadata + scandata + djvu via grep first.
                with patch("sys.stdout", io.StringIO()):
                    self.assertEqual(ao.main(["grep", item_id, "--pattern", "Oakridge", "--json"]), 0)
                self.assertEqual(len(fetch_calls), 3)

                # Downloading scandata.xml and _djvu.txt reuses cached item artifacts with zero HTTP calls.
                fetch_calls.clear()
                buf_reuse = io.StringIO()
                with patch("sys.stdout", buf_reuse):
                    rc = ao.main(
                        [
                            "download",
                            item_id,
                            f"{item_id}_scandata.xml",
                            f"{item_id}_djvu.txt",
                            "--out",
                            str(out1),
                        ]
                    )
                self.assertEqual(rc, 0)
                self.assertEqual(fetch_calls, [])
                self.assertEqual((out1 / f"{item_id}_scandata.xml").read_bytes(), SYNTHETIC_SCANDATA)
                self.assertEqual((out1 / f"{item_id}_djvu.txt").read_bytes(), djvu_bytes)
                self.assertIn("cache-hit", buf_reuse.getvalue())

                # Downloading PDF fetches once into files/<name>, reusing cached metadata.json.
                buf_pdf1 = io.StringIO()
                with patch("sys.stdout", buf_pdf1):
                    self.assertEqual(ao.main(["download", item_id, f"{item_id}.pdf", "--out", str(out1)]), 0)
                self.assertEqual(len(fetch_calls), 1)
                self.assertTrue(fetch_calls[0].endswith(f"/{item_id}.pdf"))
                self.assertTrue((Path(tmpdir) / item_id / "files" / f"{item_id}.pdf").is_file())
                self.assertEqual((out1 / f"{item_id}.pdf").read_bytes(), pdf_bytes["data"])

                # Second download of PDF into another directory makes zero HTTP calls.
                fetch_calls.clear()
                buf_pdf2 = io.StringIO()
                with patch("sys.stdout", buf_pdf2):
                    self.assertEqual(ao.main(["download", item_id, f"{item_id}.pdf", "--out", str(out2)]), 0)
                self.assertEqual(fetch_calls, [])
                self.assertEqual((out2 / f"{item_id}.pdf").read_bytes(), pdf_bytes["data"])
                self.assertIn("cache-hit", buf_pdf2.getvalue())

                # --refresh re-fetches metadata and PDF and updates cache.
                pdf_bytes["data"] = b"%PDF-1.4 synthetic county record v2"
                buf_ref = io.StringIO()
                with patch("sys.stdout", buf_ref):
                    self.assertEqual(
                        ao.main(["download", item_id, f"{item_id}.pdf", "--out", str(out2), "--refresh"]), 0
                    )
                self.assertEqual(len(fetch_calls), 2)
                self.assertEqual((out2 / f"{item_id}.pdf").read_bytes(), pdf_bytes["data"])

                # Path traversal filenames are rejected with exit code 2 and zero HTTP calls.
                fetch_calls.clear()
                for bad_name in ("../evil.txt", "/etc/passwd", "sub/../../escape.txt", "a\\b.txt", "C:drive.txt"):
                    err_buf = io.StringIO()
                    with patch("sys.stderr", err_buf):
                        with self.assertRaises(SystemExit) as cm:
                            ao.main(["download", item_id, bad_name, "--out", str(out2)])
                    self.assertEqual(cm.exception.code, 2, f"Expected exit 2 for {bad_name!r}")
                    self.assertIn("Unsafe file path", err_buf.getvalue())
                self.assertEqual(fetch_calls, [])

    def test_search_and_fulltext_cache_with_ttl_and_refresh(self) -> None:
        search_version = {"numFound": 1}
        ft_version = {"total": 2}
        fetch_calls: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 45.0) -> bytes:
            fetch_calls.append(url)
            if "advancedsearch.php" in url:
                return json.dumps(
                    {
                        "responseHeader": {"status": 0},
                        "response": {
                            "numFound": search_version["numFound"],
                            "docs": [{"identifier": "demo_book_1", "title": "Demo Book"}],
                        },
                    }
                ).encode("utf-8")
            if "page_production" in url:
                return json.dumps(
                    {
                        "response": {
                            "body": {
                                "hits": {
                                    "total": ft_version["total"],
                                    "hits": [
                                        {
                                            "fields": {"identifier": "demo_book_1", "title": "Demo Book", "year": 1890},
                                            "highlight": {"text": ["Sample {{{Oakridge}}} match"]},
                                        }
                                    ],
                                }
                            }
                        }
                    }
                ).encode("utf-8")
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                # search: first call fetches, second hits cache, --refresh fetches again.
                buf_s1 = io.StringIO()
                with patch("sys.stdout", buf_s1):
                    self.assertEqual(ao.main(["search", "title:(Oakridge)", "--json"]), 0)
                self.assertEqual(json.loads(buf_s1.getvalue())["response"]["numFound"], 1)
                self.assertFalse(json.loads(buf_s1.getvalue())["cache_hit"])
                self.assertEqual(len(fetch_calls), 1)
                self.assertEqual(len(list((Path(tmpdir) / "_queries" / "search").glob("*.json"))), 1)

                search_version["numFound"] = 9
                buf_s2 = io.StringIO()
                with patch("sys.stdout", buf_s2):
                    self.assertEqual(ao.main(["search", "title:(Oakridge)", "--json"]), 0)
                self.assertEqual(json.loads(buf_s2.getvalue())["response"]["numFound"], 1)
                self.assertTrue(json.loads(buf_s2.getvalue())["cache_hit"])
                self.assertEqual(len(fetch_calls), 1)

                buf_s3 = io.StringIO()
                with patch("sys.stdout", buf_s3):
                    self.assertEqual(ao.main(["search", "title:(Oakridge)", "--refresh", "--json"]), 0)
                self.assertEqual(json.loads(buf_s3.getvalue())["response"]["numFound"], 9)
                self.assertFalse(json.loads(buf_s3.getvalue())["cache_hit"])
                self.assertEqual(len(fetch_calls), 2)

                # fulltext: first call fetches, second hits cache, TTL=0 bypasses cache.
                fetch_calls.clear()
                buf_f1 = io.StringIO()
                with patch("sys.stdout", buf_f1):
                    self.assertEqual(ao.main(["fulltext", '"Oakridge Mill"', "--json"]), 0)
                self.assertEqual(json.loads(buf_f1.getvalue())["response"]["body"]["hits"]["total"], 2)
                self.assertFalse(json.loads(buf_f1.getvalue())["cache_hit"])
                self.assertEqual(len(fetch_calls), 1)
                self.assertEqual(len(list((Path(tmpdir) / "_queries" / "fulltext").glob("*.json"))), 1)

                ft_version["total"] = 7
                buf_f2 = io.StringIO()
                with patch("sys.stdout", buf_f2):
                    self.assertEqual(ao.main(["fulltext", '"Oakridge Mill"', "--json"]), 0)
                self.assertEqual(json.loads(buf_f2.getvalue())["response"]["body"]["hits"]["total"], 2)
                self.assertTrue(json.loads(buf_f2.getvalue())["cache_hit"])
                self.assertEqual(len(fetch_calls), 1)

                buf_f3 = io.StringIO()
                with patch("sys.stdout", buf_f3):
                    self.assertEqual(
                        ao.main(["fulltext", '"Oakridge Mill"', "--cache-ttl-hours", "0", "--json"]), 0
                    )
                self.assertEqual(json.loads(buf_f3.getvalue())["response"]["body"]["hits"]["total"], 7)
                self.assertEqual(len(fetch_calls), 2)

                # Stale cache entry older than TTL triggers fresh fetch.
                ft_cache_file = next((Path(tmpdir) / "_queries" / "fulltext").glob("*.json"))
                envelope = json.loads(ft_cache_file.read_text(encoding="utf-8"))
                envelope["cached_at"] = time.time() - (200 * 3600)
                ft_cache_file.write_text(json.dumps(envelope), encoding="utf-8")

                ft_version["total"] = 11
                buf_f4 = io.StringIO()
                with patch("sys.stdout", buf_f4):
                    self.assertEqual(ao.main(["fulltext", '"Oakridge Mill"', "--json"]), 0)
                self.assertEqual(json.loads(buf_f4.getvalue())["response"]["body"]["hits"]["total"], 11)
                self.assertEqual(len(fetch_calls), 3)

    def test_http_get_bytes_retries_429_503_politely_and_fails_fast_on_403_404_timeout(self) -> None:
        url = "https://archive.org/metadata/demo_item"

        # 429 (Retry-After: 12 capped to 5.0) -> 503 (Retry-After: 1.5) -> 200 OK.
        attempts = {"count": 0}
        sleeps: list[float] = []

        def fake_urlopen_retry(req, timeout=25.0):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise make_http_error(url, 429, retry_after="12")
            if attempts["count"] == 2:
                raise make_http_error(url, 503, retry_after="1.5")
            return FakeHttpResponse(b'{"ok":true}')

        with patch("urllib.request.urlopen", side_effect=fake_urlopen_retry), patch.object(
            ao.time, "sleep", side_effect=sleeps.append
        ):
            data = ao.http_get_bytes(url)
        self.assertEqual(data, b'{"ok":true}')
        self.assertEqual(attempts["count"], 3)
        self.assertEqual(sleeps, [5.0, 1.5])

        # 504 exhausts max 2 retries (3 total attempts) and raises RuntimeError.
        attempts["count"] = 0
        sleeps.clear()

        def fake_urlopen_504(req, timeout=25.0):
            attempts["count"] += 1
            raise make_http_error(url, 504)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen_504), patch.object(
            ao.time, "sleep", side_effect=sleeps.append
        ):
            with self.assertRaises(RuntimeError) as cm:
                ao.http_get_bytes(url)
        self.assertIn("HTTP 504", str(cm.exception))
        self.assertEqual(attempts["count"], 3)
        self.assertEqual(sleeps, [0.5, 1.0])

        # 403 fails immediately with 0 retries.
        attempts["count"] = 0
        sleeps.clear()

        def fake_urlopen_403(req, timeout=25.0):
            attempts["count"] += 1
            raise make_http_error(url, 403)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen_403), patch.object(
            ao.time, "sleep", side_effect=sleeps.append
        ):
            with self.assertRaises(RuntimeError) as cm:
                ao.http_get_bytes(url)
        self.assertIn("HTTP 403", str(cm.exception))
        self.assertEqual(attempts["count"], 1)
        self.assertEqual(sleeps, [])

        # 404 fails immediately with FileNotFoundError and 0 retries.
        attempts["count"] = 0
        sleeps.clear()

        def fake_urlopen_404(req, timeout=25.0):
            attempts["count"] += 1
            raise make_http_error(url, 404)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen_404), patch.object(
            ao.time, "sleep", side_effect=sleeps.append
        ):
            with self.assertRaises(FileNotFoundError):
                ao.http_get_bytes(url)
        self.assertEqual(attempts["count"], 1)
        self.assertEqual(sleeps, [])

        # ReadTimeout / TimeoutError fails immediately with 0 retries.
        attempts["count"] = 0
        sleeps.clear()

        def fake_urlopen_timeout(req, timeout=25.0):
            attempts["count"] += 1
            raise TimeoutError("The read operation timed out")

        with patch("urllib.request.urlopen", side_effect=fake_urlopen_timeout), patch.object(
            ao.time, "sleep", side_effect=sleeps.append
        ):
            with self.assertRaises(RuntimeError) as cm:
                ao.http_get_bytes(url)
        self.assertIn("timed out", str(cm.exception))
        self.assertEqual(attempts["count"], 1)
        self.assertEqual(sleeps, [])

    def test_concurrent_page_requests_deduplicate_via_item_lock(self) -> None:
        item_id = "synthetic_concurrent_book_1880"
        jpeg_bytes = b"\xff\xd8\xff\xe0" + b"\x09" * 48
        fetch_count = 0
        count_lock = threading.Lock()
        barrier = threading.Barrier(4)

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            nonlocal fetch_count
            time.sleep(0.05)
            with count_lock:
                fetch_count += 1
            return jpeg_bytes

        with tempfile.TemporaryDirectory() as tmpdir:
            cache_root = Path(tmpdir)
            url = ao.page_image_url(item_id, 7, width=2400)

            def worker(_idx: int) -> tuple[bytes, bool]:
                barrier.wait(timeout=5.0)
                content, _, cached = ao.ensure_page_image_cache(
                    item_id, 7, "w2400", url, cache_root=cache_root
                )
                return content, cached

            with patch.object(ao, "http_get_bytes", side_effect=fake_http_get_bytes):
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(worker, range(4)))

            self.assertEqual(fetch_count, 1)
            self.assertEqual([r[0] for r in results], [jpeg_bytes] * 4)
            self.assertEqual(sum(1 for _, cached in results if not cached), 1)
            self.assertEqual(sum(1 for _, cached in results if cached), 3)


SYNTHETIC_TEXT_PAGES = [
    "",
    "Cover Text",
    "Title Page: Gazetteer of Oakridge County",
    "Preface signed by Clara Barton on page iv.",
    "Page one records the 1848 mill survey at Oakridge Creek.",
    "Page two lists ferry tolls across Maple River.",
]


class TestArchiveOrgTextAndLookup(unittest.TestCase):
    def make_fake_http(self, item_id: str, djvu_pages: list[str], seen: list[str]):
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Synthetic Gazetteer"},
            "files": [
                {"name": f"{item_id}_scandata.xml", "format": "Scandata"},
                {"name": f"{item_id}_djvu.txt", "format": "DjVuTXT"},
            ],
        }

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            seen.append(url)
            if "/page/n" in url or url.endswith(".jpg"):
                raise AssertionError(f"JPEG must not be fetched: {url}")
            if url.endswith(f"/metadata/{item_id}"):
                return json.dumps(fake_meta).encode("utf-8")
            if url.endswith(f"/{item_id}_scandata.xml"):
                return SYNTHETIC_SCANDATA
            if url.endswith(f"/{item_id}_djvu.txt"):
                return "\x0c".join(djvu_pages).encode("utf-8")
            raise AssertionError(f"Unexpected URL: {url}")

        return fake_http_get_bytes

    def run_cli(self, argv: list[str]) -> tuple[int, str]:
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = ao.main(argv)
        return rc, buf.getvalue()

    def run_cli_error(self, argv: list[str]) -> tuple[int, str]:
        err = io.StringIO()
        with patch("sys.stderr", err), patch("sys.stdout", io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                ao.main(argv)
        return int(cm.exception.code), err.getvalue()

    def test_text_printed_page_caches_and_refreshes_without_jpeg(self) -> None:
        item_id = "synthetic_text_gazetteer_1890"
        seen: list[str] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=self.make_fake_http(item_id, SYNTHETIC_TEXT_PAGES, seen)
            ):
                rc, out = self.run_cli(["text", item_id, "--printed-page", "1", "--json"])
                self.assertEqual(rc, 0)
                payload = json.loads(out)
                self.assertEqual(payload["identifier"], item_id)
                self.assertFalse(payload["cached"])
                self.assertEqual(len(payload["pages"]), 1)
                page = payload["pages"][0]
                self.assertEqual(page["leaf"], 3)
                self.assertEqual(page["scandata_leaf"], 4)
                self.assertEqual(page["printed_page"], "1")
                self.assertIn("1848 mill survey", page["text"])
                self.assertEqual(page["image_url"], f"https://archive.org/download/{item_id}/page/n3_s2.jpg")
                self.assertEqual(page["details_url"], f"https://archive.org/details/{item_id}/page/n3")
                self.assertEqual(len(seen), 3)
                self.assertFalse(any("/page/n" in u for u in seen))
                self.assertFalse((Path(tmpdir) / item_id / "pages").exists())

                # Cache hit: zero HTTP requests, leaf selector works.
                seen.clear()
                rc, out = self.run_cli(["text", item_id, "--leaf", "0", "--json"])
                self.assertEqual(rc, 0)
                payload = json.loads(out)
                self.assertTrue(payload["cached"])
                self.assertEqual(payload["pages"][0]["text"], "Cover Text")
                self.assertEqual(payload["pages"][0]["scandata_leaf"], 1)
                self.assertIsNone(payload["pages"][0]["printed_page"])
                self.assertEqual(seen, [])

                # Human-readable output includes metadata and URLs.
                rc, out = self.run_cli(["text", item_id, "--printed-page", "IV"])
                self.assertEqual(rc, 0)
                self.assertIn("n2 (p.iv, scandata leaf 3)", out)
                self.assertIn(f"https://archive.org/download/{item_id}/page/n2_s2.jpg", out)
                self.assertIn("Clara Barton", out)
                self.assertEqual(seen, [])

                # --refresh re-fetches metadata, scandata, and OCR text (still no JPEG).
                rc, out = self.run_cli(["text", item_id, "--printed-page", "2", "--refresh", "--json"])
                self.assertEqual(rc, 0)
                self.assertFalse(json.loads(out)["cached"])
                self.assertEqual(len(seen), 3)
                self.assertFalse(any("/page/n" in u for u in seen))

    def test_text_pages_range_and_bookreader_segment_mode(self) -> None:
        for case, djvu_pages in (
            ("scandata_mode", SYNTHETIC_TEXT_PAGES),
            # One segment per BookReader access leaf (deleted leaf 0 omitted).
            ("bookreader_mode", SYNTHETIC_TEXT_PAGES[1:]),
        ):
            with self.subTest(case=case):
                item_id = f"synthetic_range_{case}_1899"
                seen: list[str] = []
                with tempfile.TemporaryDirectory() as tmpdir:
                    with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                        ao, "http_get_bytes", side_effect=self.make_fake_http(item_id, djvu_pages, seen)
                    ):
                        rc, out = self.run_cli(["text", item_id, "--pages", "iv-2", "--json"])
                        self.assertEqual(rc, 0)
                        pages = json.loads(out)["pages"]
                        self.assertEqual([p["leaf"] for p in pages], [2, 3, 4])
                        self.assertEqual([p["printed_page"] for p in pages], ["iv", "1", "2"])
                        self.assertEqual([p["scandata_leaf"] for p in pages], [3, 4, 5])
                        self.assertIn("Clara Barton", pages[0]["text"])
                        self.assertIn("1848 mill survey", pages[1]["text"])
                        self.assertIn("ferry tolls", pages[2]["text"])

                        rc, out = self.run_cli(["text", item_id, "--pages", "1-1", "--json"])
                        self.assertEqual([p["leaf"] for p in json.loads(out)["pages"]], [3])
                        self.assertEqual(len(seen), 3)

    def test_lookup_uses_page_index_only_and_refreshes(self) -> None:
        item_id = "synthetic_lookup_atlas_1877"
        seen: list[str] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=self.make_fake_http(item_id, SYNTHETIC_TEXT_PAGES, seen)
            ):
                rc, out = self.run_cli(["lookup", item_id, "--printed-page", "2", "--json"])
                self.assertEqual(rc, 0)
                payload = json.loads(out)
                self.assertEqual(payload["leaf"], 4)
                self.assertEqual(payload["scandata_leaf"], 5)
                self.assertEqual(payload["printed_page"], "2")
                self.assertFalse(payload["cached"])
                self.assertEqual(payload["image_url"], f"https://archive.org/download/{item_id}/page/n4_s2.jpg")
                # Only metadata + scandata; no djvu.txt and no JPEG.
                self.assertEqual(len(seen), 2)
                self.assertFalse(any(u.endswith("_djvu.txt") for u in seen))
                self.assertFalse(any("/page/n" in u for u in seen))
                self.assertFalse((Path(tmpdir) / item_id / "djvu.txt").exists())
                self.assertTrue((Path(tmpdir) / item_id / "page_index.json").is_file())

                seen.clear()
                rc, out = self.run_cli(["lookup", item_id, "--leaf", "3", "--json"])
                payload = json.loads(out)
                self.assertTrue(payload["cached"])
                self.assertEqual((payload["printed_page"], payload["scandata_leaf"]), ("1", 4))

                rc, out = self.run_cli(["lookup", item_id, "--scandata-leaf", "3"])
                self.assertEqual(rc, 0)
                self.assertIn("printed page iv | BookReader leaf n2 | scandata leaf 3", out)
                self.assertEqual(seen, [])

                rc, out = self.run_cli(["lookup", item_id, "--leaf", "0", "--refresh", "--json"])
                self.assertEqual(rc, 0)
                self.assertEqual(json.loads(out)["scandata_leaf"], 1)
                self.assertEqual(len(seen), 2)
                self.assertFalse(any(u.endswith("_djvu.txt") for u in seen))

    def test_text_and_lookup_errors_on_unresolvable_pages_and_bad_selectors(self) -> None:
        item_id = "synthetic_errors_registry_1866"
        seen: list[str] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=self.make_fake_http(item_id, SYNTHETIC_TEXT_PAGES, seen)
            ):
                code, err = self.run_cli_error(["text", item_id, "--printed-page", "999"])
                self.assertEqual(code, 1)
                self.assertIn("Printed page '999' not found", err)

                code, err = self.run_cli_error(["lookup", item_id, "--printed-page", "xlii"])
                self.assertEqual(code, 1)
                self.assertIn("not found", err)

                code, err = self.run_cli_error(["text", item_id, "--leaf", "42"])
                self.assertEqual(code, 1)
                self.assertIn("out of range", err)

                code, err = self.run_cli_error(["lookup", item_id, "--scandata-leaf", "0"])
                self.assertEqual(code, 1)
                self.assertIn("not an access leaf", err)

                code, err = self.run_cli_error(["text", item_id, "--pages", "2-iv"])
                self.assertEqual(code, 1)
                self.assertIn("precedes", err)

                code, err = self.run_cli_error(["text", item_id, "--pages", "1-999"])
                self.assertEqual(code, 1)
                self.assertIn("'999' not found", err)

                seen.clear()
                code, _ = self.run_cli_error(["text", item_id])
                self.assertEqual(code, 2)
                code, _ = self.run_cli_error(["text", item_id, "--leaf", "1", "--printed-page", "1"])
                self.assertEqual(code, 2)
                code, _ = self.run_cli_error(["lookup", item_id])
                self.assertEqual(code, 2)
                self.assertEqual(seen, [])


class TestArchiveOrgHardening(unittest.TestCase):
    def test_grep_retries_429_500_503_incomplete_read_and_http_date_retry_after(self) -> None:
        from datetime import datetime, timedelta, timezone
        from email.utils import format_datetime
        from http.client import IncompleteRead

        item_id = "synthetic_retry_gazetteer_1885"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Retry Gazetteer"},
            "files": [
                {"name": f"{item_id}_scandata.xml", "format": "Scandata"},
                {"name": f"{item_id}_djvu.txt", "format": "DjVuTXT"},
            ],
        }
        fake_djvu = "\x0c".join(
            ["", "Cover", "Title", "Intro", "Harriet Tubman spoke at Oakridge.", "Closing"]
        ).encode("utf-8")

        counts = {"meta": 0, "scandata": 0, "djvu": 0}
        sleeps: list[float] = []
        future_date = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=2), usegmt=True)

        def fake_urlopen(req, timeout=25.0):
            url = req.full_url
            if url.endswith(f"/metadata/{item_id}"):
                counts["meta"] += 1
                if counts["meta"] == 1:
                    raise make_http_error(url, 429, retry_after="1.25")
                return FakeHttpResponse(json.dumps(fake_meta).encode("utf-8"))
            if url.endswith(f"/{item_id}_scandata.xml"):
                counts["scandata"] += 1
                if counts["scandata"] == 1:
                    raise make_http_error(url, 503, retry_after=future_date)
                return FakeHttpResponse(SYNTHETIC_SCANDATA)
            if url.endswith(f"/{item_id}_djvu.txt"):
                counts["djvu"] += 1
                if counts["djvu"] == 1:
                    raise make_http_error(url, 500)
                if counts["djvu"] == 2:
                    raise IncompleteRead(b"partial")
                return FakeHttpResponse(fake_djvu)
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch(
                "urllib.request.urlopen", side_effect=fake_urlopen
            ), patch.object(ao.time, "sleep", side_effect=sleeps.append):
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    rc1 = ao.main(["grep", item_id, "-e", "Harriet Tubman", "--json"])
                self.assertEqual(rc1, 0)
                out1 = json.loads(buf1.getvalue())
                self.assertFalse(out1["cache_hit"])
                self.assertEqual(out1["total_matches"], 1)
                self.assertEqual(out1["hits"][0]["printed_page"], "1")
                self.assertEqual(counts, {"meta": 2, "scandata": 2, "djvu": 3})
                self.assertEqual(len(sleeps), 4)
                self.assertTrue(all(0.0 <= s <= ao.MAX_RETRY_AFTER_SECONDS for s in sleeps))

                # Second call hits disk cache with zero HTTP attempts.
                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(["grep", item_id, "-e", "Oakridge", "--json"])
                self.assertEqual(rc2, 0)
                out2 = json.loads(buf2.getvalue())
                self.assertTrue(out2["cache_hit"])
                self.assertEqual(out2["total_matches"], 1)
                self.assertEqual(counts, {"meta": 2, "scandata": 2, "djvu": 3})

    def test_grep_handles_aliases_zero_matches_non_utf8_corrupt_scandata_and_partial_batch(self) -> None:
        good_id = "synthetic_good_almanac_1870"
        bad_id = "synthetic_borrow_only_1871"
        corrupt_xml = b"<html><body>503 Service Unavailable</body></html>"
        # Include invalid UTF-8 bytes in metadata description and djvu text.
        meta_bytes = (
            b'{"metadata":{"identifier":"'
            + good_id.encode("ascii")
            + b'","title":"Almanac \xff\xfe"},"files":['
            + b'{"name":"' + good_id.encode("ascii") + b'_SCANDATA.XML","format":"Scandata"},'
            + b'{"name":"' + good_id.encode("ascii") + b'_DJVU.TXT","format":"DjVuTXT"}]}'
        )
        djvu_bytes = b"Page zero \xff\xfe Frederick Douglass\x0cPage one Clara Barton"

        def fake_urlopen(req, timeout=25.0):
            url = req.full_url
            if url.endswith(f"/metadata/{good_id}"):
                return FakeHttpResponse(meta_bytes)
            if url.endswith(f"/{good_id}_SCANDATA.XML"):
                return FakeHttpResponse(corrupt_xml)
            if url.endswith(f"/{good_id}_DJVU.TXT"):
                return FakeHttpResponse(djvu_bytes)
            if url.endswith(f"/metadata/{bad_id}"):
                raise make_http_error(url, 403)
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch(
                "urllib.request.urlopen", side_effect=fake_urlopen
            ):
                # Multi-item grep with repeatable -e, -C, -m survives 403 on one item and reports errors.
                buf = io.StringIO()
                with patch("sys.stdout", buf):
                    rc = ao.main(
                        [
                            "grep",
                            good_id,
                            bad_id,
                            "-e",
                            "Douglass",
                            "-e",
                            "Barton",
                            "-C",
                            "80",
                            "-m",
                            "10",
                            "--json",
                        ]
                    )
                self.assertEqual(rc, 0)
                payload = json.loads(buf.getvalue())
                self.assertEqual(payload["total_matches"], 2)
                self.assertFalse(payload["cache_hit"])
                self.assertEqual(len(payload["errors"]), 1)
                self.assertEqual(payload["errors"][0]["identifier"], bad_id)
                self.assertIn("HTTP 403", payload["errors"][0]["error"])
                # Corrupt scandata XML was NOT written to cache.
                self.assertFalse((Path(tmpdir) / good_id / "scandata.xml").exists())

                # Zero-match grep exits 0 cleanly and reports cache_hit: True.
                buf_zero = io.StringIO()
                with patch("sys.stdout", buf_zero):
                    rc_zero = ao.main(["grep", good_id, "-e", "NonexistentTermXYZ", "--json"])
                self.assertEqual(rc_zero, 0)
                zero_payload = json.loads(buf_zero.getvalue())
                self.assertEqual(zero_payload["total_matches"], 0)
                self.assertEqual(zero_payload["returned"], 0)
                self.assertEqual(zero_payload["hits"], [])
                self.assertTrue(zero_payload["cache_hit"])

                # Zero-width regex yields 0 matches instead of matching every character boundary.
                buf_zw = io.StringIO()
                with patch("sys.stdout", buf_zw):
                    rc_zw = ao.main(["grep", good_id, "--pattern", "^", "--json"])
                self.assertEqual(rc_zw, 0)
                self.assertEqual(json.loads(buf_zw.getvalue())["total_matches"], 0)

                # All-failing batch exits 1.
                err = io.StringIO()
                with patch("sys.stderr", err):
                    with self.assertRaises(SystemExit) as cm:
                        ao.main(["grep", bad_id, "--pattern", "Douglass", "--json"])
                self.assertEqual(cm.exception.code, 1)

    def test_page_json_emits_boolean_cache_hit_with_dedup_and_out_dir_alias(self) -> None:
        item_id = "synthetic_page_telemetry_1890"
        seen: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            seen.append(url)
            match = re.search(r"/page/n(\d+)_", url)
            assert match is not None
            return b"\xff\xd8" + bytes([int(match.group(1))]) + (b"\x11" * 32)

        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir) / "out"
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                # Single-page via --leaves with duplicate leaf deduplicates to 1 fetch.
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    rc1 = ao.main(["page", item_id, "--leaves", "4,4", "--out-dir", str(out_dir), "--json"])
                self.assertEqual(rc1, 0)
                p1 = json.loads(buf1.getvalue())
                self.assertIs(p1["cache_hit"], False)
                self.assertEqual(p1["leaf"], 4)
                self.assertEqual(len(seen), 1)

                # Repeat single-page hits cache.
                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(["page", item_id, "--leaf", "4", "--out-dir", str(out_dir), "--json"])
                self.assertEqual(rc2, 0)
                p2 = json.loads(buf2.getvalue())
                self.assertIs(p2["cache_hit"], True)
                self.assertEqual(len(seen), 1)

                # Multi-page partial hit (leaf 4 cached, leaf 5 uncached) -> cache_hit is False.
                buf3 = io.StringIO()
                with patch("sys.stdout", buf3):
                    rc3 = ao.main(["page", item_id, "--leaves", "4,5,4", "-o", str(out_dir), "--json"])
                self.assertEqual(rc3, 0)
                p3 = json.loads(buf3.getvalue())
                self.assertIs(p3["cache_hit"], False)
                self.assertEqual([page["leaf"] for page in p3["pages"]], [4, 5])
                self.assertEqual([page["page_cached"] for page in p3["pages"]], [True, False])
                self.assertEqual(len(seen), 2)

                # Repeat multi-page -> cache_hit is True and zero new HTTP calls.
                buf4 = io.StringIO()
                with patch("sys.stdout", buf4):
                    rc4 = ao.main(["page", item_id, "--leaves", "4-5", "-o", str(out_dir), "--json"])
                self.assertEqual(rc4, 0)
                p4 = json.loads(buf4.getvalue())
                self.assertIs(p4["cache_hit"], True)
                self.assertEqual([page["page_cached"] for page in p4["pages"]], [True, True])
                self.assertEqual(len(seen), 2)

    def test_broken_pipe_exits_zero(self) -> None:
        def raise_pipe(_args):
            raise BrokenPipeError(32, "Broken pipe")

        with patch.object(ao, "cmd_url", side_effect=raise_pipe):
            rc = ao.main(["url", "title:(Oakridge)"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
