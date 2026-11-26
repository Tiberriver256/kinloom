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

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "se_archives.py"


def load_module():
    loader = SourceFileLoader("se_archives_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("se_archives_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


se = load_module()

SAMPLE_SEARCH_RESPONSE = {
    "totalHits": 2,
    "hits": 2,
    "offset": 0,
    "items": [
        {
            "id": "Tij9jjX9rH6cxG02H087k3",
            "objectType": "Record",
            "type": "Volume",
            "metadata": {
                "referenceCode": "SE/ULA/10392/A I a/9",
                "hierarchy": [
                    {"caption": "Uppsala domkyrkoförsamlings kyrkoarkiv"},
                    {"caption": "Husförhörslängder"},
                ],
                "archivalInstitution": [{"caption": "Riksarkivet i Uppsala"}],
                "date": "1887 - 1896",
                "onlyDigitisedMaterials": True,
            },
            "_links": {
                "self": "http://data.riksarkivet.se/archive/Tij9jjX9rH6cxG02H087k3",
            },
        },
        {
            "id": "VolTranscribed001",
            "objectType": "Record",
            "type": "Volume",
            "metadata": {
                "referenceCode": "SE/ULA/10102/A I b/8",
                "date": "1848 - 1851",
                "onlyDigitisedMaterials": True,
            },
            "transcribedText": {
                "snippets": [
                    {
                        "text": "Anders <em>Andersson</em> i Garphyttan",
                        "pages": [{"id": "_A0030423_00003", "width": 5446, "height": 4634}],
                    }
                ]
            },
            "_links": {"self": "https://data.riksarkivet.se/archive/VolTranscribed001"},
        },
    ],
}

SAMPLE_BIRTHS_RESPONSE = {
    "totalHits": 1,
    "hits": 1,
    "offset": 0,
    "items": [
        {
            "id": "HcyoChOvigzCJOoDJWqC3",
            "objectType": "Register",
            "type": "BirthRecord",
            "caption": "Erik Johan",
            "metadata": {
                "date": "1894-11-20",
                "childsName": "Erik Johan",
                "fathersName": "Andersson, Anders",
                "mothersName": "Persdotter, Karin",
                "parish": "Helsingborg Stad",
            },
            "_links": {
                "self": "https://data.riksarkivet.se/register/HcyoChOvigzCJOoDJWqC3",
                "image": ["https://lbiiif.riksarkivet.se/arkis!00124895/manifest"],
            },
        }
    ],
}

SAMPLE_MARRIAGES_RESPONSE = {
    "totalHits": 1,
    "hits": 1,
    "offset": 0,
    "items": [
        {
            "id": "LcbdSsLiNp8tEJOsC1",
            "objectType": "Register",
            "type": "MarriageRecord",
            "caption": "Johansson, Erik - Persdotter, Karin",
            "metadata": {
                "groomsName": "Johansson, Erik",
                "bridesName": "Persdotter, Karin",
                "parish": "Vänge",
                "date": "1841-07-04",
            },
            "_links": {"self": "https://data.riksarkivet.se/register/LcbdSsLiNp8tEJOsC1"},
        }
    ],
}

SAMPLE_DEEDS_RESPONSE = {
    "totalHits": 1,
    "hits": 1,
    "offset": 0,
    "items": [
        {
            "id": "J65dPc5oT5yO1",
            "objectType": "Register",
            "type": "IndexOfTitleDeedsRecord",
            "caption": "Akebäck - Bäcks",
            "metadata": {
                "parish": "Akebäck",
                "propertyName": "Bäcks",
                "taxUnit": "5/8",
                "year": "1810",
                "districtCourtSessions": "Sommarting",
            },
            "_links": {"self": "https://data.riksarkivet.se/register/J65dPc5oT5yO1"},
        }
    ],
}

SAMPLE_REGISTER_DETAIL = {
    "caption": "Erik Johan",
    "childsName": "Erik Johan",
    "date": "1894-11-20",
    "parish": "Helsingborg Stad",
    "fathersName": "Andersson, Anders",
    "mothersName": "Persdotter, Karin",
    "volume": "C I:17",
    "archive": "Helsingborgs stadsförsamlings (Maria) kyrkoarkiv (SE/LLA/13171)",
    "image": "https://lbiiif.riksarkivet.se/arkis!00124895/manifest",
    "type": "BirthRecord",
}

SAMPLE_COLLECTION_RESPONSE = {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    "id": "https://lbiiif.riksarkivet.se/collection/arkiv/39TJaymaweZJTe018W43t3",
    "type": "Collection",
    "label": {"sv": ["A I aa Husförhörslängder, Svartbäcksroten"]},
    "summary": {
        "sv": [
            "Referenskod: SE/ULA/11632/A I aa",
            "Arkivinstitution: Riksarkivet i Uppsala",
            "Datering: 1887-1896",
        ]
    },
    "items": [
        {
            "id": "https://lbiiif.riksarkivet.se/arkis!80002567/manifest",
            "type": "Manifest",
            "label": {"sv": ["8 (1887-1896) - 80002567 - S.D"]},
        }
    ],
}

SAMPLE_MANIFEST_RESPONSE = {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    "id": "https://lbiiif.riksarkivet.se/arkis!00124895/manifest",
    "type": "Manifest",
    "label": {
        "sv": ["Helsingborgs stadsförsamlings (Maria) kyrkoarkiv, SE/LLA/13171/C I/17 (1894)"],
    },
    "metadata": [
        {"label": {"sv": ["Arkiv"]}, "value": {"none": ["Helsingborgs stadsförsamlings kyrkoarkiv"]}},
        {"label": {"sv": ["Referenskod"]}, "value": {"none": ["SE/LLA/13171/C I/17"]}},
    ],
    "items": [
        {
            "id": "https://lbiiif.riksarkivet.se/arkis!00124895_00001/canvas",
            "type": "Canvas",
            "label": {"sv": ["Bild 1"]},
            "width": 2998,
            "height": 2125,
            "metadata": [
                {"label": {"sv": ["Bildid"]}, "value": {"none": ["00124895_00001"]}},
                {"label": {"sv": ["Länk"]}, "value": {"none": ["https://sok.riksarkivet.se/bildvisning/00124895_00001"]}},
                {
                    "label": {"sv": ["Källhänvisning"]},
                    "value": {"sv": ["SE/LLA/13171/C I/17 (1894), bildid: 00124895_00001"]},
                },
            ],
        }
    ],
}

MINIMAL_JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"


class TestSeArchivesCli(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.tmp.name) / "cache"
        self._env_patch = patch.dict(
            os.environ,
            {"KINLOOM_CACHE_DIR": str(self.cache_root)},
            clear=False,
        )
        self._env_patch.start()
        os.environ.pop("KINLOOM_SE_ARCHIVES_CACHE_DIR", None)
        os.environ.pop("KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS", None)

    def tearDown(self) -> None:
        self._env_patch.stop()
        self.tmp.cleanup()

    def _run(self, argv: list[str], handler=None) -> tuple[int, str, str]:
        out = io.StringIO()
        err = io.StringIO()
        if handler is None:
            with redirect_stdout(out), redirect_stderr(err):
                code = se.main(argv)
            return code, out.getvalue(), err.getvalue()

        transport = httpx.MockTransport(handler)
        client_factory = lambda: httpx.Client(transport=transport, follow_redirects=True)
        with (
            patch.object(se, "_client", client_factory),
            patch.object(se.time, "sleep", lambda _s: None),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            code = se.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_search_query_params_normalization_and_disk_cache(self) -> None:
        seen_params: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.host, "data.riksarkivet.se")
            self.assertEqual(request.url.path, "/api/records")
            seen_params.append(dict(request.url.params))
            return httpx.Response(200, json=SAMPLE_SEARCH_RESPONSE)

        args = [
            "search",
            "--transcribed",
            "Anders Andersson",
            "--type",
            "volume",
            "--year-min",
            "1840",
            "--year-max",
            "1896",
            "--json",
        ]
        c1, o1, e1 = self._run(args, handler)
        c2, o2, e2 = self._run(args, handler)
        c3, o3, e3 = self._run(args[:-1], handler)
        c4, o4, e4 = self._run([*args, "--refresh"], handler)

        self.assertEqual((c1, c2, c3, c4), (0, 0, 0, 0), f"{e1} {e2} {e3} {e4}")
        self.assertEqual(len(seen_params), 2)
        self.assertEqual(seen_params[0]["transcribed_text"], "Anders Andersson")
        self.assertEqual(seen_params[0]["only_digitised_materials"], "true")
        self.assertEqual(seen_params[0]["facet"], "ObjectType:Record;Type:Volume")
        self.assertEqual(seen_params[0]["year_min"], "1840")
        self.assertEqual(seen_params[0]["year_max"], "1896")

        p1 = json.loads(o1)
        p2 = json.loads(o2)
        p4 = json.loads(o4)
        self.assertFalse(p1["cache_hit"])
        self.assertTrue(p2["cache_hit"])
        self.assertFalse(p4["cache_hit"])
        self.assertEqual(p1["results"][0]["reference_code"], "SE/ULA/10392/A I a/9")
        self.assertEqual(p1["results"][0]["self_url"], "https://data.riksarkivet.se/archive/Tij9jjX9rH6cxG02H087k3")
        # Leading underscore in HTR page id is normalized for IIIF URLs.
        self.assertEqual(p1["results"][1]["snippets"][0]["pages"], ["A0030423_00003"])
        self.assertEqual(p1["results"][1]["snippets"][0]["text"], "Anders Andersson i Garphyttan")
        self.assertEqual(p1["results"][1]["iiif_manifests"], ["https://lbiiif.riksarkivet.se/arkis!A0030423/manifest"])
        self.assertIn("[cache]", o3)
        self.assertEqual(len(list((self.cache_root / "se-archives").glob("*.json"))), 1)

    def test_births_marriages_deeds_and_register_detail(self) -> None:
        seen_paths: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_paths.append(request.url.path)
            if request.url.path == "/api/records/birthrecords":
                self.assertEqual(request.url.params["first_name"], "Erik")
                self.assertEqual(request.url.params["fathers_name"], "Andersson")
                self.assertEqual(request.url.params["gender"], "Man")
                return httpx.Response(200, json=SAMPLE_BIRTHS_RESPONSE)
            if request.url.path == "/api/records/marriagerecords":
                self.assertEqual(request.url.params["grooms_name"], "Erik Johansson")
                self.assertEqual(request.url.params["brides_name"], "Karin Persdotter")
                return httpx.Response(200, json=SAMPLE_MARRIAGES_RESPONSE)
            if request.url.path == "/api/records/indexoftitledeeds":
                self.assertEqual(request.url.params["parish"], "Akebäck")
                return httpx.Response(200, json=SAMPLE_DEEDS_RESPONSE)
            if request.url.path == "/register/HcyoChOvigzCJOoDJWqC3":
                return httpx.Response(200, json=SAMPLE_REGISTER_DETAIL)
            return httpx.Response(404)

        cb, ob, eb = self._run(
            ["births", "--first", "Erik", "--father", "Andersson", "--gender", "male", "--json"], handler
        )
        cm, om, em = self._run(
            ["marriages", "--groom", "Erik Johansson", "--bride", "Karin Persdotter", "--json"], handler
        )
        cd, od, ed = self._run(["deeds", "--parish", "Akebäck", "--json"], handler)
        cr, or_, er = self._run(["record", "HcyoChOvigzCJOoDJWqC3", "--json"], handler)

        self.assertEqual((cb, cm, cd, cr), (0, 0, 0, 0), f"{eb} {em} {ed} {er}")
        self.assertEqual(json.loads(ob)["results"][0]["child_name"], "Erik Johan")
        self.assertEqual(
            json.loads(ob)["results"][0]["iiif_manifests"],
            ["https://lbiiif.riksarkivet.se/arkis!00124895/manifest"],
        )
        self.assertEqual(json.loads(om)["results"][0]["groom"], "Johansson, Erik")
        self.assertEqual(json.loads(od)["results"][0]["property_name"], "Bäcks")
        self.assertEqual(json.loads(or_)["record"]["volume"], "C I:17")
        self.assertEqual(len(seen_paths), 4)

    def test_collection_and_manifest_parsing_and_403_message(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/collection/arkiv/39TJaymaweZJTe018W43t3":
                return httpx.Response(200, json=SAMPLE_COLLECTION_RESPONSE)
            if request.url.path == "/arkis!00124895/manifest":
                return httpx.Response(200, json=SAMPLE_MANIFEST_RESPONSE)
            if request.url.path == "/arkis!C0003826/manifest":
                return httpx.Response(403, text="<html><body>Forbidden</body></html>")
            return httpx.Response(404)

        cc, oc, ec = self._run(["collection", "39TJaymaweZJTe018W43t3", "--json"], handler)
        cm, om, em = self._run(["manifest", "https://sok.riksarkivet.se/bildvisning/00124895_00001", "--json"], handler)
        cf, _of, ef = self._run(["manifest", "C0003826", "--json"], handler)

        self.assertEqual((cc, cm), (0, 0), f"{ec} {em}")
        coll = json.loads(oc)
        self.assertEqual(coll["reference_code"], "SE/ULA/11632/A I aa")
        self.assertEqual(coll["items"][0]["bildid"], "80002567")

        man = json.loads(om)
        self.assertEqual(man["bildid"], "00124895")
        self.assertEqual(man["canvas_count"], 1)
        self.assertEqual(man["canvases"][0]["page_id"], "00124895_00001")
        self.assertEqual(
            man["canvases"][0]["full_image_url"],
            "https://lbiiif.riksarkivet.se/arkis!00124895_00001/full/max/0/default.jpg",
        )

        self.assertEqual(cf, 1)
        self.assertIn("restricted on the public IIIF endpoint", ef)
        self.assertIn("https://sok.riksarkivet.se/bildvisning/C0003826", ef)

    def test_transient_retry_recovers_and_errors_are_never_cached(self) -> None:
        attempts = 0

        def flaky_handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, headers={"Retry-After": "0"})
            if attempts == 2:
                return httpx.Response(503)
            return httpx.Response(200, json=SAMPLE_BIRTHS_RESPONSE)

        c1, o1, e1 = self._run(["births", "--first", "Erik", "--json"], flaky_handler)
        self.assertEqual(c1, 0, e1)
        self.assertEqual(attempts, 3)
        self.assertFalse(json.loads(o1)["cache_hit"])

        def fail_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="server error")

        before = set((self.cache_root / "se-archives").glob("*.json"))
        c2, _o2, e2 = self._run(["births", "--first", "Karin", "--json"], fail_handler)
        after = set((self.cache_root / "se-archives").glob("*.json"))
        self.assertEqual(c2, 1)
        self.assertIn("HTTP 500", e2)
        self.assertEqual(before, after)

    def test_download_validates_jpeg_refuses_html_enforces_allowlist_and_blocks_traversal(self) -> None:
        out_jpg = Path(self.tmp.name) / "church-book.jpg"
        seen_urls: list[str] = []

        def jpeg_handler(request: httpx.Request) -> httpx.Response:
            seen_urls.append(str(request.url))
            return httpx.Response(
                200,
                content=MINIMAL_JPEG_BYTES,
                headers={"Content-Type": "image/jpeg"},
            )

        # 1. Valid JPEG download with --width, followed by idempotent skip without --overwrite.
        c1, o1, e1 = self._run(
            ["download", "00124895", "--page", "2", "--width", "1000", "--out", str(out_jpg), "--json"],
            jpeg_handler,
        )
        c2, o2, e2 = self._run(
            ["download", "00124895", "--page", "2", "--width", "1000", "--out", str(out_jpg), "--json"],
            jpeg_handler,
        )
        self.assertEqual((c1, c2), (0, 0), f"{e1} {e2}")
        self.assertEqual(len(seen_urls), 1)
        self.assertEqual(
            seen_urls[0],
            "https://lbiiif.riksarkivet.se/arkis!00124895_00002/full/1000,/0/default.jpg",
        )
        p1 = json.loads(o1)
        p2 = json.loads(o2)
        self.assertEqual(p1["format"], "jpeg")
        self.assertFalse(p1["skipped"])
        self.assertFalse(p1["cache_hit"])
        self.assertTrue(p2["skipped"])
        self.assertTrue(p2["cache_hit"])
        self.assertEqual(out_jpg.read_bytes(), MINIMAL_JPEG_BYTES)

        # 2. HTML returned with HTTP 200 is NEVER saved as an image.
        bad_jpg = Path(self.tmp.name) / "html-trap.jpg"

        def html_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                text="<!DOCTYPE html><html><body>Fel - IIIF</body></html>",
                headers={"Content-Type": "text/html; charset=utf-8"},
            )

        c_html, _o_html, e_html = self._run(
            ["download", "00124895_00001", "--full", "--out", str(bad_jpg)],
            html_handler,
        )
        self.assertEqual(c_html, 1)
        self.assertIn("Refusing to save HTML", e_html)
        self.assertFalse(bad_jpg.exists())

        # 3. Redirect to a non-allowlisted host is rejected.
        def evil_redirect_handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "lbiiif.riksarkivet.se":
                return httpx.Response(302, headers={"Location": "https://example.invalid/evil.jpg"})
            return httpx.Response(200, content=MINIMAL_JPEG_BYTES, headers={"Content-Type": "image/jpeg"})

        c_redir, _o_redir, e_redir = self._run(
            ["download", "00124895_00001", "--full", "--out", str(bad_jpg)],
            evil_redirect_handler,
        )
        self.assertEqual(c_redir, 2)
        self.assertIn("Refusing host", e_redir)
        self.assertFalse(bad_jpg.exists())

        # 4. Disallowed host URL, path traversal, and conflicting --width/--full exit 2.
        c_host, _o_host, e_host = self._run(
            ["download", "https://example.invalid/arkis!00124895_00001/full/max/0/default.jpg", "--out", str(bad_jpg)],
            jpeg_handler,
        )
        self.assertEqual(c_host, 2)
        self.assertIn("Refusing host", e_host)

        c_trav, _o_trav, e_trav = self._run(
            ["download", "00124895_00001", "--out", "../escape.jpg"],
            jpeg_handler,
        )
        self.assertEqual(c_trav, 2)
        self.assertIn("traversal", e_trav)

        c_both, _o_both, e_both = self._run(
            ["download", "00124895_00001", "--width", "800", "--full", "--out", str(bad_jpg)],
            jpeg_handler,
        )
        self.assertEqual(c_both, 2)
        self.assertIn("not both", e_both)

    def test_census_browser_only_helper_builds_urls_offline(self) -> None:
        code, out, err = self._run(
            ["census", "--surname", "Andersson", "--given", "Anders", "--year", "1890", "--parish", "Uppsala", "--json"]
        )
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "browser-only")
        self.assertIn("https://sok.riksarkivet.se/folkrakningar?", payload["census_url"])
        self.assertIn("Efternamn=Andersson", payload["census_url"])
        self.assertIn("Folk1890=true", payload["census_url"])
        self.assertIn("https://sok.riksarkivet.se/kyrkoarkiv?", payload["church_archives_url"])


if __name__ == "__main__":
    unittest.main()
