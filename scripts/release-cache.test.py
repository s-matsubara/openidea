"""Linux Cargo experiment: real compiler freshness, directory deletion and unknown inputs."""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import tomllib
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "release_cache", REPO / "scripts/release-cache.py"
)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)
RESULTS = []


class CargoCache(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cargo-cache-")
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.previous = Path.cwd()
        os.chdir(self.root)
        self.env = {
            **os.environ,
            "CARGO_INCREMENTAL": "0",
            "CARGO_NET_OFFLINE": "true",
            "MODE": "baseline",
        }
        self.write(
            "Cargo.toml",
            """[workspace]
resolver="3"
members=["crates/*", "src-tauri"]
[workspace.package]
edition="2024"
[profile.release]
lto="thin"
codegen-units=1
""",
        )
        self.write("package.json", '{"version":"2026.2.12"}')
        self.write("src-tauri/tauri.conf.json", '{"version":"2026.2.12"}')
        self.write(
            "src-tauri/Cargo.toml",
            """[package]
name="openidea"
version="2026.2.12"
edition.workspace=true
[dependencies]
ide-core={path="../crates/ide-core"}
ide-host={path="../crates/ide-host"}
""",
        )
        self.write(
            "src-tauri/src/main.rs",
            'fn main(){ide_core::version::set_app_version(env!("CARGO_PKG_VERSION"));println!("{}",ide_host::identity());}',
        )
        self.write(
            "crates/ide-core/Cargo.toml",
            '[package]\nname="ide-core"\nedition.workspace=true\n',
        )
        self.write("crates/ide-core/src/lib.rs", "pub mod version;")
        self.write(
            "crates/ide-core/src/version.rs",
            (REPO / "crates/ide-core/src/version.rs").read_text(),
        )
        self.write(
            "crates/cache-lib/Cargo.toml",
            '[package]\nname="cache-lib"\nedition.workspace=true\n',
        )
        self.write(
            "crates/cache-lib/src/lib.rs",
            'pub fn value()->&\'static str {env!("CONTENT")}',
        )
        self.write("crates/cache-lib/inputs/a", "A")
        self.write("crates/cache-lib/inputs/b", "B")
        self.write(
            "crates/cache-lib/build.rs",
            """fn main(){
println!("cargo:rerun-if-changed=inputs");
println!("cargo:rerun-if-env-changed=MODE");
let mut paths:Vec<_>=std::fs::read_dir("inputs").unwrap().map(|p|p.unwrap().path()).collect();paths.sort();
let mut value:String=paths.iter().map(|p|std::fs::read_to_string(p).unwrap()).collect();
if std::path::Path::new("generated.txt").exists(){println!("cargo:rerun-if-changed=generated.txt");value.push_str(&std::fs::read_to_string("generated.txt").unwrap());}
value.push_str(&std::env::var("MODE").unwrap_or_default());
println!("cargo:rustc-env=CONTENT={value}");
}""",
        )
        self.write(
            "crates/ide-host/Cargo.toml",
            """[package]
name="ide-host"
edition.workspace=true
[dependencies]
ide-core={path="../ide-core"}
cache-lib={path="../cache-lib"}
serde_json="1"
""",
        )
        self.write(
            "crates/ide-host/src/lib.rs",
            'pub fn identity()->String {format!("{}:{}",ide_core::version::app_version(),cache_lib::value())}',
        )
        self.write(
            "crates/ide-host/src/bin/common/release_version.rs",
            (REPO / "crates/ide-host/src/bin/common/release_version.rs").read_text(),
        )
        self.write(
            "crates/ide-host/src/bin/server.rs",
            '#[path="common/release_version.rs"]mod release_version;fn main(){release_version::init();println!("{}",ide_host::identity());}',
        )
        self.run_command("git", "init", "-q")
        self.run_command("cargo", "generate-lockfile", "--offline")
        self.run_command("git", "add", ".")

    def tearDown(self):
        os.chdir(self.previous)
        self.temp.cleanup()

    def write(self, name, text):
        path = Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_command(self, *args):
        result = subprocess.run(
            args, check=False, env=self.env, text=True, capture_output=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def build(self, label):
        start = time.monotonic()
        output = self.run_command(
            "cargo",
            "build",
            "--release",
            "--workspace",
            "--bins",
            "--message-format=json",
        )
        self.cargo_messages = output
        fresh = {}
        self.binary_fresh = {}
        self.build_script_fresh = {}
        self.workspace_artifacts = set()
        for line in output.splitlines():
            item = json.loads(line)
            if item.get("reason") == "compiler-artifact" and item[
                "package_id"
            ].startswith("path+"):
                self.workspace_artifacts.update(Path(p) for p in item["filenames"])
                if "custom-build" in item["target"]["kind"]:
                    self.build_script_fresh[item["package_id"]] = item["fresh"]
            if (
                item.get("reason") == "compiler-artifact"
                and "bin" in item["target"]["kind"]
            ):
                self.binary_fresh[item["target"]["name"]] = item["fresh"]
            if item.get("reason") == "compiler-artifact" and set(
                item["target"]["kind"]
            ) & {"lib", "proc-macro"}:
                name = item["target"]["name"]
                if name in ["ide_core", "cache_lib", "ide_host", "cache_macro"]:
                    fresh[name] = item["fresh"]
        RESULTS.append(
            {
                "scenario": label,
                "seconds": round(time.monotonic() - start, 3),
                "internal_fresh": fresh,
                "binaries_fresh": self.binary_fresh,
                "build_scripts_fresh": self.build_script_fresh,
            }
        )
        return fresh

    def save(self):
        self.write(
            "target/release/bundle/stale-installer.sig",
            "must never enter a workspace cache",
        )
        cache.capture()
        self.saved = Path(self.temp.name) / "saved"
        self.saved.mkdir()
        self.dependencies = Path(self.temp.name) / "dependencies"
        shutil.copytree("target", self.dependencies, copy_function=shutil.copy2)
        (self.dependencies / ".release-inputs.json").unlink()
        profiles = set()
        for depth in ("*", "*/*"):
            for marker in (".fingerprint", "build"):
                profiles.update(
                    p.parent for p in self.dependencies.glob(f"{depth}/{marker}")
                )
        for profile in profiles:
            for path in list(profile.iterdir()):
                if path.name not in {"deps", "build", ".fingerprint"}:
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink()

        # Simulate Swatinem's dependency-only target archive, independently of the workspace archive.
        for package in cache.packages():
            for profile in profiles:
                for pattern in (
                    f".fingerprint/{package['name']}-*",
                    f"build/{package['name']}-*",
                    f"build/{package['name']}",
                ):
                    for path in profile.glob(pattern):
                        shutil.rmtree(path)
                    self.assertFalse(list(profile.glob(pattern)))
                for target in package["targets"]:
                    name = target["name"].replace("-", "_")
                    for pattern in [f"deps/{name}-*", f"deps/lib{name}-*"]:
                        for path in profile.glob(pattern):
                            path.unlink()
        # Cargo JSON is independent evidence: no workspace compiler output may survive.
        self.assertTrue(self.workspace_artifacts)
        for artifact in self.workspace_artifacts:
            self.assertFalse(
                (
                    self.dependencies / artifact.relative_to(self.root / "target")
                ).exists(),
                artifact,
            )
        patterns = cache.artifact_paths(cache.packages()).splitlines()
        selected = set()
        for pattern in patterns:
            if not pattern.startswith("!"):
                selected.update(Path(".").glob(pattern))
        for pattern in patterns:
            if pattern.startswith("!"):
                selected.difference_update(Path(".").glob(pattern[1:]))
        for path in sorted(selected):
            destination = self.saved / path.relative_to("target")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.copytree(
                    path, destination, copy_function=shutil.copy2, dirs_exist_ok=True
                )
            else:
                shutil.copy2(path, destination)

        self.assertFalse(list(self.saved.rglob("bundle")))
        self.assertFalse(list(self.saved.rglob("*.sig")))
        self.assertFalse(list(self.saved.rglob("libopenidea_lib*")))
        self.assertFalse((self.saved / "release/openidea").exists())
        self.assertFalse((self.saved / "release/server").exists())
        for path in self.saved.rglob("*"):
            self.assertNotIn(
                path.name, {"server", "openidea", "server.exe", "openidea.exe"}
            )
            self.assertFalse(
                path.name.startswith(("bin-", "dep-bin-", "output-bin-")), path
            )
        self.assertEqual(len(list(self.saved.rglob("*.rlib"))), 3)

    def checkout(self):
        # A fresh checkout of the same absolute Actions workspace, with immutable cached targets.
        for name in cache.tracked():
            data = Path(name).read_bytes()
            Path(name).unlink()
            Path(name).write_bytes(data)
        shutil.rmtree("target")
        shutil.copytree(self.dependencies, "target", copy_function=shutil.copy2)
        shutil.copytree(
            self.saved, "target", copy_function=shutil.copy2, dirs_exist_ok=True
        )

    def bump(self):
        for name in [
            "src-tauri/Cargo.toml",
            "src-tauri/tauri.conf.json",
            "package.json",
        ]:
            self.write(name, Path(name).read_text().replace("2026.2.12", "2026.2.13"))
        self.run_command("cargo", "update", "--workspace", "--offline")

    def identities(self, expected):
        profile = Path("target") / self.env.get("CARGO_BUILD_TARGET", "") / "release"
        for binary in ["openidea", "server"]:
            self.assertEqual(
                self.run_command(str((profile / binary).resolve())).strip(),
                expected,
            )

    def test_release_and_nightly_preparation_preserve_omitted_versions(self):
        for name in ["release-prepare.ts", "nightly-prepare.ts"]:
            self.write(f"scripts/{name}", (REPO / "scripts" / name).read_text())
        self.write(
            "src-tauri/Cargo.toml",
            Path("src-tauri/Cargo.toml")
            .read_text()
            .replace('version="', 'version = "'),
        )
        self.write("package.json", json.dumps({"version": "2026.2.12"}, indent=2))
        config = json.loads((REPO / "src-tauri/tauri.conf.json").read_text())
        config["version"] = "2026.2.12"
        self.write("src-tauri/tauri.conf.json", json.dumps(config, indent=2))
        for folder in ["wit", "sdk/rust/openidea-plugin/tests/api/released"]:
            self.write(f"{folder}/plugin.wit", "package openidea:plugin@1.6.0;\n")
        manifests = {
            path: path.read_bytes()
            for path in [Path("Cargo.toml"), *Path("crates").glob("*/Cargo.toml")]
        }
        lock = tomllib.loads(Path("Cargo.lock").read_text())
        for script, argument, expected in [
            ("release-prepare.ts", "2026.2.13", "2026.2.13"),
            ("nightly-prepare.ts", "202611141200", "2026.2.14-nightly.202611141200"),
        ]:
            self.run_command("node", f"scripts/{script}", argument)
            for manifest, content in manifests.items():
                self.assertEqual(manifest.read_bytes(), content)
            metadata = json.loads(
                self.run_command(
                    "cargo", "metadata", "--no-deps", "--format-version=1", "--locked"
                )
            )
            for package in metadata["packages"]:
                self.assertEqual(
                    package["version"],
                    expected if package["name"] == "openidea" else "0.0.0",
                )
            for path in ["package.json", "src-tauri/tauri.conf.json"]:
                self.assertEqual(
                    json.loads(Path(path).read_text())["version"], expected
                )
            updated = tomllib.loads(Path("Cargo.lock").read_text())
            for package in updated["package"]:
                if package["name"] == "openidea":
                    self.assertEqual(package["version"], expected)
                    package["version"] = "2026.2.12"
            self.assertEqual(updated, lock)

    def test_version_only_with_verified_cache_reuses_internal_libraries(self):
        self.build("split: cold")
        self.save()
        self.checkout()
        self.bump()
        cache.restore()
        self.assertTrue(all(self.build("split: verified cache, version-only").values()))
        self.assertEqual(self.binary_fresh, {"openidea": False, "server": False})
        self.assertTrue(self.build_script_fresh)
        self.assertTrue(all(self.build_script_fresh.values()))
        self.identities("2026.2.13:ABbaseline")

    def test_explicit_target_reuses_host_proc_macro_and_target_libraries(self):
        self.write(
            "crates/cache-macro/Cargo.toml",
            '[package]\nname="cache-macro"\nedition.workspace=true\n[lib]\nproc-macro=true\n',
        )
        self.write(
            "crates/cache-macro/src/lib.rs",
            "#[proc_macro] pub fn identity(input: proc_macro::TokenStream)->proc_macro::TokenStream{input}",
        )
        manifest = Path("crates/cache-lib/Cargo.toml")
        manifest.write_text(
            manifest.read_text()
            + '[dependencies]\ncache-macro={path="../cache-macro"}\n'
        )
        self.write(
            "crates/cache-lib/src/lib.rs",
            'pub fn value()->&\'static str {cache_macro::identity!(env!("CONTENT"))}',
        )
        self.run_command("git", "add", ".")
        self.env["CARGO_BUILD_TARGET"] = next(
            line.removeprefix("host: ")
            for line in self.run_command("rustc", "-vV").splitlines()
            if line.startswith("host: ")
        )
        self.build("explicit target with host proc macro: cold")
        self.save()
        self.checkout()
        self.bump()
        cache.restore()
        fresh = self.build("explicit target with host proc macro: warm")
        self.assertEqual(len(fresh), 4)
        self.assertTrue(all(fresh.values()), fresh)
        self.assertEqual(self.binary_fresh, {"openidea": False, "server": False})
        self.identities("2026.2.13:ABbaseline")

    def test_fresh_checkout_without_mtime_restore_rebuilds(self):
        self.build("split: cold control")
        self.save()
        time.sleep(0.05)
        self.checkout()
        self.bump()
        self.assertFalse(
            any(self.build("split: cache without input-mtime verification").values())
        )

    def test_dependency_archive_alone_has_no_workspace_reuse(self):
        self.build("dependency isolation: cold")
        self.save()
        shutil.rmtree(self.saved)
        self.saved.mkdir()
        self.checkout()
        self.bump()
        cache.restore()
        self.assertFalse(any(self.build("dependency archive only").values()))
        self.identities("2026.2.13:ABbaseline")

    def test_hosted_control_strips_workspace_and_preserves_dependency_archive(self):
        spec = importlib.util.spec_from_file_location(
            "control", REPO / "scripts/cargo-layout-control.py"
        )
        control = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(control)
        control.REPORT = Path(self.temp.name) / "report"
        control.DEPENDENCIES = Path(self.temp.name) / "dependencies.tar"
        self.build("hosted dependency isolation")
        cache.capture()
        (control.REPORT / "seed").mkdir(parents=True)
        (control.REPORT / "seed/cargo.jsonl").write_text(self.cargo_messages)
        with mock.patch.object(control, "guard"):
            control.save_dependencies()
            expected = control.dependency_inventory()
            self.assertTrue(expected)
            control.reset()
            self.run_command("tar", "-xf", str(control.DEPENDENCIES))
            self.assertEqual(control.dependency_inventory(), expected)
            control.assert_no_workspace()
        self.assertFalse(any(self.build("hosted dependency archive only").values()))

    def test_inherited_workspace_version_still_rebuilds_even_with_mtime_restore(self):
        self.write(
            "Cargo.toml",
            Path("Cargo.toml")
            .read_text()
            .replace("[workspace.package]", '[workspace.package]\nversion="2026.2.12"'),
        )
        for manifest in Path("crates").glob("*/Cargo.toml"):
            manifest.write_text(
                manifest.read_text().replace(
                    "[package]", "[package]\nversion.workspace=true"
                )
            )
        self.write(
            "src-tauri/Cargo.toml",
            Path("src-tauri/Cargo.toml")
            .read_text()
            .replace('version="2026.2.12"', "version.workspace=true"),
        )
        self.build("inherited: cold")
        self.save()
        self.checkout()
        self.write(
            "Cargo.toml",
            Path("Cargo.toml").read_text().replace("2026.2.12", "2026.2.13"),
        )
        self.write("src-tauri/tauri.conf.json", '{"version":"2026.2.13"}')
        self.run_command("cargo", "update", "--workspace", "--offline")
        cache.restore()
        self.assertFalse(
            any(self.build("inherited: version-only with verified cache").values())
        )

    def test_backdated_changed_source_is_not_reused(self):
        self.build("source: cold")
        self.save()
        self.checkout()
        path = Path("crates/cache-lib/src/lib.rs")
        path.write_text('pub fn value()->&\'static str {"changed"}')
        os.utime(path, (1, 1))
        cache.restore()
        self.assertFalse(self.build("backdated changed source")["cache_lib"])
        self.identities("2026.2.12:changed")
        self.assertTrue(
            all(self.build("changed source: subsequent unchanged build").values())
        )

    def test_directory_deletion_reruns_build_script(self):
        self.build("directory: cold")
        self.save()
        self.checkout()
        Path("crates/cache-lib/inputs/b").unlink()
        self.run_command("git", "add", "-u")
        os.utime("crates/cache-lib/inputs", (1, 1))
        cache.restore()
        self.assertFalse(self.build("build.rs directory deletion")["cache_lib"])
        self.identities("2026.2.12:Abaseline")

    def test_unknown_generated_input_fails_closed(self):
        self.write(
            "crates/cache-lib/generated.txt", "old"
        )  # Intentionally not git tracked.
        self.build("unknown input: cold")
        self.save()
        self.checkout()
        self.write("crates/cache-lib/generated.txt", "new")
        os.utime("crates/cache-lib/generated.txt", (1, 1))
        cache.restore()
        self.assertFalse(self.build("unknown generated input")["cache_lib"])
        self.identities("2026.2.12:ABnewbaseline")

    def test_unknown_rust_include_fails_closed(self):
        self.write("crates/cache-lib/generated.txt", "old")
        self.write(
            "crates/cache-lib/src/lib.rs",
            'pub fn value()->&\'static str {include_str!("../generated.txt")}',
        )
        self.write(
            "crates/cache-lib/build.rs",
            'fn main(){println!("cargo:rerun-if-changed=inputs");}',
        )
        self.build("unknown include: cold")
        self.save()
        self.checkout()
        self.write("crates/cache-lib/generated.txt", "new")
        os.utime("crates/cache-lib/generated.txt", (1, 1))
        cache.restore()
        self.assertFalse(self.build("unknown include_str input")["cache_lib"])
        self.identities("2026.2.12:new")

    def test_missing_dep_info_for_cached_library_fails_closed(self):
        self.write("crates/cache-lib/generated.txt", "old")
        self.write(
            "crates/cache-lib/src/lib.rs",
            'pub fn value()->&\'static str {include_str!("../generated.txt")}',
        )
        self.write(
            "crates/cache-lib/build.rs",
            'fn main(){println!("cargo:rerun-if-changed=inputs");}',
        )
        self.build("missing dep-info: cold")
        dep_info = list(Path("target").rglob("cache_lib-*.d"))
        self.assertTrue(
            dep_info, "must remove real dep-info, including Cargo 1.100 paths"
        )
        for path in dep_info:
            path.unlink()
        self.save()
        self.checkout()
        self.write("crates/cache-lib/generated.txt", "new")
        os.utime("crates/cache-lib/generated.txt", (1, 1))
        cache.restore()
        self.assertFalse(
            self.build("cached library without text dep-info")["cache_lib"]
        )
        self.identities("2026.2.12:new")

    def test_unknown_build_script_compile_input_fails_closed(self):
        self.write("crates/cache-lib/generated.txt", "old")
        self.write(
            "crates/cache-lib/build.rs",
            'fn main(){println!("cargo:rerun-if-changed=inputs");println!("cargo:rustc-env=CONTENT={}",include_str!("generated.txt"));}',
        )
        self.build("build script include: cold")
        self.save()
        self.checkout()
        self.write("crates/cache-lib/generated.txt", "new")
        os.utime("crates/cache-lib/generated.txt", (1, 1))
        cache.restore()
        self.assertFalse(self.build("build script untracked include")["cache_lib"])
        self.identities("2026.2.12:new")

    def test_foreign_snapshot_schema_discards_fingerprints(self):
        self.build("foreign metadata: cold")
        self.save()
        self.checkout()
        state = json.loads(cache.STATE.read_text())
        state["format"] = 1
        cache.STATE.write_text(json.dumps(state))
        cache.restore()
        self.assertFalse(any(self.build("old schema: safe rebuild").values()))

    def test_future_cache_clock_forces_rebuild(self):
        self.build("clock skew: cold")
        self.save()
        self.checkout()
        state = json.loads(cache.STATE.read_text())
        state["anchor"] = 0
        cache.STATE.write_text(json.dumps(state))
        future = time.time_ns() + 10_000_000_000
        fingerprint = next(cache.fingerprints("cache-lib", "lib-*.json"))
        os.utime(fingerprint, ns=(future, future))
        self.assertEqual(cache.anchors(), future)
        cache.restore()
        self.assertFalse(any(self.build("future cache anchor: safe rebuild").values()))
        self.identities("2026.2.12:ABbaseline")

    def test_rerun_if_env_changed_remains_effective(self):
        self.build("environment: cold")
        self.save()
        self.checkout()
        cache.restore()
        self.env["MODE"] = "new-environment"
        self.assertFalse(self.build("rerun-if-env-changed")["cache_lib"])
        self.identities("2026.2.12:ABnew-environment")

    def test_missing_snapshot_discards_workspace_fingerprints(self):
        self.build("missing metadata: cold")
        self.save()
        self.checkout()
        cache.STATE.unlink()
        cache.restore()
        self.assertFalse(any(self.build("missing metadata: safe rebuild").values()))

    def test_compatibility_key_boundaries(self):
        output = Path(self.temp.name) / "key-output"
        environment = {
            **os.environ,
            "GITHUB_OUTPUT": str(output),
            "GITHUB_RUN_ID": "99",
            "GITHUB_RUN_ATTEMPT": "1",
        }
        with mock.patch.dict(os.environ, environment, clear=True):

            def key(scope="desktop", target="x86_64-unknown-linux-gnu"):
                output.write_text("")
                cache.keys(scope, target)
                return next(
                    line
                    for line in output.read_text().splitlines()
                    if line.startswith("prefix=")
                )

            baseline = key()
            self.assertNotEqual(baseline, key(target="aarch64-unknown-linux-gnu"))
            self.assertNotEqual(baseline, key(scope="server"))
            original_command = cache.command

            def newer_rustc(*args):
                value = original_command(*args)
                return value + "changed-rustc" if args == ("rustc", "-vV") else value

            with mock.patch.object(cache, "command", side_effect=newer_rustc):
                self.assertNotEqual(baseline, key())
            path = Path("crates/ide-host/Cargo.toml")
            path.write_text(
                path.read_text().replace(
                    'serde_json="1"', 'serde_json={version="1",default-features=true}'
                )
            )
            self.assertNotEqual(baseline, key())

    def test_omission_starts_a_new_workspace_cache_generation(self):
        output = Path(self.temp.name) / "key-output"
        manifests = [Path("Cargo.toml"), *Path("crates").glob("*/Cargo.toml")]
        omitted = {path: path.read_text() for path in manifests}
        with mock.patch.dict(
            os.environ,
            {
                "GITHUB_OUTPUT": str(output),
                "GITHUB_RUN_ID": "1",
                "GITHUB_RUN_ATTEMPT": "1",
            },
        ):

            def prefix():
                output.write_text("")
                cache.keys("server", "x86_64-unknown-linux-gnu")
                return next(
                    line
                    for line in output.read_text().splitlines()
                    if line.startswith("prefix=")
                )

            current = prefix()
            for manifest, content in omitted.items():
                if manifest == Path("Cargo.toml"):
                    content = content.replace(
                        "[workspace.package]",
                        '[workspace.package]\nversion="2026.2.12"',
                    )
                else:
                    content = content.replace(
                        "[package]", "[package]\nversion.workspace=true"
                    )
                manifest.write_text(content)
            self.run_command("cargo", "update", "--workspace", "--offline")
            self.assertNotEqual(prefix(), current)
            for manifest, content in omitted.items():
                manifest.write_text(content)
            self.run_command("cargo", "update", "--workspace", "--offline")
            self.assertEqual(prefix(), current)

    def test_immutable_save_keys_and_invalidation(self):
        output = Path(self.temp.name) / "outputs"
        base_env = dict(os.environ)

        def key(namespace="release-target", generation="", **env):
            os.environ.update(
                {
                    "GITHUB_RUN_ID": "1",
                    "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_OUTPUT": str(output),
                    **env,
                }
            )
            output.write_text("")
            cache.keys("desktop", "x86_64-unknown-linux-gnu", namespace, generation)
            return dict(
                line.split("=", 1)
                for line in output.read_text().splitlines()
                if line.startswith(("key=", "prefix="))
            )

        try:
            first = key()
            self.bump()
            second = key(GITHUB_RUN_ID="2")
            retry = key(GITHUB_RUN_ATTEMPT="2")
            self.assertEqual(first["prefix"], retry["prefix"])
            self.assertNotEqual(first["key"], retry["key"])
            self.assertEqual(first["prefix"], second["prefix"])
            self.assertNotEqual(first["key"], second["key"])
            cold = key(namespace="verification-run-1", generation="cold")
            warm = key(namespace="verification-run-1", generation="warm")
            self.assertEqual(cold["prefix"], warm["prefix"])
            self.assertNotEqual(cold["key"], warm["key"])
            self.assertNotEqual(first["prefix"], cold["prefix"])
            self.assertNotEqual(
                second["prefix"], key(RUSTFLAGS="-C debuginfo=1")["prefix"]
            )
            os.environ.pop("RUSTFLAGS", None)
            self.write(
                "Cargo.toml",
                Path("Cargo.toml").read_text().replace('lto="thin"', "lto=false"),
            )
            self.assertNotEqual(second["prefix"], key()["prefix"])
        finally:
            os.environ.clear()
            os.environ.update(base_env)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        report = os.environ.get("RELEASE_CACHE_REPORT")
        if report:
            Path(report).write_text(json.dumps(RESULTS, indent=2) + "\n")
