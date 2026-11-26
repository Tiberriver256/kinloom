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
            return httpx.Response(200, content=f"JPEG-BYTES-v{img_rev['n']}".encode())

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
                (out1 / "lincoln-abraham_9901.jpg").read_bytes(), b"JPEG-BYTES-v1"
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
                (out2 / "lincoln-mary_9901.jpg").read_bytes(), b"JPEG-BYTES-v1"
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
            self.assertEqual((out3 / "9901.jpg").read_bytes(), b"JPEG-BYTES-v2")

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


if __name__ == "__main__":
    unittest.main()
