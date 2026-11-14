"""Non-distribution Cargo layout control, confined to one disposable Actions checkout."""

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
REPORT = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "cargo-layout-report"
DEPENDENCIES = REPORT.parent / "cargo-layout-dependencies.tar"


def load(name):
    spec = importlib.util.spec_from_file_location(name, f"scripts/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def guard():
    assert os.environ["GITHUB_REPOSITORY"] == "s-matsubara/openidea"
    assert os.environ["RUNNER_ENVIRONMENT"] == "github-hosted"
    assert os.environ["GITHUB_EVENT_NAME"] == "pull_request"
    assert Path.cwd() == Path(os.environ["GITHUB_WORKSPACE"])
    assert not Path.cwd().is_symlink()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def provenance():
    return {
        "sha": run("git", "rev-parse", "HEAD"),
        "root": str(Path.cwd()),
        "image": os.environ["ImageVersion"],
        "cargo": run("cargo", "-V"),
        "rustc": run("rustc", "-vV"),
        "target": os.environ["BUILD_TARGET"],
        "incremental": os.environ["CARGO_INCREMENTAL"],
        "cc": os.environ["CC_x86_64_unknown_linux_musl"],
    }


def prepare(arm):
    guard()
    verification = load("verify-release-cache")
    if arm == "seed":
        assert not Path("target").exists(), "seed checkout must be empty"
        write(REPORT / "provenance.json", provenance())
    else:
        assert provenance() == json.loads((REPORT / "provenance.json").read_text())
        assert not run("git", "status", "--porcelain", "--untracked-files=no")
    verification.prepare("cold" if arm == "seed" else "warm", REPORT / arm)
    if arm != "seed":
        assert not Path("target").exists()
        run("tar", "-xf", str(DEPENDENCIES))
        assert dependency_inventory() == json.loads(
            (REPORT / "dependency-inventory.json").read_text()
        )
        assert_no_workspace()
        write(
            REPORT / arm / "dependency-restore.json",
            {
                "sha256": sha256(DEPENDENCIES),
                "workspace_artifacts": 0,
            },
        )


def assert_no_workspace():
    metadata = json.loads(run("cargo", "metadata", "--no-deps", "--format-version=1"))
    for package in metadata["packages"]:
        for profile in ("target/*", "target/*/*"):
            for suffix in (
                f"build/{package['name']}",
                f"build/{package['name']}-*",
                f".fingerprint/{package['name']}-*",
            ):
                assert not list(Path().glob(f"{profile}/{suffix}")), (
                    package["name"],
                    suffix,
                )
        for target in package["targets"]:
            name = target["name"].replace("-", "_")
            for pattern in (f"target/**/deps/{name}-*", f"target/**/deps/lib{name}-*"):
                assert not list(Path().glob(pattern)), pattern
    # Independent Cargo JSON lists every workspace compiler output, including bin units.
    for line in (REPORT / "seed/cargo.jsonl").read_text().splitlines():
        item = json.loads(line)
        if item.get("reason") == "compiler-artifact" and item["package_id"].startswith(
            "path+"
        ):
            for path in item["filenames"]:
                assert not Path(path).exists(), path
    assert not Path("target/.release-inputs.json").exists()


def dependency_inventory():
    # Include content, mode and exact mtimes, not just archive size.
    return {
        str(path): [
            path.stat().st_size,
            path.stat().st_mode,
            path.stat().st_mtime_ns,
            sha256(path),
        ]
        for path in sorted(Path("target").rglob("*"))
        if path.is_file()
    }


def save_dependencies():
    guard()
    metadata = json.loads(run("cargo", "metadata", "--no-deps", "--format-version=1"))
    # Separate the dependency archive independently of release-cache.artifact_paths.
    for profile in {
        p.parent
        for pattern in ("target/*/build", "target/*/*/build")
        for p in Path().glob(pattern)
    }:
        for path in list(profile.iterdir()):
            if path.name not in {"deps", "build", ".fingerprint"}:
                shutil.rmtree(path) if path.is_dir() else path.unlink()
        for package in metadata["packages"]:
            for pattern in (
                f"build/{package['name']}",
                f"build/{package['name']}-*",
                f".fingerprint/{package['name']}-*",
            ):
                for path in profile.glob(pattern):
                    shutil.rmtree(path)
            for target in package["targets"]:
                name = target["name"].replace("-", "_")
                for pattern in (f"deps/{name}-*", f"deps/lib{name}-*"):
                    for path in profile.glob(pattern):
                        path.unlink()
    Path("target/.release-inputs.json").unlink()
    assert_no_workspace()
    write(REPORT / "dependency-inventory.json", dependency_inventory())
    # PAX retains nanosecond mtimes needed by Cargo fingerprints.
    run("tar", "--format=posix", "-cf", str(DEPENDENCIES), "target")


def reset():
    guard()
    assert not Path(__file__).resolve().is_relative_to(Path.cwd())
    # This controller runs outside the checkout. Recreate every tracked source;
    # never touch a developer worktree, a ref, or another job's workspace.
    shutil.rmtree("target")
    for name in (
        subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")[:-1]
    ):
        path = Path(name)
        if path.exists() or path.is_symlink():
            path.unlink()
    run("git", "checkout-index", "--all", "--force")
    assert not Path("target").exists()


def build(arm):
    guard()
    verification = load("verify-release-cache")
    verification.build(
        "warm" if arm == "workspace-warm" else "cold",
        os.environ["BUILD_TARGET"],
        REPORT / arm,
    )
    external = {}
    for line in (REPORT / arm / "cargo.jsonl").read_text().splitlines():
        item = json.loads(line)
        if item.get("reason") == "compiler-artifact" and not item[
            "package_id"
        ].startswith("path+"):
            key = json.dumps(
                [
                    item["package_id"],
                    item["target"]["name"],
                    item["target"]["kind"],
                    item["profile"],
                ],
                sort_keys=True,
            )
            external[key] = item["fresh"]
    assert external
    write(REPORT / arm / "external.json", external)
    if arm != "seed":
        assert all(external.values()), "external dependency recompiled; control invalid"
        assert set(external) == set(
            json.loads((REPORT / "seed/external.json").read_text())
        )
    if arm == "workspace-warm":
        first = json.loads((REPORT / "dependency-only/build.json").read_text())
        second = json.loads((REPORT / arm / "build.json").read_text())
        assert first["libraries"].keys() == second["libraries"].keys()
        assert first["server"] == second["server"]
        assert (REPORT / "dependency-only/dependency-restore.json").read_bytes() == (
            REPORT / arm / "dependency-restore.json"
        ).read_bytes()
        data = {
            "dependency_only": first,
            "workspace_warm": second,
            "external_units": len(external),
            "all_external_fresh": True,
            "provenance": provenance(),
        }
        write(REPORT / "comparison.json", data)
        print(json.dumps(data, indent=2))
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(
                f"\nSame runner / fresh checkout control:\n```json\n{json.dumps(data, indent=2)}\n```\n"
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation", choices=["prepare", "build", "save-dependencies", "reset"]
    )
    parser.add_argument(
        "arm", nargs="?", choices=["seed", "dependency-only", "workspace-warm"]
    )
    args = parser.parse_args()
    if args.operation == "prepare":
        prepare(args.arm)
    elif args.operation == "build":
        build(args.arm)
    elif args.operation == "reset":
        reset()
    else:
        save_dependencies()
