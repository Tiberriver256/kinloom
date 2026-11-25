from __future__ import annotations

import gzip
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


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


class TestArchiveOrgCachedGrepAndPage(unittest.TestCase):
    def test_parse_scandata_xml_handles_deleted_leaf_offset(self) -> None:
        idx = ao.parse_scandata_xml(SYNTHETIC_SCANDATA)
        self.assertEqual(idx["leaf_count"], 6)
        self.assertEqual(idx["access_leaf_count"], 5)
        # leafNum 4 is printed page "1", which is BookReader n3 because leafNum 0 is deleted.
        self.assertEqual(idx["printed_to_bookreader"]["1"], 3)
        self.assertEqual(idx["printed_to_bookreader"]["2"], 4)
        self.assertEqual(idx["printed_to_bookreader_ci"]["iv"], 2)
        self.assertEqual(idx["bookreader_to_printed"]["3"], "1")
        self.assertEqual(idx["scandata_to_bookreader"]["4"], 3)
        self.assertEqual(idx["bookreader_to_scandata"]["3"], 4)

    def test_grep_populates_cache_and_hits_cache_on_second_call(self) -> None:
        item_id = "synthetic_town_history_1892"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Synthetic Town History"},
            "files": [
                {"name": f"{item_id}_scandata.xml", "format": "Scandata"},
                {"name": f"{item_id}_djvu.txt", "format": "DjVuTXT"},
            ],
        }
        # 6 form-feed delimited leaves matching leafNum 0..5.
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
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            env = {"KINLOOM_IA_CACHE_DIR": tmpdir}
            with patch.dict(os.environ, env, clear=False), patch.object(ao, "http_get_bytes", side_effect=fake_http_get_bytes):
                buf1 = io.StringIO()
                with patch("sys.stdout", buf1):
                    rc1 = ao.main(["grep", item_id, "--pattern", "Frederick Douglass", "--json"])
                self.assertEqual(rc1, 0)
                out1 = json.loads(buf1.getvalue())
                self.assertFalse(out1["cached"])
                self.assertEqual(out1["total_matches"], 1)
                self.assertEqual(len(fetch_calls), 3)
                hit = out1["hits"][0]
                # Segment 4 -> scandata_leaf 4 -> BookReader leaf 3 -> printed_page "1".
                self.assertEqual(hit["leaf"], 3)
                self.assertEqual(hit["scandata_leaf"], 4)
                self.assertEqual(hit["printed_page"], "1")
                self.assertEqual(
                    hit["image_url"],
                    f"https://archive.org/download/{item_id}/page/n3_s2.jpg",
                )
                self.assertFalse(hit["cached"])

                # Verify all 4 cache artifacts exist on disk.
                item_dir = Path(tmpdir) / item_id
                for fname in ("metadata.json", "scandata.xml", "page_index.json", "djvu.txt"):
                    self.assertTrue((item_dir / fname).is_file(), f"Missing cache file {fname}")

                # Second call must not touch network at all.
                fetch_calls.clear()
                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(["grep", item_id, "--pattern", "Clara Barton", "--json"])
                self.assertEqual(rc2, 0)
                self.assertEqual(fetch_calls, [])
                out2 = json.loads(buf2.getvalue())
                self.assertTrue(out2["cached"])
                self.assertEqual(out2["hits"][0]["leaf"], 2)
                self.assertEqual(out2["hits"][0]["printed_page"], "iv")
                self.assertTrue(out2["hits"][0]["cached"])

    def test_grep_synthesizes_form_feeds_from_hocr_when_djvu_lacks_breaks(self) -> None:
        item_id = "synthetic_flat_djvu_1901"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Synthetic Flat DjVu"},
            "files": [
                {"name": f"{item_id}_scandata.xml", "format": "Scandata"},
                {"name": f"{item_id}_djvu.txt", "format": "DjVuTXT"},
                {"name": f"{item_id}_hocr_searchtext.txt.gz", "format": "OCR Search Text"},
                {"name": f"{item_id}_hocr_pageindex.json.gz", "format": "OCR Page Index"},
            ],
        }
        pages = ["", "Cover", "Title", "Intro iv", "Page one alpha", "Page two Harriet Tubman"]
        joined = "".join(pages)
        offsets = []
        pos = 0
        for p in pages:
            offsets.append([pos, pos + len(p), 0, 0])
            pos += len(p)

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
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

    def test_page_resolves_printed_page_and_legacy_leaf_flag(self) -> None:
        item_id = "synthetic_atlas_1888"
        fake_meta = {
            "metadata": {"identifier": item_id, "title": "Synthetic Atlas"},
            "files": [{"name": f"{item_id}_scandata.xml", "format": "Scandata"}],
        }
        fake_jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 64
        seen_urls: list[str] = []

        def fake_http_get_bytes(url: str, timeout: float = 25.0) -> bytes:
            seen_urls.append(url)
            if url.endswith(f"/metadata/{item_id}"):
                return json.dumps(fake_meta).encode("utf-8")
            if url.endswith(f"/{item_id}_scandata.xml"):
                return SYNTHETIC_SCANDATA
            if "/page/n" in url:
                return fake_jpeg
            raise AssertionError(f"Unexpected URL: {url}")

        with tempfile.TemporaryDirectory() as tmpdir:
            out_file = Path(tmpdir) / "page2.jpg"
            legacy_dir = Path(tmpdir) / "legacy_out"
            with patch.dict(os.environ, {"KINLOOM_IA_CACHE_DIR": tmpdir}, clear=False), patch.object(
                ao, "http_get_bytes", side_effect=fake_http_get_bytes
            ):
                buf = io.StringIO()
                with patch("sys.stdout", buf):
                    rc = ao.main(
                        ["page", item_id, "--printed-page", "2", "--scale", "2", "--out", str(out_file), "--json"]
                    )
                self.assertEqual(rc, 0)
                payload = json.loads(buf.getvalue())
                self.assertEqual(payload["leaf"], 4)
                self.assertEqual(payload["scandata_leaf"], 5)
                self.assertEqual(payload["printed_page"], "2")
                self.assertEqual(payload["url"], f"https://archive.org/download/{item_id}/page/n4_s2.jpg")
                self.assertEqual(out_file.read_bytes(), fake_jpeg)

                # Legacy positional leaf + --width + directory --out stays backward compatible.
                buf2 = io.StringIO()
                with patch("sys.stdout", buf2):
                    rc2 = ao.main(["page", item_id, "3", "--width", "1200", "--out", str(legacy_dir)])
                self.assertEqual(rc2, 0)
                expected_legacy = legacy_dir / f"{item_id}_n3_w1200.jpg"
                self.assertTrue(expected_legacy.is_file())
                self.assertIn(f"https://archive.org/download/{item_id}/page/n3_w1200.jpg", seen_urls)


if __name__ == "__main__":
    unittest.main()
