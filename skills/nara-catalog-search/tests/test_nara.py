from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from click.testing import CliRunner
import httpx


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "nara"


def load_nara_module():
    loader = SourceFileLoader("nara_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("nara_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


nara = load_nara_module()


class TestNaraWafAndParallelism(unittest.TestCase):
    def test_normalize_query_for_waf_retry(self) -> None:
        self.assertEqual(
            nara._normalize_query_for_waf_retry('"Merced" AND "24-7" AND "1940"'),
            "Merced 24-7 1940",
        )
        self.assertEqual(
            nara._normalize_query_for_waf_retry("Merced AND 24-7 AND 1940"),
            "Merced 24-7 1940",
        )
        self.assertEqual(
            nara._normalize_query_for_waf_retry('"Harriet Tubman"'),
            "Harriet Tubman",
        )
        self.assertIsNone(nara._normalize_query_for_waf_retry("Merced 24-7 1940"))
        self.assertIsNone(nara._normalize_query_for_waf_retry('""'))

    def test_api_get_json_raises_typed_error_on_html_waf(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers.get("accept"), "application/json")
            self.assertEqual(request.headers.get("user-agent"), nara.USER_AGENT)
            return httpx.Response(
                200,
                headers={"content-type": "text/html"},
                text="<!doctype html><html><body>WAF challenge</body></html>",
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(nara._NaraWafOrNonJsonError):
                nara._api_get_json("https://catalog.archives.gov/api/v2/records/search?q=test", "k", client=client)

    def test_api_get_json_raises_typed_error_on_403_html(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403,
                headers={"content-type": "text/html; charset=utf-8"},
                text="<html><body>Forbidden by WAF</body></html>",
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(nara._NaraWafOrNonJsonError):
                nara._api_get_json("https://catalog.archives.gov/api/v2/records/search?q=test", "k", client=client)

    def test_cmd_search_retries_waf_blocked_query_without_quotes_or_and(self) -> None:
        seen_urls: list[str] = []

        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            seen_urls.append(url)
            if "%22" in url or "AND" in url:
                raise nara._NaraWafOrNonJsonError(url, "text/html")
            return {
                "body": {
                    "hits": {
                        "total": {"value": 1},
                        "hits": [
                            {
                                "_source": {
                                    "record": {
                                        "naId": 123456,
                                        "title": "1940 Census Merced ED 24-7",
                                        "levelOfDescription": "fileUnit",
                                        "recordGroupNumber": 29,
                                    }
                                }
                            }
                        ],
                    }
                }
            }

        runner = CliRunner()
        with (
            patch.object(nara, "_api_get_json", side_effect=fake_api_get_json),
            patch.object(nara, "_browser_search_many", side_effect=AssertionError("browser fallback must not run")),
        ):
            res = runner.invoke(
                nara.cli,
                ["search", '"Merced" AND "24-7" AND "1940"', "--rg", "29", "--online", "--limit", "5", "--api-key", "test-key", "--json"],
            )

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(len(seen_urls), 2)
        self.assertIn("q=Merced%2024-7%201940", seen_urls[1])
        payload = nara.json.loads(res.output)
        self.assertEqual(payload["query"], '"Merced" AND "24-7" AND "1940"')
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["results"][0]["naId"], "123456")

    def test_cmd_search_falls_back_to_browser_only_for_failed_queries_preserving_order(self) -> None:
        def fake_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            if "AlwaysWaf" in url:
                raise nara._NaraWafOrNonJsonError(url, "text/html")
            naid = "111" if "Harriet" in url else "333"
            return {
                "body": {
                    "hits": {
                        "total": {"value": 1},
                        "hits": [{"_source": {"record": {"naId": naid, "title": f"Record {naid}"}}}],
                    }
                }
            }

        browser_calls: list[list[tuple[str | None, str]]] = []

        def fake_browser_search_many(pairs: list[tuple[str | None, str]]):
            browser_calls.append(pairs)
            return [
                {
                    "query": q,
                    "searchUrl": u,
                    "total": 1,
                    "results": [{"naId": "222", "title": "Browser Fallback Record", "url": "https://catalog.archives.gov/id/222"}],
                }
                for q, u in pairs
            ]

        runner = CliRunner()
        with (
            patch.object(nara, "_api_get_json", side_effect=fake_api_get_json),
            patch.object(nara, "_browser_search_many", side_effect=fake_browser_search_many),
        ):
            res = runner.invoke(
                nara.cli,
                ["search", "Harriet Tubman", "AlwaysWaf", "Clara Barton", "--api-key", "test-key", "--json"],
            )

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(len(browser_calls), 1)
        self.assertEqual(len(browser_calls[0]), 1)
        self.assertEqual(browser_calls[0][0][0], "AlwaysWaf")
        payloads = nara.json.loads(res.output)
        self.assertEqual([p["query"] for p in payloads], ["Harriet Tubman", "AlwaysWaf", "Clara Barton"])
        self.assertEqual([p["results"][0]["naId"] for p in payloads], ["111", "222", "333"])

    def test_cmd_search_and_cmd_get_parallelize_and_preserve_order(self) -> None:
        def slow_api_get_json(url: str, _api_key: str, *, client: httpx.Client | None = None):
            time.sleep(0.15)
            for tag in ("300398", "300357", "595367", "Harriet", "Clara", "Frederick"):
                if tag in url:
                    return {
                        "body": {
                            "hits": {
                                "total": {"value": 1},
                                "hits": [{"_source": {"record": {"naId": tag, "title": f"Title {tag}"}}}],
                            }
                        }
                    }
            raise AssertionError(f"Unexpected URL: {url}")

        runner = CliRunner()
        with patch.object(nara, "_api_get_json", side_effect=slow_api_get_json):
            t0 = time.perf_counter()
            res_search = runner.invoke(
                nara.cli,
                ["search", "Harriet", "Clara", "Frederick", "--api-key", "test-key", "--json"],
            )
            dt_search = time.perf_counter() - t0

            t1 = time.perf_counter()
            res_get = runner.invoke(
                nara.cli,
                ["get", "300398", "300357", "595367", "--api-key", "test-key", "--json"],
            )
            dt_get = time.perf_counter() - t1

        self.assertEqual(res_search.exit_code, 0, res_search.output)
        self.assertEqual(res_get.exit_code, 0, res_get.output)
        # Three 150ms calls run concurrently should complete well under 0.40s (serial would be >= 0.45s).
        self.assertLess(dt_search, 0.40)
        self.assertLess(dt_get, 0.40)
        search_payloads = nara.json.loads(res_search.output)
        self.assertEqual([p["query"] for p in search_payloads], ["Harriet", "Clara", "Frederick"])
        get_records = nara.json.loads(res_get.output)
        self.assertEqual([r["naId"] for r in get_records], ["300398", "300357", "595367"])


if __name__ == "__main__":
    unittest.main()
