from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import httpx


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "fi_archives.py"


def load_module():
    loader = SourceFileLoader("fi_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("fi_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


fi = load_module()
fi.MIN_INTERVAL_S = 0.0
fi.RETRY_BASE_SECONDS = 0.0


HISKI_PARISHES_HTML = """
<HTML><BODY><FORM><SELECT NAME=srk>
<OPTION VALUE="0001">Ahlainen
<OPTION VALUE="0012">Anjala
<OPTION VALUE="0565">Turku - Åbo
<OPTION VALUE="24">24 - Penal institutions
</SELECT></FORM></BODY></HTML>
""".encode("iso-8859-1")

HISKI_SEARCH_HTML = """
<HTML><BODY>
<FONT SIZE="+2"><B>Anjala - christened</B></FONT><BR>
<TABLE BORDER=1 CELLSPACING=0>
<TR><TH>Born <TH>Christened <TH>Village <TH>Farm <TH>Father <TH>Mother <TH>Child<BR>
<TR><TD><a href="/hiski?en+0012+kastetut+446"><img src="/historia/sl2.gif"></a>18.1.1800 <TD>19.1.1800 <TD>Korhonen <TD>&nbsp; <TD> Anders  Korhonen <TD> Maria Isaksdr &nbsp; <TD>Anna<BR>
<TR><TD><TD COLSPAN=6>original - ALKUPKOMM: twin
</TABLE>
<P>A total of 1 events found.<P>
</BODY></HTML>
""".encode("iso-8859-1")

HISKI_EVENT_HTML = """
<HTML><BODY>
<H2>Ahlainen</H2>
<H3>Christened</H3>
<P><A HREF="/hiski?en+t149288">Link to this event</A> [ 149288 ]</P>
<TABLE BORDER=4 BGCOLOR="#F5F5F5">
<TR><TD><SMALL>Born / Christened</SMALL> <TD COLSPAN=2>1.1.1750 <TD COLSPAN=3>1.1.1750</TD></TR>
<TR><TD><SMALL>Village / Farm</SMALL> <TD COLSPAN=2>Bocköö <TD COLSPAN=3>&nbsp;</TD></TR>
<TR><TD><SMALL>Father</SMALL> <TD>Tp: <TD>Anders <TD>Johanss: <TD>&nbsp; <TD>&nbsp;</TD></TR>
<TR><TD><SMALL>Mother</SMALL> <TD>&nbsp; <TD>Maria <TD>Eskilsd:r <TD>&nbsp; <TD>&nbsp;</TD></TR>
<TR><TD><SMALL>Child</SMALL> <TD COLSPAN=5>Johan
<TR><TD><SMALL>Links</SMALL> <TD COLSPAN=5><A HREF="http://www.sukuhistoria.fi/sshy/sivut/HisKi-digiarkisto.php?plid=0001&year=1750">SSHY - Digiarkisto</A>
</TABLE>
</BODY></HTML>
""".encode("iso-8859-1")

DIGIHAKEMISTO_SEARCH_HTML = """
<html><body><table border>
<tr><th>Arkisto</th><th>Kommentti</th></tr>
<tr class="searchrow arkisto">
  <td class="searchtarget arkisto">
    <a class="aineisto" href="/aineisto/1299923671">
      <span class="searchtarget ">Turun suomalaisen seurakunnan arkisto</span>
    </a>
  <td>
    <span class="searchtarget searchtarget2">1680-1910 // Åbo finska församling</span>
<tr class="searchrow arkisto">
  <td class="searchtarget arkisto">
    <a class="aineisto" href="/aineisto/1299898549">
      <span class="searchtarget nodigi">Turun katolisen seurakunnan arkisto</span>
    </a>
  <td>
    <span class="searchtarget searchtarget2">1930-1934 // ei digitoitu</span>
</table></body></html>
"""

DIGIHAKEMISTO_ARCHIVE_HTML = """
<html><head><title>Turun suomalaisen seurakunnan arkisto</title></head><body>
<a id="alkup" href="https://astia.narc.fi/uusiastia/kortti_aineisto.html?id=1299923671">Astia</a>
<span class="tieto">Digitized parish church books.</span>
<table border>
<tr class="searchrow">
  <td><a class="aineisto" href="/aineisto/1299937880"><span class="searchtarget ">I VÄESTÖREKISTERIARKISTO</span></a>
  <td><span class="searchtarget searchtarget2">Rippikirjat 1700-1850</span>
<tr class="searchrow">
  <td><a class="aineisto" href="/aineisto/1299937881"><span class="searchtarget nodigi">II HALLINTOARKISTO</span></a>
  <td><span class="searchtarget searchtarget2">ei digitoitu</span>
</table></body></html>
"""


class TestFinnishArchivesCli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.env_patch = patch.dict(
            os.environ,
            {"KINLOOM_FI_ARCHIVES_CACHE_DIR": self.tmp.name},
            clear=False,
        )
        self.env_patch.start()

    def tearDown(self) -> None:
        self.env_patch.stop()
        self.tmp.cleanup()

    def _run(self, argv: list[str]) -> tuple[int, str, str]:
        out = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = fi.main(argv)
        return code, out.getvalue(), err.getvalue()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport, follow_redirects=True)

    def test_parishes_and_hiski_search_cache_with_boolean_cache_hit(self) -> None:
        calls: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append((request.method, str(request.url)))
            if request.method == "GET" and "en+A00" in str(request.url):
                return httpx.Response(200, content=HISKI_PARISHES_HTML, headers={"content-type": "text/html"})
            if request.method == "POST" and str(request.url) == fi.HISKI_ENDPOINT:
                return httpx.Response(200, content=HISKI_SEARCH_HTML, headers={"content-type": "text/html"})
            return httpx.Response(404, text="not found")

        with patch.object(fi, "_client", self._mock_client(handler)):
            c1, out1, err1 = self._run(["parishes", "--query", "Turku", "--json"])
            c2, out2, err2 = self._run(["parishes", "--query", "Anjala", "--json"])
            s1, sout1, serr1 = self._run(
                ["hiski", "--parish", "Anjala", "--book", "births", "--surname", "Korhonen", "--from-year", "1800", "--json"]
            )
            s2, sout2, serr2 = self._run(
                ["hiski", "--parish", "0012", "--book", "christened", "--surname", "Korhonen", "--from-year", "1800", "--json"]
            )

        self.assertEqual(c1, 0, err1)
        self.assertEqual(c2, 0, err2)
        self.assertEqual(s1, 0, serr1)
        self.assertEqual(s2, 0, serr2)
        # 1 GET for parishes (reused for query=Anjala AND parish resolution) + 1 POST for hiski search
        self.assertEqual(len(calls), 2)

        p1 = json.loads(out1)
        p2 = json.loads(out2)
        self.assertIs(p1["cache_hit"], False)
        self.assertIs(p2["cache_hit"], True)
        self.assertEqual(p1["total"], 3)
        self.assertEqual(p1["parishes"][0]["code"], "0565")

        h1 = json.loads(sout1)
        h2 = json.loads(sout2)
        self.assertIs(h1["cache_hit"], False)
        self.assertIs(h2["cache_hit"], True)
        self.assertEqual(h1["returned"], 1)
        self.assertEqual(h1["records"][0]["child"], "Anna")
        self.assertEqual(h1["records"][0]["father"], "Anders Korhonen")
        self.assertEqual(h1["records"][0]["comment"], "original - ALKUPKOMM: twin")

    def test_event_detail_parses_fields_and_sshy_link(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, content=HISKI_EVENT_HTML, headers={"content-type": "text/html"})

        with patch.object(fi, "_client", self._mock_client(handler)):
            c1, out1, err1 = self._run(["event", "0001/kastetut/418", "--json"])
            c2, out2, err2 = self._run(["event", "https://hiski.genealogia.fi/hiski?en+0001+kastetut+418", "--json"])

        self.assertEqual(c1, 0, err1)
        self.assertEqual(c2, 0, err2)
        self.assertEqual(calls, 1)
        d1 = json.loads(out1)
        d2 = json.loads(out2)
        self.assertIs(d1["cache_hit"], False)
        self.assertIs(d2["cache_hit"], True)
        self.assertEqual(d1["parish"], "Ahlainen")
        self.assertEqual(d1["permalink_id"], "t149288")
        self.assertEqual(d1["fields"]["Child"], "Johan")
        self.assertIn("sukuhistoria.fi", d1["sshy_url"])

    def test_digihakemisto_archives_and_archive_inspect_cache_and_filter_digitized(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if str(request.url) == fi.DIGIHAKEMISTO_SEARCH_URL:
                return httpx.Response(200, text=DIGIHAKEMISTO_SEARCH_HTML)
            if str(request.url).endswith("/aineisto/1299923671"):
                return httpx.Response(200, text=DIGIHAKEMISTO_ARCHIVE_HTML)
            return httpx.Response(404, text="missing")

        with patch.object(fi, "_client", self._mock_client(handler)):
            c1, out1, err1 = self._run(["archives", "Turun seurakun*", "--json"])
            c2, out2, err2 = self._run(["archives", "Turun seurakun*", "--digitized", "--json"])
            c3, out3, err3 = self._run(["archive", "1299923671", "--digitized", "--json"])
            c4, out4, err4 = self._run(["archive", "https://digihakemisto.net/aineisto/1299923671", "--json"])

        self.assertEqual(c1, 0, err1)
        self.assertEqual(c2, 0, err2)
        self.assertEqual(c3, 0, err3)
        self.assertEqual(c4, 0, err4)
        self.assertEqual(calls, 2)

        a1 = json.loads(out1)
        a2 = json.loads(out2)
        self.assertIs(a1["cache_hit"], False)
        self.assertIs(a2["cache_hit"], True)
        self.assertEqual(a1["returned"], 2)
        self.assertEqual(a2["returned"], 1)
        self.assertEqual(a2["archives"][0]["id"], "1299923671")

        i1 = json.loads(out3)
        i2 = json.loads(out4)
        self.assertIs(i1["cache_hit"], False)
        self.assertIs(i2["cache_hit"], True)
        self.assertEqual(i1["returned_children"], 1)
        self.assertEqual(i2["returned_children"], 2)
        self.assertEqual(i1["children"][0]["id"], "1299937880")

    def test_retries_transient_429_and_refuses_challenges_without_caching(self) -> None:
        calls = 0
        mode = {"step": "retry"}

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if mode["step"] == "retry":
                if calls == 1:
                    return httpx.Response(429, headers={"Retry-After": "0"}, text="slow down")
                return httpx.Response(200, content=HISKI_EVENT_HTML, headers={"content-type": "text/html"})
            return httpx.Response(200, text="<html><body>Processing JavaScript challenge..</body></html>")

        with patch.object(fi, "_client", self._mock_client(handler)):
            c1, out1, err1 = self._run(["event", "0001/kastetut/418", "--json"])
            mode["step"] = "challenge"
            c2, _out2, err2 = self._run(["event", "0001/kastetut/418", "--refresh", "--json"])

        self.assertEqual(c1, 0, err1)
        self.assertEqual(calls, 3)
        self.assertEqual(json.loads(out1)["parish"], "Ahlainen")
        self.assertEqual(c2, 1)
        self.assertIn("challenge", err2.lower())

    def test_host_allowlist_path_traversal_and_offline_urls(self) -> None:
        bad_event = self._run(["event", "../etc/passwd"])
        self.assertEqual(bad_event[0], 2)

        bad_arch = self._run(["archive", "../../secret"])
        self.assertEqual(bad_arch[0], 2)

        bad_host_event = self._run(["event", "https://evil.example/hiski?en+0001+kastetut+418"])
        self.assertEqual(bad_host_event[0], 2)
        self.assertIn("Refusing host", bad_host_event[2])

        def redirect_handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "digihakemisto.net":
                return httpx.Response(302, headers={"Location": "https://evil.example/x"})
            return httpx.Response(200, text="evil")

        with patch.object(fi, "_client", self._mock_client(redirect_handler)):
            blocked = self._run(["archive", "1299923671"])
        self.assertEqual(blocked[0], 2)
        self.assertIn("Refusing host", blocked[2])

        ucode, uout, uerr = self._run(["url", "--finna", "Turku kirkonkirjat", "--digi", "Turku 1850"])
        self.assertEqual(ucode, 0, uerr)
        self.assertIn("https://www.finna.fi/Search/Results?", uout)
        self.assertIn("https://digi.kansalliskirjasto.fi/search?", uout)


if __name__ == "__main__":
    unittest.main()
