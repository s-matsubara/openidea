import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "control", Path(__file__).with_name("dependency-warm-control.py")
)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class ControlTests(unittest.TestCase):
    def test_wrong_image_cannot_delete_checkout(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            mock.patch.dict(
                os.environ,
                {
                    "GITHUB_ACTIONS": "true",
                    "RUNNER_ENVIRONMENT": "github-hosted",
                    "GITHUB_WORKSPACE": str(control.ROOT),
                    "GITHUB_REPOSITORY": "s-matsubara/openidea",
                    "ImageVersion": "different",
                },
            ),
            mock.patch.object(Path, "cwd", return_value=control.ROOT),
            mock.patch.object(control, "run", return_value=control.BASE),
            mock.patch.object(control.shutil, "rmtree") as remove,
        ):
            with self.assertRaisesRegex(AssertionError, "seed image differs"):
                control.reset(control.ARMS[0], Path(temp))
            remove.assert_not_called()

    def test_partial_dependency_hit_stops_before_inventory(self):
        with (
            mock.patch.dict(os.environ, {"DEPENDENCY_HIT": "false"}),
            mock.patch.object(control, "load") as load,
        ):
            with self.assertRaisesRegex(AssertionError, "exact dependency seed"):
                control.dependency_check(control.ARMS[0], Path("unused"))
            load.assert_not_called()

    def test_inventory_detects_backdated_content_and_preserves_nanoseconds(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "artifact"
            path.write_text("old")
            os.utime(path, ns=(123456789123456789, 123456789123456789))
            first = control.inventory(root)
            path.write_text("new")
            os.utime(path, ns=(123456789123456789, 123456789123456789))
            second = control.inventory(root)
            self.assertEqual(first["artifact"][3], 123456789123456789)
            self.assertNotEqual(first, second)

    def test_dependency_archive_cannot_contain_internal_artifacts(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "workspace.rlib"
            path.touch()
            cache = mock.Mock()
            cache.artifact_paths.return_value = "target/**/deps/libide_core-*"
            with (
                mock.patch.dict(os.environ, {"DEPENDENCY_HIT": "true"}),
                mock.patch.object(control, "load", return_value=cache),
                mock.patch.object(Path, "glob", return_value=iter([path])),
                self.assertRaisesRegex(AssertionError, "workspace artifacts leaked"),
            ):
                control.dependency_check(control.ARMS[0], Path(temp))

    def test_comparison_rejects_different_libraries_or_versions(self):
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp)
            builds = []
            for arm, fresh in zip(control.ARMS, [False, True]):
                data = {
                    "libraries": {f"lib{i}": fresh for i in range(36)},
                    "server": "openidea-server 2026.2.13 (protocol 2)",
                    "seconds": 100 if not fresh else 30,
                }
                builds.append(data)
                control.write(report / arm / "build.json", data)
                control.write(
                    report / arm / "versions.json",
                    {
                        "sha": control.BASE,
                        "components": {f"lib{i}": "2026.2.12" for i in range(43)},
                    },
                )
            with mock.patch.dict(
                os.environ, {"GITHUB_STEP_SUMMARY": str(report / "summary")}
            ):
                control.compare(report)
            self.assertEqual(
                json.loads((report / "comparison.json").read_text())[
                    "build_reduction_percent"
                ],
                70,
            )
            for field, value in [
                ("server", "openidea-server 2026.2.12 (protocol 2)"),
                ("libraries", {"other": True}),
            ]:
                changed = {**builds[1], field: value}
                control.write(report / control.ARMS[1] / "build.json", changed)
                with self.assertRaises(AssertionError):
                    control.compare(report)


if __name__ == "__main__":
    unittest.main()
