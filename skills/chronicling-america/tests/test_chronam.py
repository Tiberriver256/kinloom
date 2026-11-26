from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from click.testing import CliRunner
import httpx


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "chronam"


def load_chronam_module():
    loader = SourceFileLoader("chronam_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("chronam_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


chronam = load_chronam_module()


class TestChronamCli(unittest.TestCase):
    def test_search_sends_at_search_results_and_aliases(self) -> None:
        captured: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured.append(request)
            return httpx.Response(
                200,
                json={
                    "search": {"hits": 1},
                    "results": [
                        {
                            "partof_title": ["Chicago daily tribune"],
                            "date": "1860-11-07",
                            "location_state": ["illinois"],
                            "location_county": ["cook"],
                            "location_city": ["chicago"],
                            "number_lccn": ["sn84031490"],
                            "number_page": ["1"],
                            "url": "https://www.loc.gov/resource/sn84031490/1860-11-07/ed-1/?sp=1",
                            "id": "http://www.loc.gov/resource/sn84031490/1860-11-07/ed-1/?sp=1",
                        }
                    ],
                },
            )

        runner = CliRunner()
        mock_client = httpx.Client(transport=httpx.MockTransport(handler))
        orig_get_json = chronam._get_json

        def patched_get_json(url, params=None, *, timeout=chronam.DEFAULT_TIMEOUT, client=None):
            return orig_get_json(url, params=params, timeout=timeout, client=mock_client)

        with patch.object(chronam, "_get_json", side_effect=patched_get_json):
            res = runner.invoke(
                chronam.cli,
                [
                    "search",
                    "--terms",
                    "Lincoln",
                    "--date-from",
                    "1860",
                    "--date-to",
                    "1865",
                    "--state",
                    "Illinois",
                    "--per-page",
                    "5",
                    "--json",
                ],
            )
        mock_client.close()

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(len(captured), 1)
        params = dict(captured[0].url.params.multi_items())
        self.assertEqual(params["q"], "Lincoln")
        self.assertEqual(params["at"], "search,results")
        self.assertEqual(params["dates"], "1860/1865")
        self.assertEqual(params["c"], "5")
        self.assertEqual(params["fa"], "location_state:illinois")
        payload = json.loads(res.output)
        self.assertEqual(payload["hits"], 1)
        self.assertEqual(payload["results"][0]["title"], "Chicago daily tribune")

    def test_read_timeout_fails_fast_without_retrying(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ReadTimeout("The read operation timed out", request=request)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            t0 = time.monotonic()
            with self.assertRaises(chronam.click.ClickException) as ctx:
                chronam._get_json(chronam.COLLECTION_BASE, params=[("q", "Lincoln")], timeout=5.0, client=client)
            elapsed = time.monotonic() - t0

        self.assertEqual(attempts, 1)
        self.assertLess(elapsed, 2.0)
        self.assertIn("timed out after 5.0s", str(ctx.exception))
        self.assertIn("chronam url", str(ctx.exception))

    def test_503_retries_once_and_raises_actionable_error(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            return httpx.Response(503, text="Service Unavailable", request=request)

        with (
            patch.object(chronam.time, "sleep", return_value=None),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            with self.assertRaises(chronam.click.ClickException) as ctx:
                chronam._get_json(chronam.COLLECTION_BASE, params=[("q", "Lincoln")], timeout=8.0, client=client)

        self.assertEqual(attempts, 2)
        self.assertIn("HTTP 503", str(ctx.exception))

    def test_remote_protocol_error_recovers_on_retry(self) -> None:
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.RemoteProtocolError("peer closed connection", request=request)
            return httpx.Response(200, json={"search": {"hits": 2}, "results": []})

        with (
            patch.object(chronam.time, "sleep", return_value=None),
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
        ):
            data = chronam._get_json(chronam.COLLECTION_BASE, params=[("q", "Lincoln")], timeout=8.0, client=client)

        self.assertEqual(attempts, 2)
        self.assertEqual(data["search"]["hits"], 2)


if __name__ == "__main__":
    unittest.main()
