import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "verification", Path(__file__).with_name("verify-release-cache.py")
)
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


class HostedVerificationTests(unittest.TestCase):
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
