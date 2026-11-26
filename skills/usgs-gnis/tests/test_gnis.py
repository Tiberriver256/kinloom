from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from click.testing import CliRunner


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "gnis"


def load_gnis_module():
    loader = SourceFileLoader("gnis_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("gnis_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


gnis = load_gnis_module()


def _make_gnis_zip(rows: list[dict[str, str]]) -> bytes:
    columns = [
        "feature_id",
        "feature_name",
        "feature_class",
        "state_name",
        "county_name",
        "map_name",
        "prim_lat_dec",
        "prim_long_dec",
        "date_created",
        "date_edited",
    ]
    lines = ["|".join(columns)]
    for row in rows:
        lines.append("|".join(row.get(col, "") for col in columns))
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("DomesticNames_CA.txt", "\n".join(lines) + "\n")
    return buf.getvalue()


class TestUsgsGnisCaching(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-gnis-test-")
        self.cache_root = Path(self._tmp.name) / "cache"
        self._env_patch = patch.dict(
            os.environ, {"KINLOOM_GNIS_CACHE_DIR": str(self.cache_root)}
        )
        self._env_patch.start()

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmp.cleanup()

    @staticmethod
    def _sample_rows(version: int = 1) -> list[dict[str, str]]:
        return [
            {
                "feature_id": "277544",
                "feature_name": "Merced",
                "feature_class": "Populated Place",
                "state_name": "California",
                "county_name": "Merced",
                "map_name": f"Merced v{version}",
                "prim_lat_dec": "37.3021632",
                "prim_long_dec": "-120.4829677",
                "date_created": "01/19/1981",
                "date_edited": "01/01/2026",
            },
            {
                "feature_id": "277516",
                "feature_name": "Fresno",
                "feature_class": "Populated Place",
                "state_name": "California",
                "county_name": "Fresno",
                "map_name": "Fresno South",
                "prim_lat_dec": "36.7477272",
                "prim_long_dec": "-119.7723661",
                "date_created": "01/19/1981",
                "date_edited": "01/01/2026",
            },
        ]

    def test_search_caches_query_and_state_zero_http_and_no_reparse(self) -> None:
        download_urls: list[str] = []
        load_calls: list[Path] = []
        real_load_rows = gnis._load_rows

        def fake_download(url: str) -> bytes:
            download_urls.append(url)
            return _make_gnis_zip(self._sample_rows(version=1))

        def spy_load_rows(path: Path) -> list[dict]:
            load_calls.append(path)
            return real_load_rows(path)

        runner = CliRunner()
        with (
            patch.object(gnis, "_download_zip", side_effect=fake_download),
            patch.object(gnis, "_load_rows", side_effect=spy_load_rows),
        ):
            # Cold search downloads state zip once and populates both CA.txt and _queries/<sha256>.json.
            r1 = runner.invoke(gnis.cli, ["search", "Merced", "--state", "CA", "--json"])
            self.assertEqual(r1.exit_code, 0, r1.output)
            self.assertEqual(len(download_urls), 1)
            self.assertEqual(len(load_calls), 1)
            self.assertTrue((self.cache_root / "CA.txt").is_file())
            query_files = list((self.cache_root / "_queries").glob("*.json"))
            self.assertEqual(len(query_files), 1)
            self.assertEqual(len(query_files[0].stem), 64)
            p1 = json.loads(r1.stdout)
            self.assertEqual(p1["matches"], 1)
            self.assertEqual(p1["results"][0]["feature_id"], "277544")

            # Warm JSON search hits _queries/<sha256>.json: ZERO HTTP and ZERO table parses.
            r2 = runner.invoke(gnis.cli, ["search", "Merced", "--state", "CA", "--json"])
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(download_urls), 1)
            self.assertEqual(len(load_calls), 1)
            self.assertEqual(json.loads(r2.stdout), p1)

            # Warm text search reuses the same cached query JSON with ZERO HTTP and ZERO table parses.
            r3 = runner.invoke(gnis.cli, ["search", "Merced", "--state", "CA"])
            self.assertEqual(r3.exit_code, 0, r3.output)
            self.assertEqual(len(download_urls), 1)
            self.assertEqual(len(load_calls), 1)
            self.assertIn("277544 | Merced (Populated Place)", r3.stdout)

            # Different query in same state reuses CA.txt with ZERO HTTP downloads.
            r4 = runner.invoke(gnis.cli, ["search", "Fresno", "--state", "CA", "--json"])
            self.assertEqual(r4.exit_code, 0, r4.output)
            self.assertEqual(len(download_urls), 1)
            self.assertEqual(len(load_calls), 2)
            self.assertEqual(json.loads(r4.stdout)["results"][0]["feature_id"], "277516")

    def test_search_refresh_and_ttl_override(self) -> None:
        download_urls: list[str] = []
        ver = {"n": 1}

        def fake_download(url: str) -> bytes:
            download_urls.append(url)
            return _make_gnis_zip(self._sample_rows(version=ver["n"]))

        runner = CliRunner()
        with patch.object(gnis, "_download_zip", side_effect=fake_download):
            r1 = runner.invoke(gnis.cli, ["search", "Merced", "--state", "CA", "--json"])
            self.assertEqual(r1.exit_code, 0, r1.output)
            self.assertEqual(len(download_urls), 1)
            self.assertEqual(json.loads(r1.stdout)["results"][0]["map_name"], "Merced v1")

            # --refresh bypasses query and state caches to fetch updated USGS data.
            ver["n"] = 2
            r2 = runner.invoke(
                gnis.cli, ["search", "Merced", "--state", "CA", "--refresh", "--json"]
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(download_urls), 2)
            self.assertEqual(json.loads(r2.stdout)["results"][0]["map_name"], "Merced v2")

            # --cache-ttl-hours 0 bypasses query cache (re-reads cached state table, 0 HTTP).
            real_load = gnis._load_rows
            load_count = {"n": 0}

            def counting_load(path: Path) -> list[dict]:
                load_count["n"] += 1
                return real_load(path)

            with patch.object(gnis, "_load_rows", side_effect=counting_load):
                r3 = runner.invoke(
                    gnis.cli,
                    [
                        "search",
                        "Merced",
                        "--state",
                        "CA",
                        "--cache-ttl-hours",
                        "0",
                        "--json",
                    ],
                )
            self.assertEqual(r3.exit_code, 0, r3.output)
            self.assertEqual(len(download_urls), 2)
            self.assertEqual(load_count["n"], 1)
            self.assertEqual(json.loads(r3.stdout)["results"][0]["map_name"], "Merced v2")

            # Negative TTL rejected with exit code 2.
            r_bad = runner.invoke(
                gnis.cli,
                ["search", "Merced", "--state", "CA", "--cache-ttl-hours", "-5"],
            )
            self.assertEqual(r_bad.exit_code, 2)

    def test_state_and_path_safety_validation(self) -> None:
        runner = CliRunner()
        for bad_state in ("../CA", "ZZ", "CA/../../etc"):
            res = runner.invoke(gnis.cli, ["search", "Merced", "--state", bad_state])
            self.assertNotEqual(res.exit_code, 0)

        for unsafe in ("../escape", "a/b.txt", "a\\b.txt", "..", "", "C:evil"):
            with self.assertRaises(ValueError):
                gnis.resolve_safe_child(self.cache_root, unsafe)


if __name__ == "__main__":
    unittest.main()
