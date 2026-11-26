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


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "findagrave"


def load_fg_module():
    loader = SourceFileLoader("findagrave_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("findagrave_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


fg = load_fg_module()


def _sample_memorial(
    mid: str,
    first: str = "Abraham",
    last: str = "Lincoln",
    *,
    photos: list[dict] | None = None,
) -> dict:
    photo_items = photos if photos is not None else []
    return {
        "id": mid,
        "name": [{"first": first, "last": last, "maiden": None}],
        "birth": {"date": {"year": 1809, "month": 2, "day": 12, "circa": False}, "place": None},
        "death": {"date": {"year": 1865, "month": 4, "day": 15, "circa": False}, "place": None},
        "coordinates": {"lat": 39.823216, "lon": -89.655715},
        "cemetery": {
            "id": "107259",
            "names": [{"name": "Oak Ridge Cemetery"}],
            "memorialCount": 74982,
            "coordinates": {"lat": 39.8246994, "lon": -89.6592026},
            "physicalAddress": {"full": {"value": "1441 Monument Avenue"}},
        },
        "plot": "Lincoln Tomb",
        "inscription": None,
        "bio": None,
        "isVeteran": True,
        "hasGravePhoto": True,
        "hasPersonPhoto": True,
        "dateCreated": "2000-01-01",
        "dateModified": "2026-01-01",
        "relationships": [],
        "photos": {"total": len(photo_items), "photos": photo_items},
    }


class TestFindAGraveCli(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kinloom-fg-test-")
        self.cache_root = Path(self._tmp.name) / "cache"
        self.work_dir = Path(self._tmp.name) / "work"
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._env_patch = patch.dict(
            os.environ, {"KINLOOM_FINDAGRAVE_CACHE_DIR": str(self.cache_root)}
        )
        self._env_patch.start()

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmp.cleanup()

    def test_get_and_memorial_alias_emit_cemetery_coordinates(self) -> None:
        sample_data = {"memorialsById": [_sample_memorial("627")]}
        runner = CliRunner()
        for subcmd in ("get", "memorial"):
            with patch.object(fg, "gql", return_value=json.loads(json.dumps(sample_data))):
                res = runner.invoke(fg.cli, [subcmd, "627", "--json"])
            self.assertEqual(res.exit_code, 0, res.output)
            payload = json.loads(res.output)
            self.assertEqual(payload[0]["cemetery_lat"], 39.8246994)
            self.assertEqual(payload[0]["cemetery_lng"], -89.6592026)
            self.assertEqual(payload[0]["cemetery"]["lat"], 39.8246994)
            self.assertEqual(payload[0]["cemetery"]["lng"], -89.6592026)

    def test_cemetery_accepts_positional_id_and_emits_coordinates(self) -> None:
        sample_cem = {
            "cemeteries": {
                "total": 1,
                "cemeteries": [
                    {
                        "id": "107259",
                        "names": [{"name": "Oak Ridge Cemetery"}],
                        "memorialCount": 74982,
                        "coordinates": {"lat": 39.8246994, "lon": -89.6592026},
                    }
                ],
            }
        }
        runner = CliRunner()
        with patch.object(fg, "gql", return_value=sample_cem) as mock_gql:
            res = runner.invoke(fg.cli, ["cemetery", "107259", "--json"])
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(mock_gql.call_args[0][1], {"ids": ["107259"]})
        payload = json.loads(res.output)
        self.assertEqual(payload["cemeteries"][0]["lat"], 39.8246994)
        self.assertEqual(payload["cemeteries"][0]["lng"], -89.6592026)

    def test_memorial_cache_zero_http_partial_batch_and_refresh(self) -> None:
        gql_calls: list[dict] = []
        rev = {"n": 1}

        def fake_gql(_query: str, variables: dict) -> dict:
            gql_calls.append(variables)
            ids = variables.get("ids") or []
            items = []
            for mid in ids:
                if mid == "627":
                    items.append(_sample_memorial("627", f"Abraham v{rev['n']}", "Lincoln"))
                elif mid == "628":
                    items.append(_sample_memorial("628", "Mary", "Lincoln"))
            return {"memorialsById": items}

        runner = CliRunner()
        with patch.object(fg, "gql", side_effect=fake_gql):
            r1 = runner.invoke(fg.cli, ["get", "627", "--json"])
            self.assertEqual(r1.exit_code, 0, r1.output)
            self.assertIsInstance(json.loads(r1.output), list)
            self.assertEqual(len(gql_calls), 1)
            self.assertTrue((self.cache_root / "memorials" / "627.json").is_file())

            # Second call via alias makes ZERO GraphQL requests.
            r2 = runner.invoke(fg.cli, ["memorial", "627", "--json"])
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(gql_calls), 1)
            self.assertEqual(json.loads(r2.output)[0]["name"][0]["first"], "Abraham v1")

            # Batch of [627, 628] fetches ONLY 628 and preserves order.
            r3 = runner.invoke(fg.cli, ["get", "627", "628", "--json"])
            self.assertEqual(r3.exit_code, 0, r3.output)
            self.assertEqual(len(gql_calls), 2)
            self.assertEqual(gql_calls[1], {"ids": ["628"]})
            batch = json.loads(r3.output)
            self.assertEqual([m["id"] for m in batch], ["627", "628"])

            # --refresh bypasses cache and updates disk entry.
            rev["n"] = 2
            r4 = runner.invoke(fg.cli, ["get", "627", "--refresh", "--json"])
            self.assertEqual(r4.exit_code, 0, r4.output)
            self.assertEqual(len(gql_calls), 3)
            self.assertEqual(json.loads(r4.output)[0]["name"][0]["first"], "Abraham v2")

    def test_cemetery_cache_zero_http_and_refresh(self) -> None:
        gql_calls: list[dict] = []
        rev = {"n": 1}

        def fake_gql(_query: str, variables: dict) -> dict:
            gql_calls.append(variables)
            return {
                "cemeteries": {
                    "total": 1,
                    "cemeteries": [
                        {
                            "id": "107259",
                            "names": [{"name": f"Oak Ridge Cemetery v{rev['n']}"}],
                            "memorialCount": 74982,
                            "coordinates": {"lat": 39.8246994, "lon": -89.6592026},
                        }
                    ],
                }
            }

        runner = CliRunner()
        with patch.object(fg, "gql", side_effect=fake_gql):
            r1 = runner.invoke(fg.cli, ["cemetery", "107259", "--json"])
            self.assertEqual(r1.exit_code, 0, r1.output)
            self.assertEqual(len(gql_calls), 1)
            self.assertTrue((self.cache_root / "cemeteries" / "107259.json").is_file())
            self.assertFalse(json.loads(r1.output)["cache_hit"])

            # Second call makes ZERO GraphQL requests.
            r2 = runner.invoke(fg.cli, ["cemetery", "107259", "--json"])
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(gql_calls), 1)
            self.assertTrue(json.loads(r2.output)["cache_hit"])
            self.assertEqual(
                json.loads(r2.output)["cemeteries"][0]["names"][0]["name"],
                "Oak Ridge Cemetery v1",
            )

            # --refresh fetches fresh cemetery JSON.
            rev["n"] = 2
            r3 = runner.invoke(fg.cli, ["cemetery", "107259", "--refresh", "--json"])
            self.assertEqual(r3.exit_code, 0, r3.output)
            self.assertEqual(len(gql_calls), 2)
            self.assertEqual(
                json.loads(r3.output)["cemeteries"][0]["names"][0]["name"],
                "Oak Ridge Cemetery v2",
            )

    def test_photo_caches_files_across_dirs_and_prefixes_with_zero_http(self) -> None:
        gql_calls: list[dict] = []
        http_calls: list[str] = []
        img_rev = {"n": 1}

        photo_meta = [
            {
                "id": "9901",
                "type": "Grave",
                "caption": "Headstone",
                "path": "https://images.findagrave.com/photos/9901.jpg?size=full",
            }
        ]

        def fake_gql(_query: str, variables: dict) -> dict:
            gql_calls.append(variables)
            return {"memorialsById": [_sample_memorial("627", photos=photo_meta)]}

        def handler(request: httpx.Request) -> httpx.Response:
            http_calls.append(str(request.url))
            body = b"\xff\xd8\xff" + f"JPEG-BYTES-v{img_rev['n']}".encode()
            return httpx.Response(200, content=body, headers={"content-type": "image/jpeg"})

        def fake_photo_client() -> httpx.Client:
            return httpx.Client(transport=httpx.MockTransport(handler))

        out1 = self.work_dir / "bio-a"
        out2 = self.work_dir / "bio-b"
        out3 = self.work_dir / "bio-refresh"

        runner = CliRunner()
        with (
            patch.object(fg, "gql", side_effect=fake_gql),
            patch.object(fg, "_new_photo_client", side_effect=fake_photo_client),
        ):
            r1 = runner.invoke(
                fg.cli,
                [
                    "photo",
                    "627",
                    "--out",
                    str(out1),
                    "--prefix",
                    "lincoln-abraham",
                    "--metadata",
                ],
            )
            self.assertEqual(r1.exit_code, 0, r1.output)
            self.assertEqual(len(gql_calls), 1)
            self.assertEqual(len(http_calls), 1)
            self.assertTrue((self.cache_root / "photos" / "627" / "9901.jpg").is_file())
            self.assertEqual(
                (out1 / "lincoln-abraham_9901.jpg").read_bytes(), b"\xff\xd8\xffJPEG-BYTES-v1"
            )

            # Different --out and --prefix reuses BOTH memorial and photo caches -> ZERO HTTP requests!
            r2 = runner.invoke(
                fg.cli,
                ["photo", "627", "--out", str(out2), "--prefix", "lincoln-mary"],
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertEqual(len(gql_calls), 1)
            self.assertEqual(len(http_calls), 1)
            self.assertEqual(
                (out2 / "lincoln-mary_9901.jpg").read_bytes(), b"\xff\xd8\xffJPEG-BYTES-v1"
            )

            # --refresh bypasses both memorial and photo caches.
            img_rev["n"] = 2
            r3 = runner.invoke(
                fg.cli,
                ["photo", "627", "--out", str(out3), "--refresh"],
            )
            self.assertEqual(r3.exit_code, 0, r3.output)
            self.assertEqual(len(gql_calls), 2)
            self.assertEqual(len(http_calls), 2)
            self.assertEqual((out3 / "9901.jpg").read_bytes(), b"\xff\xd8\xffJPEG-BYTES-v2")

    def test_photo_json_cache_hit_refresh_ttl_and_html_rejection(self) -> None:
        gql_calls: list[dict] = []
        http_calls: list[str] = []
        mode = {"body": b"\xff\xd8\xffJPEG-OK", "type": "image/jpeg"}

        photo_meta = [
            {
                "id": "9901",
                "type": "Grave",
                "caption": "Headstone",
                "path": "https://images.findagrave.com/photos/9901.jpg",
            },
            {
                "id": "9902",
                "type": "Portrait",
                "caption": "Portrait",
                "path": "https://images.findagrave.com/photos/9902.jpg",
            },
        ]

        def fake_gql(_query: str, variables: dict) -> dict:
            gql_calls.append(variables)
            return {"memorialsById": [_sample_memorial("700", photos=photo_meta)]}

        def handler(request: httpx.Request) -> httpx.Response:
            http_calls.append(str(request.url))
            return httpx.Response(200, content=mode["body"], headers={"content-type": mode["type"]})

        def fake_photo_client() -> httpx.Client:
            return httpx.Client(transport=httpx.MockTransport(handler))

        out = self.work_dir / "photos-json"
        runner = CliRunner()
        with (
            patch.object(fg, "gql", side_effect=fake_gql),
            patch.object(fg, "_new_photo_client", side_effect=fake_photo_client),
        ):
            first = runner.invoke(
                fg.cli, ["photo", "700", "--out", str(out), "--type", "Grave", "--json"]
            )
            self.assertEqual(first.exit_code, 0, first.output)
            first_body = json.loads(first.output)
            self.assertEqual(first_body["memorial_id"], "700")
            self.assertFalse(first_body["cache_hit"])
            self.assertEqual(len(gql_calls), 1)
            self.assertEqual(len(http_calls), 1)
            self.assertEqual(first_body["files"], [
                {
                    "id": "9901",
                    "type": "Grave",
                    "caption": "Headstone",
                    "url": "https://images.findagrave.com/photos/9901.jpg",
                    "file": "9901.jpg",
                    "bytes": len(b"\xff\xd8\xffJPEG-OK"),
                    "cache_hit": False,
                }
            ])
            self.assertEqual((out / "9901.jpg").read_bytes(), b"\xff\xd8\xffJPEG-OK")

            second = runner.invoke(
                fg.cli, ["photo", "700", "--out", str(out), "--type", "Grave", "--json"]
            )
            self.assertEqual(second.exit_code, 0, second.output)
            second_body = json.loads(second.output)
            self.assertTrue(second_body["cache_hit"])
            self.assertTrue(second_body["files"][0]["cache_hit"])
            self.assertEqual(len(gql_calls), 1)
            self.assertEqual(len(http_calls), 1)

            refreshed = runner.invoke(
                fg.cli,
                ["photo", "700", "--out", str(out), "--type", "Grave", "--json", "--refresh"],
            )
            self.assertEqual(refreshed.exit_code, 0, refreshed.output)
            self.assertFalse(json.loads(refreshed.output)["cache_hit"])
            self.assertEqual(len(gql_calls), 2)
            self.assertEqual(len(http_calls), 2)

            expired = runner.invoke(
                fg.cli,
                [
                    "photo",
                    "700",
                    "--out",
                    str(out),
                    "--type",
                    "Grave",
                    "--json",
                    "--cache-ttl-hours",
                    "0",
                ],
            )
            self.assertEqual(expired.exit_code, 0, expired.output)
            self.assertFalse(json.loads(expired.output)["cache_hit"])
            self.assertEqual(len(gql_calls), 3)
            self.assertEqual(len(http_calls), 3)

            mode["body"] = b"<!DOCTYPE html><html><body>blocked</body></html>"
            mode["type"] = "text/html"
            html_out = self.work_dir / "photos-html"
            rejected = runner.invoke(
                fg.cli, ["photo", "700", "--out", str(html_out), "--type", "Portrait", "--json"]
            )
            self.assertNotEqual(rejected.exit_code, 0)
            self.assertFalse((self.cache_root / "photos" / "700" / "9902.jpg").exists())
            self.assertFalse((html_out / "9902.jpg").exists())
            start = rejected.output.find("{")
            end = rejected.output.rfind("}")
            self.assertGreaterEqual(start, 0, rejected.output)
            rejected_body = json.loads(rejected.output[start:end + 1])
            self.assertEqual(rejected_body["memorial_id"], "700")
            self.assertEqual(rejected_body["files"], [])
            self.assertFalse(rejected_body["cache_hit"])

            mode["body"] = b""
            mode["type"] = "image/jpeg"
            empty = runner.invoke(
                fg.cli, ["photo", "700", "--out", str(html_out), "--type", "Portrait", "--refresh"]
            )
            self.assertNotEqual(empty.exit_code, 0)
            self.assertFalse((self.cache_root / "photos" / "700" / "9902.jpg").exists())

            mode["body"] = b"portrait-bytes"
            mode["type"] = "image/jpeg"
            typed = runner.invoke(
                fg.cli, ["photo", "700", "--out", str(html_out), "--type", "Portrait", "--json"]
            )
            self.assertEqual(typed.exit_code, 0, typed.output)
            self.assertFalse(json.loads(typed.output)["cache_hit"])
            self.assertTrue((self.cache_root / "photos" / "700" / "9902.jpg.type").is_file())
            again = runner.invoke(
                fg.cli, ["photo", "700", "--out", str(html_out), "--all", "--json"]
            )
            self.assertEqual(again.exit_code, 0, again.output)
            again_body = json.loads(again.output)
            self.assertTrue(again_body["cache_hit"])
            self.assertEqual(
                [item["file"] for item in again_body["files"]], ["9901.jpg", "9902.jpg"]
            )
            self.assertEqual(len(http_calls), 6)
            self.assertEqual(len(gql_calls), 4)

    def test_id_prefix_and_filename_path_safety(self) -> None:
        runner = CliRunner()
        for bad_id in ("../627", "627/../../etc", "627\\bad", ".."):
            self.assertNotEqual(runner.invoke(fg.cli, ["get", bad_id]).exit_code, 0)
            self.assertNotEqual(runner.invoke(fg.cli, ["cemetery", bad_id]).exit_code, 0)
            self.assertNotEqual(runner.invoke(fg.cli, ["photo", bad_id]).exit_code, 0)

        bad_prefix = runner.invoke(
            fg.cli, ["photo", "627", "--prefix", "../escape", "--out", str(self.work_dir)]
        )
        self.assertNotEqual(bad_prefix.exit_code, 0)

        safe_name = fg.safe_photo_filename("../../evil", "https://example.com/pic.png?v=1")
        self.assertNotIn("/", safe_name)
        self.assertNotIn("..", safe_name)
        self.assertTrue(safe_name.endswith(".png"))

        for unsafe in ("../escape", "a/b.jpg", "a\\b.jpg", "..", "", "C:evil"):
            with self.assertRaises(ValueError):
                fg.resolve_safe_child(self.cache_root, unsafe)

    def test_search_and_subcommand_aliases_urls_and_get_cache_hit_items(self) -> None:
        seen_vars: list[dict] = []

        def fake_gql(_query: str, variables: dict) -> dict:
            seen_vars.append(variables)
            if "ids" in variables:
                ids = variables["ids"]
                if ids == ["107259"]:
                    return {
                        "cemeteries": {
                            "total": 1,
                            "cemeteries": [
                                {
                                    "id": "107259",
                                    "names": [{"name": "Oak Ridge Cemetery"}],
                                    "memorialCount": 10,
                                }
                            ],
                        }
                    }
                return {"memorialsById": [_sample_memorial(mid) for mid in ids]}
            if "s" in variables and "firstName" in variables["s"] or "lastName" in variables.get("s", {}):
                return {"memorialSearch": {"total": 1, "memorials": [_sample_memorial("627")]}}
            return {
                "locationsByTypeahead": {
                    "total": 1,
                    "locations": [{"__typename": "Location", "id": "city_1", "names": [{"name": "Springfield"}]}],
                }
            }

        runner = CliRunner()
        with patch.object(fg, "gql", side_effect=fake_gql):
            # Positional full name + -n + --page + --death-range + cemetery URL + case-insensitive filter.
            r1 = runner.invoke(
                fg.cli,
                [
                    "search",
                    "Abraham",
                    "Lincoln",
                    "-n",
                    "5",
                    "--page",
                    "2",
                    "--death-year",
                    "1865",
                    "--death-range",
                    "2",
                    "--death-year-filter",
                    "EXACT",
                    "--cemetery",
                    "https://www.findagrave.com/cemetery/107259/oak-ridge-cemetery",
                    "--location",
                    "city_1",
                    "--json",
                ],
            )
            self.assertEqual(r1.exit_code, 0, r1.output)
            p1 = json.loads(r1.output)
            self.assertIs(p1["cache_hit"], False)
            sent = seen_vars[-1]["s"]
            self.assertEqual(sent["firstName"], "Abraham")
            self.assertEqual(sent["lastName"], "Lincoln")
            self.assertEqual(sent["size"], 5)
            self.assertEqual(sent["from"], 5)
            self.assertEqual(sent["deathYearRange"], 2)
            self.assertEqual(sent["deathYearFilter"], "exact")
            self.assertEqual(sent["cemeteryIds"], ["107259"])
            self.assertEqual(sent["locationId"], "city_1")

            # Equivalent call using --first-name / --last-name / --rows / --offset hits cache.
            r2 = runner.invoke(
                fg.cli,
                [
                    "search",
                    "--first-name",
                    "Abraham",
                    "--last-name",
                    "Lincoln",
                    "--rows",
                    "5",
                    "--offset",
                    "5",
                    "--death-year",
                    "1865",
                    "--year-range",
                    "2",
                    "--death-year-filter",
                    "exact",
                    "--cemetery-id",
                    "107259",
                    "--location-id",
                    "city_1",
                    "--json",
                ],
            )
            self.assertEqual(r2.exit_code, 0, r2.output)
            self.assertIs(json.loads(r2.output)["cache_hit"], True)
            self.assertEqual(len(seen_vars), 1)

            # get accepts full memorial URL and emits per-item boolean cache_hit while keeping list shape.
            g1 = runner.invoke(
                fg.cli,
                ["get", "https://www.findagrave.com/memorial/627/abraham-lincoln", "--json"],
            )
            self.assertEqual(g1.exit_code, 0, g1.output)
            g1_list = json.loads(g1.output)
            self.assertIsInstance(g1_list, list)
            self.assertIs(g1_list[0]["cache_hit"], False)

            g2 = runner.invoke(fg.cli, ["memorial", "627", "--json"])
            self.assertEqual(g2.exit_code, 0, g2.output)
            g2_list = json.loads(g2.output)
            self.assertIs(g2_list[0]["cache_hit"], True)

            # cemetery accepts full cemetery URL; place accepts positional name.
            c1 = runner.invoke(
                fg.cli,
                ["cemetery", "https://www.findagrave.com/cemetery/107259/oak-ridge", "--json"],
            )
            self.assertEqual(c1.exit_code, 0, c1.output)
            self.assertIs(json.loads(c1.output)["cache_hit"], False)

            pl1 = runner.invoke(fg.cli, ["place", "Springfield", "-n", "5", "--json"])
            self.assertEqual(pl1.exit_code, 0, pl1.output)
            self.assertIs(json.loads(pl1.output)["cache_hit"], False)

            # Invalid year filter exits 2 before making a GraphQL call.
            before = len(seen_vars)
            bad = runner.invoke(fg.cli, ["search", "--last", "Lincoln", "--birth-year-filter", "bogus"])
            self.assertEqual(bad.exit_code, 2)
            self.assertEqual(len(seen_vars), before)

            # -h works on root CLI.
            help_res = runner.invoke(fg.cli, ["-h"])
            self.assertEqual(help_res.exit_code, 0)
            self.assertIn("Search and read Find a Grave", help_res.output)

    def test_gql_retries_429_503_timeout_and_html_and_fails_fast_on_403(self) -> None:
        from datetime import datetime, timedelta, timezone
        from email.utils import format_datetime

        future_date = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=2), usegmt=True)
        attempts = {"n": 0}
        sleeps: list[float] = []

        def flaky_handler(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] == 1:
                return httpx.Response(429, headers={"Retry-After": future_date}, text="rate limited")
            if attempts["n"] == 2:
                return httpx.Response(
                    200,
                    headers={"content-type": "text/html"},
                    text="<!DOCTYPE html><html><body>Temporary outage</body></html>",
                )
            return httpx.Response(200, json={"data": {"memorialSearch": {"total": 1, "memorials": []}}})

        with (
            patch.object(fg.time, "sleep", side_effect=sleeps.append),
            patch.object(
                fg,
                "_new_gql_client",
                side_effect=lambda: httpx.Client(transport=httpx.MockTransport(flaky_handler)),
            ),
        ):
            data = fg.gql("query {}", {})
        self.assertEqual(attempts["n"], 3)
        self.assertEqual(data["memorialSearch"]["total"], 1)
        # 1 initial rate-limit sleep + 2 retry sleeps.
        self.assertEqual(len(sleeps), 3)

        # Timeout recovers on retry.
        attempts["n"] = 0
        sleeps.clear()

        def timeout_then_ok(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise httpx.ReadTimeout("slow", request=request)
            return httpx.Response(200, json={"data": {"ok": True}})

        with (
            patch.object(fg.time, "sleep", side_effect=sleeps.append),
            patch.object(
                fg,
                "_new_gql_client",
                side_effect=lambda: httpx.Client(transport=httpx.MockTransport(timeout_then_ok)),
            ),
        ):
            self.assertEqual(fg.gql("query {}", {}), {"ok": True})
        self.assertEqual(attempts["n"], 2)

        # 403 Cloudflare fails fast with 0 retries.
        attempts["n"] = 0
        sleeps.clear()

        def cf_403(_request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            return httpx.Response(403, text="challenge")

        with (
            patch.object(fg.time, "sleep", side_effect=sleeps.append),
            patch.object(
                fg,
                "_new_gql_client",
                side_effect=lambda: httpx.Client(transport=httpx.MockTransport(cf_403)),
            ),
        ):
            with self.assertRaises(SystemExit) as cm:
                fg.gql("query {}", {})
        self.assertEqual(cm.exception.code, 1)
        self.assertEqual(attempts["n"], 1)

    def test_photo_retries_host_allowlist_aliases_and_broken_pipe(self) -> None:
        jpeg = b"\xff\xd8\xff\xe0HEADSTONE-OK"
        photo_meta = [
            {
                "id": "5501",
                "type": "Grave",
                "caption": "Stone",
                "path": "https://images.findagrave.com/photos/5501.jpg",
            }
        ]
        attempts = {"n": 0}
        sleeps: list[float] = []

        def flaky_photo(request: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] == 1:
                return httpx.Response(503, headers={"Retry-After": "1"}, text="busy")
            if attempts["n"] == 2:
                return httpx.Response(
                    200,
                    headers={"content-type": "image/jpeg", "content-length": "500"},
                    content=jpeg[:6],
                )
            return httpx.Response(
                200,
                headers={"content-type": "image/jpeg", "content-length": str(len(jpeg))},
                content=jpeg,
            )

        out = self.work_dir / "photos-alias"
        runner = CliRunner()
        with (
            patch.object(fg.time, "sleep", side_effect=sleeps.append),
            patch.object(
                fg,
                "gql",
                return_value={"memorialsById": [_sample_memorial("808", photos=photo_meta)]},
            ),
            patch.object(
                fg,
                "_new_photo_client",
                side_effect=lambda: httpx.Client(transport=httpx.MockTransport(flaky_photo)),
            ),
        ):
            # Invoke via `photos` plural alias + memorial URL + `--out-dir`.
            res = runner.invoke(
                fg.cli,
                [
                    "photos",
                    "https://www.findagrave.com/memorial/808/abraham-lincoln",
                    "--out-dir",
                    str(out),
                    "--json",
                ],
            )
            self.assertEqual(res.exit_code, 0, res.output)
            body = json.loads(res.output)
            self.assertEqual(body["memorial_id"], "808")
            self.assertFalse(body["cache_hit"])
            self.assertEqual(attempts["n"], 3)
            self.assertEqual((out / "5501.jpg").read_bytes(), jpeg)

        # Disallowed hosts and non-HTTPS URLs are refused without fetching.
        for bad_url in (
            "http://images.findagrave.com/photos/5501.jpg",
            "https://evil.example/photos/5501.jpg",
            "https://user@images.findagrave.com/photos/5501.jpg",
        ):
            with self.assertRaises(fg.click.ClickException):
                fg.validate_photo_url(bad_url)

        # Relative traversal in --out is refused.
        bad_out = runner.invoke(fg.cli, ["photo", "808", "--out", "../escape"])
        self.assertNotEqual(bad_out.exit_code, 0)

        # BrokenPipeError helper exits 0 cleanly.
        with self.assertRaises(SystemExit) as cm:
            fg._exit_broken_pipe()
        self.assertEqual(cm.exception.code, 0)

    def test_wave45_show_alias_and_search_given_surname_name_year_aliases(self) -> None:
        seen_vars: list[dict] = []

        def fake_gql(_query: str, variables: dict) -> dict:
            seen_vars.append(variables)
            if "ids" in variables:
                return {"memorialsById": [_sample_memorial(mid) for mid in variables["ids"]]}
            return {"memorialSearch": {"total": 1, "memorials": [_sample_memorial("627")]}}

        runner = CliRunner()
        with patch.object(fg, "gql", side_effect=fake_gql):
            r_search = runner.invoke(
                fg.cli,
                [
                    "search",
                    "--given",
                    "Abraham",
                    "--surname",
                    "Lincoln",
                    "--born",
                    "1809",
                    "--died",
                    "1865",
                    "--birth-year-range",
                    "2",
                    "--json",
                ],
            )
            self.assertEqual(r_search.exit_code, 0, r_search.output)
            self.assertIs(json.loads(r_search.output)["cache_hit"], False)
            sent = seen_vars[-1]["s"]
            self.assertEqual(sent["firstName"], "Abraham")
            self.assertEqual(sent["lastName"], "Lincoln")
            self.assertEqual(sent["birthYear"], 1809)
            self.assertEqual(sent["deathYear"], 1865)
            self.assertEqual(sent["birthYearRange"], 2)
            self.assertEqual(sent["deathYearRange"], 2)

            # `--name` splits into the identical query and hits disk cache with zero new GraphQL calls.
            r_name = runner.invoke(
                fg.cli,
                [
                    "search",
                    "--name",
                    "Abraham Lincoln",
                    "--birth",
                    "1809",
                    "--death",
                    "1865",
                    "--death-year-range",
                    "2",
                    "--json",
                ],
            )
            self.assertEqual(r_name.exit_code, 0, r_name.output)
            self.assertIs(json.loads(r_name.output)["cache_hit"], True)
            self.assertEqual(len(seen_vars), 1)

            # `show` aliases `get` and shares the memorial disk cache.
            s1 = runner.invoke(fg.cli, ["show", "627", "--json"])
            s2 = runner.invoke(fg.cli, ["get", "627", "--json"])
            self.assertEqual(s1.exit_code, 0, s1.output)
            self.assertEqual(s2.exit_code, 0, s2.output)
            self.assertIs(json.loads(s1.output)[0]["cache_hit"], False)
            self.assertIs(json.loads(s2.output)[0]["cache_hit"], True)
            self.assertEqual(len(seen_vars), 2)

            # `url` accepts --given/--surname/--born/--died.
            u = runner.invoke(
                fg.cli, ["url", "--given", "Clara", "--surname", "Barton", "--born", "1821", "--died", "1912"]
            )
            self.assertEqual(u.exit_code, 0, u.output)
            self.assertIn("firstname=Clara&lastname=Barton&birthyear=1821&deathyear=1912", u.output)


if __name__ == "__main__":
    unittest.main()
