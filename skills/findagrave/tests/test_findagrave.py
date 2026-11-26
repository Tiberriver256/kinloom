from __future__ import annotations

from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from click.testing import CliRunner


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "findagrave"


def load_fg_module():
    loader = SourceFileLoader("findagrave_cli_under_test", str(SCRIPT_PATH))
    spec = spec_from_loader("findagrave_cli_under_test", loader)
    assert spec is not None
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


fg = load_fg_module()


class TestFindAGraveCli(unittest.TestCase):
    def test_get_and_memorial_alias_emit_cemetery_coordinates(self) -> None:
        sample_data = {
            "memorialsById": [
                {
                    "id": "627",
                    "name": [{"first": "Abraham", "last": "Lincoln", "maiden": None}],
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
                    "photos": {"total": 1, "photos": []},
                }
            ]
        }
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


if __name__ == "__main__":
    unittest.main()
