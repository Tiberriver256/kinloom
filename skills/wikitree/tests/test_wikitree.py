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

    def test_aliases_for_get_show_profile_search_flags_urls_and_help(self) -> None:
        seen_params: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_params.append(dict(request.url.params))
            action = request.url.params.get("action")
            if action == "searchPerson":
                return httpx.Response(200, json=SEARCH_RESP)
            if action == "getPerson":
                return httpx.Response(200, json=PERSON_RESP)
            return httpx.Response(200, json=BIO_RESP)

        with patch.object(wt, "_client", self._mock_client(handler)):
            # Positional full name + --birth-year + --birth-place + -n + --page.
            s1 = self.runner.invoke(
                wt.cli,
                [
                    "search",
                    "Abraham",
                    "Lincoln",
                    "--birth-year",
                    "1809",
                    "--birth-place",
                    "Kentucky",
                    "-n",
                    "5",
                    "--page",
                    "2",
                    "--json",
                ],
                env=self.env,
            )
            self.assertEqual(s1.exit_code, 0, s1.output)
            self.assertFalse(json.loads(s1.output)[0]["cache_hit"])
            self.assertEqual(seen_params[-1]["FirstName"], "Abraham")
            self.assertEqual(seen_params[-1]["LastName"], "Lincoln")
            self.assertEqual(seen_params[-1]["BirthDate"], "1809")
            self.assertEqual(seen_params[-1]["BirthLocation"], "Kentucky")
            self.assertEqual(seen_params[-1]["limit"], "5")
            self.assertEqual(seen_params[-1]["start"], "5")

            # Equivalent call using --given/--surname/--born/--place/--rows/--offset hits disk cache.
            s2 = self.runner.invoke(
                wt.cli,
                [
                    "search",
                    "--given",
                    "Abraham",
                    "--surname",
                    "Lincoln",
                    "--born",
                    "1809",
                    "--place",
                    "Kentucky",
                    "--rows",
                    "5",
                    "--offset",
                    "5",
                    "--json",
                ],
                env=self.env,
            )
            self.assertEqual(s2.exit_code, 0, s2.output)
            self.assertTrue(json.loads(s2.output)[0]["cache_hit"])
            self.assertEqual(len(seen_params), 1)

            # `get`, `show`, and `profile` alias `person` and normalize WikiTree profile URLs.
            p_get = self.runner.invoke(
                wt.cli, ["get", "https://www.wikitree.com/wiki/Lincoln-1", "--json"], env=self.env
            )
            p_show = self.runner.invoke(wt.cli, ["show", "Lincoln-1", "--json"], env=self.env)
            p_prof = self.runner.invoke(wt.cli, ["profile", "Lincoln-1", "--json"], env=self.env)
            self.assertEqual(p_get.exit_code, 0, p_get.output)
            self.assertEqual(p_show.exit_code, 0, p_show.output)
            self.assertEqual(p_prof.exit_code, 0, p_prof.output)
            self.assertFalse(json.loads(p_get.output)[0]["cache_hit"])
            self.assertTrue(json.loads(p_show.output)[0]["cache_hit"])
            self.assertTrue(json.loads(p_prof.output)[0]["cache_hit"])
            self.assertEqual(seen_params[-1]["key"], "Lincoln-1")
            self.assertEqual(len(seen_params), 2)

            # Missing search filters exits 2 with a concrete example; -h works on root CLI.
            bad = self.runner.invoke(wt.cli, ["search"], env=self.env)
            self.assertEqual(bad.exit_code, 2)
            self.assertIn("search Abraham Lincoln", bad.output)
            help_res = self.runner.invoke(wt.cli, ["-h"], env=self.env)
            self.assertEqual(help_res.exit_code, 0)


if __name__ == "__main__":
    unittest.main()
