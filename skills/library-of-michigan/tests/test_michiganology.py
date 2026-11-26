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


JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x11" * 32
JPEG_BYTES_V2 = b"\xff\xd8\xff\xe0" + b"\x22" * 40
JPEG_HEADERS = (
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: image/jpeg\r\n"
    'Content-Disposition: attachment; filename="certificate.jpg"\r\n'
    "\r\n"
)
HTML_HEADERS = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
HTML_BODY = b"<!DOCTYPE html><html><body>Just a moment</body></html>"


class TestMichiganologyDownloadCache(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_MICHIGANOLOGY_CACHE_DIR": self.tmp.name}
        self.calls = 0

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _patch_curl(self, body: bytes, headers: str, *, returncode: int = 0, status: str = "200"):
        def fake_run(cmd, **kwargs):
            self.calls += 1
            out_idx = cmd.index("-o")
            hdr_idx = cmd.index("-D")
            Path(cmd[hdr_idx + 1]).write_text(headers, encoding="utf-8")
            Path(cmd[out_idx + 1]).write_bytes(body)
            stdout = status if returncode == 0 else ""
            return subprocess.CompletedProcess(args=cmd, returncode=returncode, stdout=stdout, stderr="")

        return (
            patch.object(mich.shutil, "which", return_value="/usr/bin/curl"),
            patch.object(mich.subprocess, "run", side_effect=fake_run),
        )

    def _invoke(self, args: list[str]):
        return self.runner.invoke(mich.cli, args, env=self.env)

    def test_download_caches_then_hits_with_zero_second_curl(self) -> None:
        out1 = Path(self.tmp.name) / "first"
        out2 = Path(self.tmp.name) / "second"
        which, run = self._patch_curl(JPEG_BYTES, JPEG_HEADERS)
        with which, run:
            r1 = self._invoke(["download", "IO_abc123", "--out", str(out1), "--json"])
            r2 = self._invoke(["download", "IO_abc123", "--out", str(out2), "--json"])
            r3 = self._invoke(["download", "IO_abc123", "--out", str(out2), "--filename", "custom.jpg", "--json"])

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(r3.exit_code, 0, r3.output)
        self.assertEqual(self.calls, 1)
        first = json.loads(r1.output)
        second = json.loads(r2.output)
        third = json.loads(r3.output)
        self.assertEqual(first["item_id"], "IO_abc123")
        self.assertEqual(first["bytes"], len(JPEG_BYTES))
        self.assertEqual(first["filename"], "certificate.jpg")
        self.assertEqual(first["content_type"], "image/jpeg")
        self.assertFalse(first["cache_hit"])
        self.assertTrue(second["cache_hit"])
        self.assertEqual(second["filename"], "certificate.jpg")
        self.assertEqual((out1 / "certificate.jpg").read_bytes(), JPEG_BYTES)
        self.assertEqual((out2 / "certificate.jpg").read_bytes(), JPEG_BYTES)
        self.assertEqual(third["filename"], "certificate.jpg")
        self.assertEqual((out2 / "custom.jpg").read_bytes(), JPEG_BYTES)
        self.assertTrue((Path(self.tmp.name) / "files" / "IO_abc123" / "body").is_file())
        meta = json.loads((Path(self.tmp.name) / "files" / "IO_abc123" / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["filename"], "certificate.jpg")
        self.assertEqual(meta["content_type"], "image/jpeg")

    def test_refresh_refetches_and_zero_ttl_does_not_read_cache(self) -> None:
        state = {"body": JPEG_BYTES}
        out = Path(self.tmp.name) / "out"

        def fake_run(cmd, **kwargs):
            self.calls += 1
            out_idx = cmd.index("-o")
            hdr_idx = cmd.index("-D")
            Path(cmd[hdr_idx + 1]).write_text(JPEG_HEADERS, encoding="utf-8")
            Path(cmd[out_idx + 1]).write_bytes(state["body"])
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="200", stderr="")

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run):
            self._invoke(["download", "IO_abc123", "--out", str(out), "--json"])
            state["body"] = JPEG_BYTES_V2
            refreshed = self._invoke(["download", "IO_abc123", "--out", str(out), "--refresh", "--json"])
            ttl = self._invoke(
                ["download", "IO_abc123", "--out", str(out), "--cache-ttl-hours", "0", "--json"]
            )

        self.assertEqual(self.calls, 3)
        self.assertEqual(refreshed.exit_code, 0, refreshed.output)
        self.assertFalse(json.loads(refreshed.output)["cache_hit"])
        self.assertEqual((out / "certificate.jpg").read_bytes(), JPEG_BYTES_V2)
        self.assertEqual(json.loads(ttl.output)["bytes"], len(JPEG_BYTES_V2))
        self.assertFalse(json.loads(ttl.output)["cache_hit"])

    def test_html_empty_and_curl_errors_are_not_cached(self) -> None:
        out = Path(self.tmp.name) / "out"
        which, run = self._patch_curl(HTML_BODY, HTML_HEADERS)
        with which, run:
            html_result = self._invoke(["download", "IO_abc123", "--out", str(out), "--json"])
            again = self._invoke(["download", "IO_abc123", "--out", str(out)])
        self.assertEqual(html_result.exit_code, 1, html_result.output)
        self.assertEqual(again.exit_code, 1, again.output)
        self.assertNotIn("Traceback", html_result.output)
        self.assertIn("HTML", html_result.output)
        self.assertEqual(self.calls, 2)
        self.assertFalse((Path(self.tmp.name) / "files" / "IO_abc123" / "body").exists())
        self.assertFalse((Path(self.tmp.name) / "files" / "IO_abc123" / "meta.json").exists())
        self.assertFalse(out.exists())

        self.calls = 0
        which, run = self._patch_curl(b"", JPEG_HEADERS)
        with which, run:
            empty = self._invoke(["download", "IO_empty1", "--out", str(out)])
        self.assertEqual(empty.exit_code, 1, empty.output)
        self.assertIn("empty", empty.output)
        self.assertFalse((Path(self.tmp.name) / "files" / "IO_empty1" / "body").exists())

        self.calls = 0
        which, run = self._patch_curl(JPEG_BYTES, JPEG_HEADERS, returncode=7)
        with which, run:
            failed = self._invoke(["download", "IO_fail1", "--out", str(out)])
        self.assertEqual(failed.exit_code, 1, failed.output)
        self.assertIn("curl exit 7", failed.output)
        self.assertFalse((Path(self.tmp.name) / "files" / "IO_fail1" / "meta.json").exists())

    def test_explicit_file_out_writes_that_path(self) -> None:
        dest = Path(self.tmp.name) / "scans" / "plate.tiff"
        which, run = self._patch_curl(JPEG_BYTES, JPEG_HEADERS)
        with which, run:
            result = self._invoke(["download", "IO_abc123", "--out", str(dest)])
            text = self._invoke(["download", "IO_abc123", "--out", str(Path(self.tmp.name) / "dir")])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(dest.read_bytes(), JPEG_BYTES)
        self.assertFalse(dest.is_dir())
        self.assertIn(str(dest), result.output)
        self.assertIn(f"({len(JPEG_BYTES)} bytes)", result.output)
        self.assertEqual(text.exit_code, 0, text.output)
        self.assertEqual(self.calls, 1)
        self.assertTrue((Path(self.tmp.name) / "dir" / "certificate.jpg").is_file())


class TestMichiganologyRetriesSafetyAndAliases(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = CliRunner()
        self.env = {"KINLOOM_MICHIGANOLOGY_CACHE_DIR": self.tmp.name}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_search_retries_on_429_retry_after_and_503_and_timeout(self) -> None:
        sleeps: list[float] = []
        attempt = 0

        def fake_run(cmd, **kwargs):
            nonlocal attempt
            attempt += 1
            hdr_path = Path(cmd[cmd.index("-D") + 1])
            if attempt == 1:
                hdr_path.write_text("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\n\r\n", encoding="utf-8")
                return _fake_proc("rate limited", 429)
            if attempt == 2:
                hdr_path.write_text("HTTP/1.1 503 Service Unavailable\r\n\r\n", encoding="utf-8")
                return _fake_proc("unavailable", 503)
            if attempt == 3:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=30)
            hdr_path.write_text("HTTP/1.1 200 OK\r\n\r\n", encoding="utf-8")
            return _fake_proc(SEARCH_HTML, 200)

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run), \
             patch.object(mich.time, "sleep", side_effect=sleeps.append):
            r1 = self.runner.invoke(mich.cli, ["search", "Lincoln", "--json"], env=self.env)
            r2 = self.runner.invoke(mich.cli, ["search", "Lincoln", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(attempt, 4)
        self.assertEqual(len(sleeps), 3)
        self.assertAlmostEqual(sleeps[0], 3.0, places=3)
        self.assertGreater(sleeps[1], 0.0)
        self.assertGreater(sleeps[2], 0.0)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertTrue(json.loads(r2.output)["cache_hit"])

    def test_get_retries_on_503_and_curl_timeout_exit_28(self) -> None:
        sleeps: list[float] = []
        attempt = 0

        def fake_run(cmd, **kwargs):
            nonlocal attempt
            attempt += 1
            hdr_path = Path(cmd[cmd.index("-D") + 1])
            if attempt == 1:
                return subprocess.CompletedProcess(args=cmd, returncode=28, stdout="", stderr="Operation timed out")
            if attempt == 2:
                hdr_path.write_text("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\n\r\n", encoding="utf-8")
                return _fake_proc("busy", 503)
            hdr_path.write_text("HTTP/1.1 200 OK\r\n\r\n", encoding="utf-8")
            return _fake_proc(ITEM_HTML, 200)

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run), \
             patch.object(mich.time, "sleep", side_effect=sleeps.append):
            r1 = self.runner.invoke(mich.cli, ["get", "IO_abc123", "--json"], env=self.env)

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(attempt, 3)
        self.assertEqual(len(sleeps), 2)
        self.assertAlmostEqual(sleeps[1], 2.0, places=3)
        body = json.loads(r1.output)
        self.assertFalse(body["cache_hit"])
        self.assertEqual(body["metadata"]["County"], "Kent")

    def test_download_retries_on_429_and_503_and_caches_success(self) -> None:
        sleeps: list[float] = []
        attempt = 0
        out_dir = Path(self.tmp.name) / "dl"

        def fake_run(cmd, **kwargs):
            nonlocal attempt
            attempt += 1
            hdr_path = Path(cmd[cmd.index("-D") + 1])
            body_path = Path(cmd[cmd.index("-o") + 1])
            if attempt == 1:
                hdr_path.write_text("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 4\r\n\r\n", encoding="utf-8")
                body_path.write_bytes(b"slow down")
                return subprocess.CompletedProcess(
                    args=cmd, returncode=0,
                    stdout="429\nhttps://michigan.access.preservica.com/download/file/IO_abc123",
                    stderr="",
                )
            if attempt == 2:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=60)
            hdr_path.write_text(JPEG_HEADERS, encoding="utf-8")
            body_path.write_bytes(JPEG_BYTES)
            return subprocess.CompletedProcess(
                args=cmd, returncode=0,
                stdout="200\nhttps://michigan.access.preservica.com/download/file/IO_abc123",
                stderr="",
            )

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run), \
             patch.object(mich.time, "sleep", side_effect=sleeps.append):
            r1 = self.runner.invoke(
                mich.cli, ["download", "IO_abc123", "--output", str(out_dir), "--json"], env=self.env
            )
            r2 = self.runner.invoke(
                mich.cli, ["fetch", "IO_abc123", "-o", str(out_dir), "--json"], env=self.env
            )

        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertEqual(attempt, 3)
        self.assertEqual(len(sleeps), 2)
        self.assertAlmostEqual(sleeps[0], 4.0, places=3)
        self.assertFalse(json.loads(r1.output)["cache_hit"])
        self.assertTrue(json.loads(r2.output)["cache_hit"])
        self.assertEqual((out_dir / "certificate.jpg").read_bytes(), JPEG_BYTES)

    def test_host_allowlist_rejects_disallowed_urls_and_redirects(self) -> None:
        calls = 0

        def fake_redirect(cmd, **kwargs):
            nonlocal calls
            calls += 1
            return subprocess.CompletedProcess(
                args=cmd,
                returncode=0,
                stdout=f"{ITEM_HTML}{mich._STATUS_MARKER}200\nhttps://evil.invalid/uncategorized/IO_abc123/",
                stderr="",
            )

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_redirect):
            bad_host = self.runner.invoke(
                mich.cli, ["get", "https://evil.invalid/uncategorized/IO_abc123/"], env=self.env
            )
            bad_scheme = self.runner.invoke(
                mich.cli, ["get", "http://michigan.access.preservica.com/uncategorized/IO_abc123/"], env=self.env
            )
            bad_creds = self.runner.invoke(
                mich.cli, ["get", "https://user:pass@michigan.access.preservica.com/uncategorized/IO_abc123/"], env=self.env
            )
            self.assertEqual(calls, 0)
            bad_redir = self.runner.invoke(mich.cli, ["get", "IO_abc123"], env=self.env)

        self.assertEqual(bad_host.exit_code, 1)
        self.assertIn("disallowed host", bad_host.output)
        self.assertEqual(bad_scheme.exit_code, 1)
        self.assertIn("non-HTTPS", bad_scheme.output)
        self.assertEqual(bad_creds.exit_code, 1)
        self.assertEqual(bad_redir.exit_code, 1)
        self.assertIn("disallowed host", bad_redir.output)
        self.assertEqual(calls, 1)

    def test_download_rejects_path_traversal_and_sanitizes_server_filename(self) -> None:
        out_dir = Path(self.tmp.name) / "safe"
        traversal_headers = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: image/jpeg\r\n"
            'Content-Disposition: attachment; filename="../../escaped.jpg"\r\n'
            "\r\n"
        )

        def fake_run(cmd, **kwargs):
            Path(cmd[cmd.index("-D") + 1]).write_text(traversal_headers, encoding="utf-8")
            Path(cmd[cmd.index("-o") + 1]).write_bytes(JPEG_BYTES)
            return subprocess.CompletedProcess(
                args=cmd, returncode=0,
                stdout="200\nhttps://michigan.access.preservica.com/download/file/IO_abc123",
                stderr="",
            )

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run):
            bad_name = self.runner.invoke(
                mich.cli, ["download", "IO_abc123", "--out", str(out_dir), "--filename", "../escape.jpg"], env=self.env
            )
            bad_slash = self.runner.invoke(
                mich.cli, ["download", "IO_abc123", "--out", str(out_dir), "--filename", "sub/file.jpg"], env=self.env
            )
            bad_out = self.runner.invoke(
                mich.cli, ["download", "IO_abc123", "--out", str(out_dir / ".." / "escape.jpg")], env=self.env
            )
            sanitized = self.runner.invoke(
                mich.cli, ["download", "IO_abc123", "--out", str(out_dir), "--json"], env=self.env
            )

        self.assertEqual(bad_name.exit_code, 2, bad_name.output)
        self.assertEqual(bad_slash.exit_code, 2, bad_slash.output)
        self.assertEqual(bad_out.exit_code, 2, bad_out.output)
        self.assertEqual(sanitized.exit_code, 0, sanitized.output)
        payload = json.loads(sanitized.output)
        written = Path(payload["path"]).resolve()
        self.assertTrue(written.is_relative_to(out_dir.resolve()))
        self.assertEqual(written.name, "escaped.jpg")
        self.assertEqual(written.read_bytes(), JPEG_BYTES)

    def test_cli_flag_and_subcommand_aliases_and_broken_pipe(self) -> None:
        def fake_run(cmd, **kwargs):
            url_arg = cmd[-1]
            if "/?s=" in url_arg:
                return _fake_proc(SEARCH_HTML, 200)
            return _fake_proc(ITEM_HTML, 200)

        with patch.object(mich.shutil, "which", return_value="/usr/bin/curl"), \
             patch.object(mich.subprocess, "run", side_effect=fake_run):
            multi_word = self.runner.invoke(
                mich.cli, ["search", "Abraham", "Lincoln", "-n", "1", "--json"], env=self.env
            )
            q_opt = self.runner.invoke(
                mich.cli, ["search", "-q", "Lincoln", "--json"], env=self.env
            )
            item_alias = self.runner.invoke(mich.cli, ["item", "IO_abc123", "--json"], env=self.env)
            show_alias = self.runner.invoke(mich.cli, ["show", "IO_abc123", "--json"], env=self.env)
            info_alias = self.runner.invoke(mich.cli, ["info", "IO_abc123", "--json"], env=self.env)

        self.assertEqual(multi_word.exit_code, 0, multi_word.output)
        self.assertEqual(json.loads(multi_word.output)["query"], "Abraham Lincoln")
        self.assertEqual(len(json.loads(multi_word.output)["results"]), 1)
        self.assertEqual(q_opt.exit_code, 0, q_opt.output)
        self.assertEqual(item_alias.exit_code, 0, item_alias.output)
        self.assertEqual(show_alias.exit_code, 0, show_alias.output)
        self.assertEqual(info_alias.exit_code, 0, info_alias.output)
        self.assertTrue(json.loads(show_alias.output)["cache_hit"])
        self.assertTrue(json.loads(info_alias.output)["cache_hit"])

        with patch.object(mich, "cli", side_effect=BrokenPipeError):
            self.assertEqual(mich.main(), 0)


if __name__ == "__main__":
    unittest.main()
