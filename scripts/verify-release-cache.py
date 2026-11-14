"""Hosted, non-publishing cache experiment against the real server workspace."""

import argparse
import json
import os
import re
import subprocess
import time
import tomllib
from pathlib import Path


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def output(name, value):
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write(f"{name}={value}\n")


def versions():
    app = tomllib.loads(Path("src-tauri/Cargo.toml").read_text())["package"]["version"]
    assert json.loads(Path("package.json").read_text())["version"] == app
    assert json.loads(Path("src-tauri/tauri.conf.json").read_text())["version"] == app
    lock = tomllib.loads(Path("Cargo.lock").read_text())
    assert next(p["version"] for p in lock["package"] if p["name"] == "openidea") == app
    return app


def component_versions(metadata=None, root=Path(".")):
    workspace = tomllib.loads((root / "Cargo.toml").read_text())["workspace"]
    assert "version" not in workspace.get("package", {}), (
        "internal versions must be omitted from workspace.package"
    )
    names = set()
    for manifest in sorted((root / "crates").glob("*/Cargo.toml")):
        package = tomllib.loads(manifest.read_text())["package"]
        assert "version" not in package, f"{manifest}: internal version must be omitted"
        names.add(package["name"])
    assert names, "no internal crates found"
    if metadata is None:
        metadata = json.loads(
            run("cargo", "metadata", "--no-deps", "--format-version=1", "--locked")
        )
    components = {
        p["name"]: p["version"] for p in metadata["packages"] if p["name"] in names
    }
    assert set(components) == names, "internal crates missing from Cargo metadata"
    assert set(components.values()) == {"0.0.0"}, components
    return components


def prepare(phase, report):
    report.mkdir(parents=True, exist_ok=True)
    image = os.environ.get("ImageVersion", "")
    if phase == "warm":
        expected = os.environ["BASE_IMAGE"]
        if not expected or image != expected:
            data = {"cold_image": expected, "warm_image": image}
            (report / "incompatible-image.json").write_text(
                json.dumps(data, indent=2) + "\n"
            )
            raise RuntimeError(
                f"runner image changed: cold={expected}, warm={image}; comparison refused"
            )
    before = versions()
    lock = tomllib.loads(Path("Cargo.lock").read_text())
    root = Path("Cargo.toml").read_bytes()
    if phase == "warm":
        assert before == os.environ["BASE_VERSION"], (
            "cold/warm checkout versions differ"
        )
        parts = before.split(".")
        assert len(parts) == 3 and all(p.isdigit() for p in parts)
        parts[-1] = str(int(parts[-1]) + 1)
        subprocess.run(
            ["node", "scripts/release-prepare.ts", ".".join(parts)], check=True
        )
        after_lock = tomllib.loads(Path("Cargo.lock").read_text())
        for package in after_lock["package"]:
            if package["name"] == "openidea" and "source" not in package:
                package["version"] = before
        assert lock == after_lock, "version preparation changed dependencies"
        assert Path("Cargo.toml").read_bytes() == root, (
            "internal version policy changed"
        )
        changed = set(run("git", "diff", "--name-only").splitlines())
        assert changed == {
            "Cargo.lock",
            "package.json",
            "src-tauri/Cargo.toml",
            "src-tauri/tauri.conf.json",
        }, changed
    current = versions()
    metadata = json.loads(
        run("cargo", "metadata", "--no-deps", "--format-version=1", "--locked")
    )
    components = component_versions(metadata)
    data = {
        "phase": phase,
        "sha": run("git", "rev-parse", "HEAD"),
        "version": current,
        "previous_version": before,
        "components": components,
        "simulated_tag": f"v{current}",
        "published_tag": None,
        "rustc": run("rustc", "-vV"),
        "cargo": run("cargo", "-V"),
        "image": {k: os.environ.get(k) for k in ("ImageOS", "ImageVersion")},
        "root": str(Path.cwd()),
        "bundling_signing_notarization_tested": False,
    }
    (report / "versions.json").write_text(json.dumps(data, indent=2) + "\n")
    output("version", current)
    output("image", image)
    print(json.dumps(data, indent=2))


def check_restore(
    phase, prefix, matched, expected_prefix, expected_key, dependency_hit
):
    print(
        json.dumps(
            {
                "phase": phase,
                "prefix": prefix,
                "matched_key": matched,
                "expected_prefix": expected_prefix,
                "expected_key": expected_key,
                "dependency_exact_hit": dependency_hit,
            },
            indent=2,
        )
    )
    if phase == "cold":
        assert not matched and dependency_hit != "true", (
            "new namespace unexpectedly hit"
        )
    else:
        assert prefix == expected_prefix, (
            "compatibility changed beyond app version; compare image/toolchain/root/profile logs"
        )
        assert matched == expected_key and matched, (
            "warm archive was not the cold generation"
        )
        assert dependency_hit == "true", (
            "cold dependency post-job save was not restored exactly"
        )


def analyze(messages, packages, phase):
    members = {p["id"]: p["name"] for p in packages}
    libraries, binary = {}, []
    for message in messages:
        if message.get("reason") != "compiler-artifact":
            continue
        name = members.get(message["package_id"])
        kinds = set(message["target"]["kind"])
        if name and kinds & {"lib", "rlib", "proc-macro"}:
            libraries[name] = message["fresh"]
        if message["target"]["name"] == "openidea-server" and "bin" in kinds:
            binary.append(message["fresh"])
    assert len(libraries) >= 5, "not a meaningful real workspace build"
    assert binary == [False], "final server must be rebuilt, never restored"
    if phase == "cold":
        assert not any(libraries.values()), "cold internal artifact unexpectedly fresh"
    else:
        assert libraries.get("ide-core") and libraries.get("ide-host"), (
            "core and host were not reused"
        )
        assert all(libraries.values()), "some internal libraries were rebuilt"
    return libraries


def build(phase, target, report):
    binary = Path("target") / target / "release/openidea-server"
    assert not binary.exists(), "final server leaked from one of the caches"
    assert not binary.with_name("openidea").exists(), (
        "desktop canary leaked from a cache"
    )
    assert not list(Path("target").rglob("*.sig")), "signature leaked from a cache"
    assert not any(
        p.is_file()
        for folder in Path("target").rglob("bundle")
        for p in folder.rglob("*")
    ), "bundle leaked from a cache"
    metadata = json.loads(
        run("cargo", "metadata", "--no-deps", "--format-version=1", "--locked")
    )
    profile = tomllib.loads(Path("Cargo.toml").read_text())["profile"]["release"]
    assert profile["lto"] == "thin" and os.environ["CARGO_INCREMENTAL"] == "0"
    start = time.monotonic()
    with (report / "cargo.jsonl").open("w") as stream:
        subprocess.run(
            [
                "cargo",
                "build",
                "--release",
                "--locked",
                "-p",
                "ide-host",
                "--bin",
                "openidea-server",
                "--target",
                target,
                "--message-format=json",
            ],
            stdout=stream,
            check=True,
        )
    elapsed = time.monotonic() - start
    messages = [
        json.loads(line) for line in (report / "cargo.jsonl").read_text().splitlines()
    ]
    libraries = analyze(messages, metadata["packages"], phase)
    actual = run(str(binary.resolve()), "--version")
    assert re.fullmatch(
        rf"openidea-server {re.escape(versions())} \(protocol \d+\)", actual
    ), actual
    data = {
        "phase": phase,
        "seconds": elapsed,
        "libraries": libraries,
        "reused": sum(libraries.values()),
        "rebuilt": sum(not x for x in libraries.values()),
        "server": actual,
        "final_binary_fresh": False,
    }
    (report / "build.json").write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps(data, indent=2))
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write(
            f"### {phase}: server cache experiment\n\n```json\n{json.dumps(data, indent=2)}\n```\n"
        )


def inventory(paths_file, report):
    paths = set()
    for pattern in Path(paths_file).read_text().splitlines():
        for path in Path.cwd().glob(pattern):
            if path.is_dir():
                paths.update(p for p in path.rglob("*") if p.is_file())
            elif path.is_file():
                paths.add(path)
    assert paths and Path.cwd() / "target/.release-inputs.json" in paths
    for path in paths:
        name = str(path.relative_to(Path.cwd()))
        assert "/bundle/" not in name and not name.endswith(
            (".sig", ".AppImage", ".deb", ".dmg", ".rpm")
        ), name
        assert not re.fullmatch(
            r"(?:openidea(?:-server|-plugin)?)(?:-[0-9a-f]+)?(?:\.exe)?", path.name
        ), name
        assert not path.name.startswith(("bin-", "dep-bin-", "output-bin-")), name
    expected = json.loads((report / "build.json").read_text())["libraries"]
    libraries = {}
    for package in expected:
        crate = package.replace("-", "_")
        artifacts = [
            p
            for p in paths
            if p.name.startswith(f"lib{crate}-")
            and p.suffix in {".rlib", ".so", ".dylib"}
        ]
        fingerprints = [p for p in paths if p.name == f"lib-{crate}.json"]
        assert artifacts and fingerprints, (
            f"no compiled library/fingerprint in archive: {package}"
        )
        libraries[package] = {
            "artifacts": len(artifacts),
            "units": len(fingerprints),
            "bytes": sum(p.stat().st_size for p in artifacts),
        }
    assert libraries, "snapshot-only archive is not a workspace cache"
    data = {
        "files": len(paths),
        "uncompressed_bytes": sum(p.stat().st_size for p in paths),
        "paths": sorted(str(p.relative_to(Path.cwd())) for p in paths),
        "libraries": libraries,
        "library_bytes": sum(p["bytes"] for p in libraries.values()),
    }
    (report / "archive-inventory.json").write_text(json.dumps(data, indent=2) + "\n")
    print(
        f"Private archive: {data['files']} files, {data['uncompressed_bytes']} bytes, {len(libraries)} libraries ({data['library_bytes']} bytes); no final binaries/bundles/signatures"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation",
        choices=["policy", "prepare", "restore-check", "build", "inventory"],
    )
    parser.add_argument(
        "--phase", choices=["cold", "warm"], default=os.environ.get("PHASE")
    )
    parser.add_argument("--target", default=os.environ.get("BUILD_TARGET"))
    parser.add_argument(
        "--report",
        type=Path,
        default=Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "cache-report",
    )
    args = parser.parse_args()
    if args.operation == "policy":
        print(json.dumps(component_versions(), indent=2))
    elif args.operation == "prepare":
        prepare(args.phase, args.report)
    elif args.operation == "restore-check":
        check_restore(
            args.phase,
            *(
                os.environ.get(k, "")
                for k in (
                    "ACTUAL_PREFIX",
                    "MATCHED_KEY",
                    "EXPECTED_PREFIX",
                    "EXPECTED_KEY",
                    "DEPENDENCY_HIT",
                )
            ),
        )
    elif args.operation == "build":
        build(args.phase, args.target, args.report)
    else:
        inventory(os.environ["CACHE_PATHS_FILE"], args.report)
