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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "wikitree"


def load_module():
    loader = SourceFileLoader("wikitree_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("wikitree_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_WIKITREE_CACHE_DIR"] = _TEST_CACHE.name

wt = load_module()

SEARCH_RESP = [
    {
        "status": 0,
        "total": 1,
        "matches": [
            {
                "Id": 100,
                "Name": "Lincoln-1",
                "FirstName": "Abraham",
                "LastNameAtBirth": "Lincoln",
                "BirthDate": "1809-02-12",
                "DeathDate": "1865-04-15",
                "BirthLocation": "Hardin County, Kentucky",
            }
        ],
    }
]

PERSON_RESP = [
    {
        "status": 0,
        "person": {
            "Id": 100,
            "Name": "Lincoln-1",
            "FirstName": "Abraham",
            "LastNameAtBirth": "Lincoln",
            "BirthDate": "1809-02-12",
            "DeathDate": "1865-04-15",
            "BirthLocation": "Hardin County, Kentucky",
        },
    }
]

BIO_RESP = [{"status": 0, "bio": "== Biography ==\nBorn in Kentucky."}]


class TestWikiTreeCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_WIKITREE_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mock_client(self, handler):
        transport = httpx.MockTransport(handler)
        return lambda: httpx.Client(transport=transport)

    def test_search_and_person_cache_with_zero_repeat_http_calls(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            action = request.url.params.get("action")
            if action == "searchPerson":
                return httpx.Response(200, json=SEARCH_RESP)
            if action == "getPerson":
                return httpx.Response(200, json=PERSON_RESP)
            return httpx.Response(200, json=BIO_RESP)

        with patch.object(wt, "_client", self._mock_client(handler)):
            s1 = self.runner.invoke(
                wt.cli, ["search", "--first", "Abraham", "--last", "Lincoln", "--json"], env=self.env
            )
            s2 = self.runner.invoke(
                wt.cli, ["search", "--first", "Abraham", "--last", "Lincoln", "--json"], env=self.env
            )
            s3 = self.runner.invoke(
                wt.cli, ["search", "--first", "Abraham", "--last", "Lincoln"], env=self.env
            )
            p1 = self.runner.invoke(wt.cli, ["person", "Lincoln-1", "--json"], env=self.env)
            p2 = self.runner.invoke(wt.cli, ["person", "Lincoln-1"], env=self.env)
            b1 = self.runner.invoke(wt.cli, ["bio", "Lincoln-1", "--json"], env=self.env)
            b2 = self.runner.invoke(wt.cli, ["bio", "Lincoln-1", "--json"], env=self.env)

        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(s1.output)[0]["cache_hit"])
        self.assertTrue(json.loads(s2.output)[0]["cache_hit"])
        self.assertIn("[cache]", s3.output)
        self.assertFalse(json.loads(p1.output)[0]["cache_hit"])
        self.assertIn("[cache]", p2.output)
        self.assertFalse(json.loads(b1.output)[0]["cache_hit"])
        self.assertTrue(json.loads(b2.output)[0]["cache_hit"])

    def test_refresh_and_zero_ttl_bypass_cache(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json=PERSON_RESP)

        with patch.object(wt, "_client", self._mock_client(handler)):
            self.runner.invoke(wt.cli, ["person", "Lincoln-1", "--json"], env=self.env)
            r_ref = self.runner.invoke(
                wt.cli, ["person", "Lincoln-1", "--refresh", "--json"], env=self.env
            )
            r_ttl = self.runner.invoke(
                wt.cli, ["person", "Lincoln-1", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(r_ref.output)[0]["cache_hit"])
        self.assertFalse(json.loads(r_ttl.output)[0]["cache_hit"])

    def test_http_and_status_errors_are_never_cached(self) -> None:
        calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(503, text="service unavailable")
            if calls == 2:
                return httpx.Response(200, json=[{"status": "Illegal WikiTree ID"}])
            return httpx.Response(200, json=PERSON_RESP)

        with patch.object(wt, "_client", self._mock_client(handler)):
            r1 = self.runner.invoke(wt.cli, ["person", "Lincoln-1"], env=self.env)
            r2 = self.runner.invoke(wt.cli, ["person", "Lincoln-1"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r3 = self.runner.invoke(wt.cli, ["person", "Lincoln-1", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 1)
        self.assertNotIn("Traceback", r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 3)


if __name__ == "__main__":
    unittest.main()
