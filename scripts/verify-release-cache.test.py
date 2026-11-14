import importlib.util
import json
import os
import tempfile
import unittest
from contextlib import chdir
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "verification", Path(__file__).with_name("verify-release-cache.py")
)
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


class HostedVerificationTests(unittest.TestCase):
    def test_inventory_rejects_snapshot_only_and_requires_each_built_library(self):
        with tempfile.TemporaryDirectory() as temp, chdir(temp):
            report = Path("report")
            report.mkdir()
            (report / "build.json").write_text(
                json.dumps({"libraries": {"ide-core": False}})
            )
            Path("target").mkdir()
            Path("target/.release-inputs.json").write_text("{}")
            Path("paths").write_text("target/**/*\n")
            with self.assertRaisesRegex(AssertionError, "no compiled library"):
                verification.inventory("paths", report)
            unit = Path("target/release/build/ide-core/hash")
            (unit / "out").mkdir(parents=True)
            (unit / "out/libide_core-hash.rlib").write_text("compiled library")
            (unit / "fingerprint").mkdir()
            (unit / "fingerprint/lib-ide_core.json").write_text("{}")
            verification.inventory("paths", report)
            data = json.loads((report / "archive-inventory.json").read_text())
            self.assertEqual(data["libraries"]["ide-core"]["units"], 1)
            (unit / "out/openidea-server").write_text("stale")
            with self.assertRaises(AssertionError):
                verification.inventory("paths", report)

    def test_prepare_accepts_omitted_versions_without_a_workspace_version(self):
        with tempfile.TemporaryDirectory() as temp, chdir(temp):
            root = Path.cwd()
            (root / "Cargo.toml").write_text('[workspace.package]\nedition="2024"\n')
            (root / "src-tauri").mkdir()
            (root / "src-tauri/Cargo.toml").write_text(
                '[package]\nversion="2026.2.13"\n'
            )
            for path in ["package.json", "src-tauri/tauri.conf.json"]:
                (root / path).write_text('{"version":"2026.2.13"}')
            (root / "Cargo.lock").write_text(
                '[[package]]\nname="openidea"\nversion="2026.2.13"\n'
            )
            manifest = root / "crates/ide-core/Cargo.toml"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('[package]\nname="ide-core"\n')
            metadata = {"packages": [{"name": "ide-core", "version": "0.0.0"}]}

            def run(*args):
                return (
                    json.dumps(metadata)
                    if args[:2] == ("cargo", "metadata")
                    else "fixture"
                )

            with (
                mock.patch.object(verification, "run", side_effect=run),
                mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(root / "outputs")}),
            ):
                verification.prepare("cold", root / "report")
            report = json.loads((root / "report/versions.json").read_text())
            self.assertEqual(report["components"], {"ide-core": "0.0.0"})
            self.assertEqual(report["version"], "2026.2.13")

    def test_omitted_internal_versions_and_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "Cargo.toml").write_text('[workspace.package]\nedition="2024"\n')
            manifest = root / "crates/ide-core/Cargo.toml"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('[package]\nname="ide-core"\n')
            metadata = {"packages": [{"name": "ide-core", "version": "0.0.0"}]}
            self.assertEqual(
                verification.component_versions(metadata, root), {"ide-core": "0.0.0"}
            )
            for version in ["2026.2.12", "1.0.0"]:
                metadata["packages"][0]["version"] = version
                with self.assertRaises(AssertionError):
                    verification.component_versions(metadata, root)

    def test_upstream_added_crate_cannot_reintroduce_a_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "Cargo.toml").write_text('[workspace.package]\nedition="2024"\n')
            manifest = root / "crates/new-upstream-crate/Cargo.toml"
            manifest.parent.mkdir(parents=True)
            for version in ["version.workspace=true", 'version="0.0.0"']:
                manifest.write_text(
                    f'[package]\nname="new-upstream-crate"\n{version}\n'
                )
                with self.assertRaisesRegex(
                    AssertionError, "internal version must be omitted"
                ):
                    verification.component_versions({"packages": []}, root)
            manifest.write_text('[package]\nname="new-upstream-crate"\n')
            with self.assertRaisesRegex(AssertionError, "missing from Cargo metadata"):
                verification.component_versions({"packages": []}, root)
            (root / "Cargo.toml").write_text(
                '[workspace.package]\nversion="2026.2.12"\n'
            )
            with self.assertRaisesRegex(AssertionError, "workspace.package"):
                verification.component_versions({"packages": []}, root)

    def test_image_change_is_reported_before_touching_versions_or_caches(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            mock.patch.dict(
                os.environ, {"BASE_IMAGE": "old-image", "ImageVersion": "new-image"}
            ),
        ):
            report = Path(temp)
            with self.assertRaisesRegex(RuntimeError, "runner image changed"):
                verification.prepare("warm", report)
            self.assertEqual(
                json.loads((report / "incompatible-image.json").read_text()),
                {"cold_image": "old-image", "warm_image": "new-image"},
            )

    def artifacts(self, fresh):
        names = ["ide-core", "ide-host", "ide-mcp", "ide-terminal", "ide-language"]
        packages = [{"id": name, "name": name} for name in names]
        messages = [
            {
                "reason": "compiler-artifact",
                "package_id": name,
                "target": {"kind": ["lib"], "name": name},
                "fresh": fresh,
            }
            for name in names
        ]
        messages.append(
            {
                "reason": "compiler-artifact",
                "package_id": "ide-host",
                "target": {"kind": ["bin"], "name": "openidea-server"},
                "fresh": False,
            }
        )
        return messages, packages

    def test_requires_meaningful_library_reuse_and_rebuilt_binary(self):
        cold, packages = self.artifacts(False)
        self.assertFalse(any(verification.analyze(cold, packages, "cold").values()))
        warm, packages = self.artifacts(True)
        self.assertTrue(all(verification.analyze(warm, packages, "warm").values()))
        warm[0]["fresh"] = False
        with self.assertRaises(AssertionError):
            verification.analyze(warm, packages, "warm")
        warm[0]["fresh"] = True
        warm[-1]["fresh"] = True
        with self.assertRaises(AssertionError):
            verification.analyze(warm, packages, "warm")

    def test_missing_or_incompatible_restores_cannot_pass(self):
        verification.check_restore("cold", "prefix", "", "", "", "")
        verification.check_restore(
            "warm", "prefix", "cold-key", "prefix", "cold-key", "true"
        )
        for prefix, matched, dependency in [
            ("changed", "cold-key", "true"),
            ("prefix", "", "true"),
            ("prefix", "other-key", "true"),
            ("prefix", "cold-key", "false"),
        ]:
            with self.assertRaises(AssertionError):
                verification.check_restore(
                    "warm", prefix, matched, "prefix", "cold-key", dependency
                )


if __name__ == "__main__":
    unittest.main()
