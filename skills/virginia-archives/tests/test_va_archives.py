"""Mocked-HTTP unit tests for skills/virginia-archives/scripts/va-archives.

All fixtures are synthetic; no network access is performed.
"""
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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "va-archives"


def load_module():
    loader = SourceFileLoader("va_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("va_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


va = load_module()

# Minimal little-endian TIFF header stand-in (bytes are only copied, never decoded).
FAKE_TIFF = b"II*\x00" + b"\x08\x00\x00\x00" + b"synthetic-tiff-body"
FAKE_PDF = b"%PDF-1.4\nsynthetic\n%%EOF\n"

DRAWER_HTML = """<html><body>
<div class="pageTitle">
Dunmore's War - Page 12
</div>
<a href="/Microfilm/DW/001/00010.tif">Page 10</a><br />
<a href="/Microfilm/DW/001/00011.tif">Page 11</a><br />
<a href="/Microfilm/DW/001/00012.tif"><img src="/icons/land.office.gif" alt="Document" /></a>
<a href="/Microfilm/DW/001/00013.tif">Page 13</a><br />
<a href="/Microfilm/../../etc/passwd.tif">Page 99</a>
</body></html>"""

DELIVERY_HTML = """<html><body>
<iframe src="https://rosetta.virginiamemory.com:443/view/action/ieViewer.do?search=hide&amp;is_mobile=false&amp;dps_dvs=111~222&amp;dps_pid=IE900001"></iframe>
<a href="DeliveryManagerServlet?dps_func=metadata">metadata</a>
</body></html>"""

VIEWER_HTML = """<html><script>
initialSelect = "FL900002"
var toc = "<mets><item id='N1' rel='root' title='Table of Contents'><item id='FL900002' title='Original'></item><item id='FL900003' title='Transcription'></item></item></mets>";
var JSONObject = '{"0":"FL900002,FL900003"}';
</script></html>"""


class MockLva:
    """Route table for a synthetic LVA / Rosetta server that records every request."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.tiff = FAKE_TIFF
        self.localities_version = 1

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        url = request.url
        if url.host == "old.lva.virginia.gov" and url.path.endswith("/available.asp"):
            body = (
                f"<TR><TD>SYNTHETIC CO</td><TD>Piedmont</td><TD>1800-1900</td>"
                f"<TD>Scanned v{self.localities_version}</td><TD>none</td></TR>"
            )
            return httpx.Response(200, headers={"content-type": "text/html"}, text=body)
        if url.host == "lva.primo.exlibrisgroup.com":
            return httpx.Response(200, json={"info": {"total": 0, "first": 0, "last": 0}, "docs": []})
        if url.host == "image.lva.virginia.gov":
            if url.path == "/cgi-bin/GetDW.pl":
                return httpx.Response(302, headers={"location": "/cgi-bin/drawer?retrieve_image=DW&page=12"})
            if url.path == "/cgi-bin/drawer":
                return httpx.Response(200, headers={"content-type": "text/html"}, text=DRAWER_HTML)
            if url.path == "/redirect-out.tif":
                return httpx.Response(302, headers={"location": "https://evil.example/x.tif"})
            if url.path.endswith(".tif"):
                return httpx.Response(200, headers={"content-type": "image/tiff"}, content=self.tiff)
        if url.host == "rosetta.virginiamemory.com":
            if url.path == "/delivery/DeliveryManagerServlet":
                pid = url.params.get("dps_pid", "")
                if pid.startswith("IE"):
                    return httpx.Response(
                        200,
                        headers={"content-type": "text/html", "set-cookie": "JSESSIONID=synthetic; Path=/"},
                        text=DELIVERY_HTML,
                    )
                if pid.startswith("FL") and url.params.get("dps_func") == "stream":
                    if "JSESSIONID=synthetic" not in request.headers.get("cookie", ""):
                        return httpx.Response(403, text="no session")
                    return httpx.Response(200, headers={"content-type": "application/pdf;charset=UTF-8"},
                                          content=FAKE_PDF + pid.encode())
            if url.path == "/view/action/ieViewer.do":
                if url.params.get("dps_dvs") != "111~222" or url.params.get("dps_pid") != "IE900001":
                    return httpx.Response(400, text="bad viewer params")
                return httpx.Response(200, headers={"content-type": "text/html"}, text=VIEWER_HTML)
        return httpx.Response(404, text=f"unmocked {url}")

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler), follow_redirects=True,
                            headers={"User-Agent": va.USER_AGENT})


class VaArchivesTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-va-test-")
        self.root = Path(self._tmp.name)
        self.cache = self.root / "cache"
        self._env = patch.dict(os.environ, {va.CACHE_ENV: str(self.cache)})
        self._env.start()
        self.mock = MockLva()
        self._client_patch = patch.object(va, "_client", side_effect=self.mock.client)
        self._client_patch.start()
        self.runner = CliRunner()

    def tearDown(self) -> None:
        self._client_patch.stop()
        self._env.stop()
        self._tmp.cleanup()

    def invoke(self, *args: str):
        res = self.runner.invoke(va.cli, list(args))
        return res


class TestCacheRoot(unittest.TestCase):
    def test_env_override_then_xdg_then_home(self) -> None:
        with patch.dict(os.environ, {va.CACHE_ENV: "/tmp/kinloom-va-x"}, clear=False):
            self.assertEqual(va.get_cache_root(), Path("/tmp/kinloom-va-x"))
        env = {k: v for k, v in os.environ.items() if k not in (va.CACHE_ENV, "XDG_CACHE_HOME")}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(va.get_cache_root(), Path.home() / ".cache" / "kinloom-va-archives")
            with patch.dict(os.environ, {"XDG_CACHE_HOME": "/tmp/xdg-synth"}):
                self.assertEqual(va.get_cache_root(), Path("/tmp/xdg-synth/kinloom-va-archives"))


class TestHtmlCaching(VaArchivesTestBase):
    def test_localities_cache_hit_avoids_network_and_refresh_refetches(self) -> None:
        r1 = self.invoke("chancery", "localities", "--json")
        self.assertIsInstance(json.loads(r1.output), list)
        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(len(self.mock.calls), 1)
        self.assertEqual(json.loads(r1.output)[0]["viewing_status"], "Scanned v1")

        self.mock.localities_version = 2
        r2 = self.invoke("chancery", "localities", "--json")
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(len(self.mock.calls), 1, "second call must be served from disk")
        self.assertEqual(json.loads(r2.output)[0]["viewing_status"], "Scanned v1")

        # Per-command --refresh
        r3 = self.invoke("chancery", "localities", "--refresh", "--json")
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(len(self.mock.calls), 2)
        self.assertEqual(json.loads(r3.output)[0]["viewing_status"], "Scanned v2")

        # Global --refresh
        self.mock.localities_version = 3
        r4 = self.invoke("--refresh", "chancery", "localities", "--json")
        self.assertEqual(r4.exit_code, 0, r4.output)
        self.assertEqual(len(self.mock.calls), 3)
        self.assertEqual(json.loads(r4.output)[0]["viewing_status"], "Scanned v3")

        # Refresh state does not leak into the next invocation.
        r5 = self.invoke("chancery", "localities", "--json")
        self.assertEqual(r5.exit_code, 0, r5.output)
        self.assertEqual(len(self.mock.calls), 3)

    def test_ttl_zero_env_forces_refetch(self) -> None:
        with patch.dict(os.environ, {va.TTL_ENV: "0"}):
            cold = self.invoke("catalog", "Synthetic", "--json")
            self.assertEqual(cold.exit_code, 0, cold.output)
            self.assertFalse(json.loads(cold.output)["cache_hit"])
            self.assertEqual(self.invoke("catalog", "Synthetic", "--json").exit_code, 0)
        self.assertEqual(len(self.mock.calls), 2)
        warm = self.invoke("catalog", "Synthetic", "--json")
        self.assertEqual(warm.exit_code, 0, warm.output)
        self.assertTrue(json.loads(warm.output)["cache_hit"])
        self.assertEqual(len(self.mock.calls), 2)

    def test_cache_writes_are_atomic_no_tmp_leftovers(self) -> None:
        self.assertEqual(self.invoke("catalog", "Synthetic").exit_code, 0)
        leftovers = [p for p in self.cache.rglob("*.tmp")]
        self.assertEqual(leftovers, [])
        bodies = list((self.cache / "http").glob("*.body"))
        self.assertEqual(len(bodies), 1)
        self.assertTrue(Path(str(bodies[0]) + ".meta.json").is_file())


class TestPathValidation(unittest.TestCase):
    def test_accepts_https_and_relative_paths_on_lva_image_host(self) -> None:
        want = "https://image.lva.virginia.gov/LONN/LO-3/372/372_0195.tif"
        for ok in (
            want,
            "/LONN/LO-3/372/372_0195.tif",
            "LONN/LO-3/372/372_0195.tif",
            "https://IMAGE.lva.virginia.gov:443/LONN/LO-3/372/372_0195.tif",
        ):
            self.assertEqual(va.normalize_lva_image_url(ok), want, ok)

    def test_rejects_bad_hosts_schemes_and_traversal(self) -> None:
        bad = [
            "",
            "http://image.lva.virginia.gov/LONN/a.tif",
            "ftp://image.lva.virginia.gov/LONN/a.tif",
            "file:///etc/passwd.tif",
            "javascript:alert(1).tif",
            "https://evil.example/LONN/a.tif",
            "https://image.lva.virginia.gov.evil.example/a.tif",
            "https://user:pw@image.lva.virginia.gov/a.tif",
            "https://image.lva.virginia.gov:8443/a.tif",
            "//image.lva.virginia.gov/a.tif",
            "/LONN/../secret.tif",
            "/LONN/%2e%2e/secret.tif",
            "/LONN/%252e%252e/secret.tif",
            "/LONN/./a.tif",
            "/LONN//a.tif",
            "\\LONN\\a.tif",
            "/LONN/a.tif?x=1",
            "/LONN/a.tif#frag",
            "/LONN/a b.tif",
            "/LONN/a.tif\x00.png",
            "/LONN/LO.html",
            "/cgi-bin/script.pl",
        ]
        for raw in bad:
            with self.assertRaises(ValueError, msg=repr(raw)):
                va.normalize_lva_image_url(raw)

    def test_ie_and_fl_validation(self) -> None:
        self.assertEqual(va.validate_ie_id(" IE3453061 "), "IE3453061")
        for raw in ("IE", "ie123", "IE12a", "../IE1", "IE1/..", "FL123", "IE1 2", ""):
            with self.assertRaises(va.click.BadParameter, msg=repr(raw)):
                va.validate_ie_id(raw)
        self.assertEqual(va.validate_fl_id("FL42"), "FL42")
        with self.assertRaises(va.click.BadParameter):
            va.validate_fl_id("FL42/../x")


class TestGrantTif(VaArchivesTestBase):
    def test_raw_tiff_saved_cached_and_refreshed(self) -> None:
        out = self.root / "grant.tif"
        r1 = self.invoke("grant-tif", "/LONN/LO-3/372/372_0195.tif", "--out", str(out), "--json")
        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(out.read_bytes(), FAKE_TIFF)
        self.assertEqual(json.loads(r1.output)["mode"], "raw")
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertEqual(len(self.mock.calls), 1)

        # Alias + cache hit: zero HTTP.
        self.mock.tiff = FAKE_TIFF + b"-v2"
        out2 = self.root / "grant2.tiff"
        r2 = self.invoke("lva-tif", "https://image.lva.virginia.gov/LONN/LO-3/372/372_0195.tif", "--out", str(out2))
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(len(self.mock.calls), 1)
        self.assertEqual(out2.read_bytes(), FAKE_TIFF)
        r_hit = self.invoke("grant-tif", "/LONN/LO-3/372/372_0195.tif", "--json")
        self.assertEqual(r_hit.exit_code, 0, r_hit.output)
        self.assertTrue(json.loads(r_hit.output)["cache_hit"])
        self.assertEqual(len(self.mock.calls), 1)

        # --refresh refetches.
        r3 = self.invoke("grant-tif", "/LONN/LO-3/372/372_0195.tif", "--out", str(out2), "--refresh")
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(len(self.mock.calls), 2)
        self.assertEqual(out2.read_bytes(), FAKE_TIFF + b"-v2")

    def test_bad_path_makes_no_request(self) -> None:
        for bad in ("/LONN/../x.tif", "https://evil.example/x.tif", "http://image.lva.virginia.gov/x.tif"):
            res = self.invoke("grant-tif", bad, "--out", str(self.root / "x.tif"))
            self.assertNotEqual(res.exit_code, 0, bad)
        self.assertEqual(self.mock.calls, [])
        self.assertFalse((self.root / "x.tif").exists())

    def test_redirect_off_host_is_refused_and_not_cached(self) -> None:
        res = self.invoke("grant-tif", "/redirect-out.tif", "--out", str(self.root / "x.tif"))
        self.assertNotEqual(res.exit_code, 0)
        self.assertFalse((self.root / "x.tif").exists())
        self.assertEqual(list((self.cache / "files").glob("*.tif")), [])

    def test_jpg_with_pillow_converts_tiff(self) -> None:
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow not installed")
        import io

        buf = io.BytesIO()
        Image.new("1", (16, 8), 1).save(buf, format="TIFF", compression="group4")
        self.mock.tiff = buf.getvalue()
        out = self.root / "grant.jpg"
        res = self.invoke("grant-tif", "/LONN/b.tif", "--out", str(out), "--json")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(json.loads(res.output)["mode"], "jpeg")
        self.assertEqual(out.read_bytes()[:3], b"\xff\xd8\xff")

    def test_jpg_without_pillow_falls_back_to_raw_tif(self) -> None:
        import builtins

        real_import = builtins.__import__

        def no_pil(name, *args, **kwargs):
            if name == "PIL" or name.startswith("PIL."):
                raise ImportError("no PIL in this test")
            return real_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=no_pil):
            res = self.invoke("grant-tif", "/LONN/a.tif", "--out", str(self.root / "a.jpg"), "--json")
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertFalse((self.root / "a.jpg").exists())
        self.assertEqual((self.root / "a.tif").read_bytes(), FAKE_TIFF)


class TestDunmore(VaArchivesTestBase):
    def test_parse_drawer_marks_current_and_drops_unsafe_links(self) -> None:
        parsed = va.parse_dunmore_drawer(DRAWER_HTML)
        self.assertEqual(parsed["current_page"], 12)
        self.assertEqual([im["page"] for im in parsed["images"]], [10, 11, 12, 13])
        current = [im for im in parsed["images"] if im["current"]]
        self.assertEqual(current[0]["url"], "https://image.lva.virginia.gov/Microfilm/DW/001/00012.tif")

    def test_dunmore_saves_card_page_and_caches(self) -> None:
        out = self.root / "dw.tif"
        r1 = self.invoke("dunmore", "0001/W0002", "3", "--out", str(out), "--json")
        self.assertEqual(r1.exit_code, 0, r1.output)
        payload = json.loads(r1.output)
        self.assertEqual(payload["selected"]["page"], 12)
        self.assertEqual(out.read_bytes(), FAKE_TIFF)
        n = len(self.mock.calls)
        r2 = self.invoke("dunmore", "0001/W0002", "3", "--page", "13", "--json")
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(len(self.mock.calls), n, "drawer page must come from cache")
        self.assertEqual(json.loads(r2.output)["selected"]["page"], 13)

    def test_dunmore_rejects_bad_drawer_and_card(self) -> None:
        for args in (("../x", "1"), ("0001/W0002", "1;rm"), ("0001/W0002/..", "1")):
            self.assertNotEqual(self.invoke("dunmore", *args).exit_code, 0)
        self.assertEqual(self.mock.calls, [])


class TestRosetta(VaArchivesTestBase):
    def test_parse_delivery_and_viewer(self) -> None:
        d = va.parse_rosetta_delivery(DELIVERY_HTML)
        self.assertIn("ieViewer.do", d["viewer_url"])
        self.assertIn("&dps_pid=IE900001", d["viewer_url"])
        self.assertEqual(d["dps_dvs"], "111~222")
        v = va.parse_rosetta_viewer(VIEWER_HTML)
        self.assertEqual(v["initial"], "FL900002")
        self.assertEqual(v["files"], [{"fl": "FL900002", "title": "Original"},
                                      {"fl": "FL900003", "title": "Transcription"}])

    def test_download_resolves_with_session_and_caches_by_ie(self) -> None:
        out = self.root / "doc.pdf"
        r1 = self.invoke("download-rosetta", "IE900001", "--out", str(out), "--json")
        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(out.read_bytes(), FAKE_PDF + b"FL900002")
        paths = [c.url.path for c in self.mock.calls]
        self.assertEqual(paths, ["/delivery/DeliveryManagerServlet", "/view/action/ieViewer.do",
                                 "/delivery/DeliveryManagerServlet"])
        self.assertTrue((self.cache / "rosetta" / "IE900001" / "files.json").is_file())
        self.assertTrue((self.cache / "rosetta" / "IE900001" / "FL900002.bin").is_file())

        # Cache hit: zero HTTP, default output name derived from content type.
        prev_cwd = os.getcwd()
        os.chdir(self.root)
        try:
            r2 = self.invoke("download-rosetta", "IE900001")
        finally:
            os.chdir(prev_cwd)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertTrue((self.root / "IE900001_FL900002.pdf").is_file())
        self.assertEqual(len(self.mock.calls), 3)

        # Second file: listing is cached, so only a session warm-up + the stream are fetched.
        r3 = self.invoke("download-rosetta", "IE900001", "--file", "2", "--out", str(self.root / "t.pdf"))
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual((self.root / "t.pdf").read_bytes(), FAKE_PDF + b"FL900003")
        self.assertEqual([c.url.params.get("dps_pid") for c in self.mock.calls[3:]], ["IE900001", "FL900003"])

        # --refresh re-resolves the IE and refetches the bytes.
        r4 = self.invoke("download-rosetta", "IE900001", "--refresh", "--out", str(out))
        self.assertEqual(r4.exit_code, 0, r4.output)
        self.assertEqual(len(self.mock.calls), 8)

    def test_list_and_fl_membership(self) -> None:
        r = self.invoke("download-rosetta", "IE900001", "--list", "--json")
        self.assertEqual(r.exit_code, 0, r.output)
        self.assertEqual([f["fl"] for f in json.loads(r.output)["files"]], ["FL900002", "FL900003"])
        bad = self.invoke("download-rosetta", "IE900001", "--fl", "FL1")
        self.assertNotEqual(bad.exit_code, 0)

    def test_invalid_ie_makes_no_request(self) -> None:
        for bad in ("IE../1", "123", "FL900002", "IE1&dps_func=x"):
            self.assertNotEqual(self.invoke("download-rosetta", bad).exit_code, 0, bad)
        self.assertEqual(self.mock.calls, [])


if __name__ == "__main__":
    unittest.main()
