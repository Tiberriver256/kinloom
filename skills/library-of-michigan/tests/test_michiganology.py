from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from click.testing import CliRunner


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "michiganology"


def load_module():
    loader = SourceFileLoader("michiganology_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("michiganology_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


_TEST_CACHE = tempfile.TemporaryDirectory()
os.environ["KINLOOM_MICHIGANOLOGY_CACHE_DIR"] = _TEST_CACHE.name

mich = load_module()

SEARCH_HTML = (
    "<html><body><div>2 total results</div>"
    '<div class="result-item"><a href="https://michigan.access.preservica.com/uncategorized/IO_abc123/">'
    "Lincoln, Abraham (Death Certificate)</a></div>"
    "</body></html>"
)

ITEM_HTML = (
    "<html><body><h1>Lincoln, Abraham</h1>"
    '<span class="metadata-title">County:</span><span class="metadata-content">Kent</span>'
    '<a href="https://michigan.access.preservica.com/download/file/IO_abc123">Download</a>'
    "</body></html>"
)


def _fake_proc(body: str, status: int = 200, returncode: int = 0, stderr: str = ""):
    stdout = f"{body}{mich._STATUS_MARKER}{status}" if returncode == 0 else ""
    return subprocess.CompletedProcess(args=["curl"], returncode=returncode, stdout=stdout, stderr=stderr)


class TestMichiganologyCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_MICHIGANOLOGY_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_search_caches_and_second_run_makes_zero_curl_calls(self) -> None:
        calls = 0

        def fake_run(*args, **kwargs):
            nonlocal calls
            calls += 1
            return _fake_proc(SEARCH_HTML, 200)

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run):
            r1 = self.runner.invoke(mich.cli, ["search", "Lincoln", "--json"], env=self.env)
            r2 = self.runner.invoke(mich.cli, ["search", "Lincoln", "--json"], env=self.env)
            r3 = self.runner.invoke(mich.cli, ["search", "Lincoln"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 1)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertTrue(json.loads(r2.output)["cache_hit"])
        self.assertIn("[cache]", r3.output)

    def test_refresh_and_zero_ttl_bypass_cache(self) -> None:
        calls = 0

        def fake_run(*args, **kwargs):
            nonlocal calls
            calls += 1
            return _fake_proc(SEARCH_HTML, 200)

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run):
            self.runner.invoke(mich.cli, ["search", "Lincoln", "--json"], env=self.env)
            r_ref = self.runner.invoke(mich.cli, ["search", "Lincoln", "--refresh", "--json"], env=self.env)
            r_ttl = self.runner.invoke(
                mich.cli, ["search", "Lincoln", "--cache-ttl-hours", "0", "--json"], env=self.env
            )

        self.assertEqual(calls, 3)
        self.assertFalse(json.loads(r_ref.output)["cache_hit"])
        self.assertFalse(json.loads(r_ttl.output)["cache_hit"])

    def test_get_caches_item_details(self) -> None:
        calls = 0

        def fake_run(*args, **kwargs):
            nonlocal calls
            calls += 1
            return _fake_proc(ITEM_HTML, 200)

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run):
            r1 = self.runner.invoke(mich.cli, ["get", "IO_abc123", "--json"], env=self.env)
            r2 = self.runner.invoke(mich.cli, ["get", "IO_abc123"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(calls, 1)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertIn("[cache]", r2.output)
        self.assertIn("Kent", r2.output)

    def test_http_error_and_blocked_empty_page_are_never_cached(self) -> None:
        calls = 0

        def fake_run(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return _fake_proc("forbidden", 403)
            if calls == 2:
                return _fake_proc("<html><body>Maintenance</body></html>", 200)
            return _fake_proc(SEARCH_HTML, 200)

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run):
            r1 = self.runner.invoke(mich.cli, ["search", "Lincoln"], env=self.env)
            r2 = self.runner.invoke(mich.cli, ["search", "Lincoln", "--json"], env=self.env)
            self.assertEqual(list(Path(self.tmp.name).glob("*.json")), [])
            r3 = self.runner.invoke(mich.cli, ["search", "Lincoln", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 1)
        self.assertNotIn("Traceback", r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(calls, 3)
        self.assertEqual(len(list(Path(self.tmp.name).glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
