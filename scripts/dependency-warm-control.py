"""One hosted runner, two fresh checkouts, identical immutable dependency seed."""

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
BASE = "f80a5c9f9b2de1aeaba6b9b5588b6068e76f7245"
ROOT = Path("/home/runner/work/openidea/openidea")
IMAGE = "20261111.370.1"
NAMESPACE = "verify-release-target-43520576305-1"
PREFIX = (
    f"{NAMESPACE}-v1-Linux-server-validation-x86_64-unknown-linux-gnu-"
    "25ccecd933f0dab1610fd636dc726f7474ea44b1a42687264e56b560f8efc86f-"
)
SEED_KEY = PREFIX + "43520576305-1-warm"
DEPENDENCY_KEY = (
    "verify-release-dependencies-v1-server-43520576305-1-Linux-x64-2bc0fc85-6829d7e7"
)
ARMS = ("dependency-only", "workspace-warm")


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def load(name):
    spec = importlib.util.spec_from_file_location(name, f"scripts/{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def guard():
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
    assert Path.cwd() == ROOT == Path(os.environ["GITHUB_WORKSPACE"])
    assert os.environ["GITHUB_REPOSITORY"] == "s-matsubara/openidea"
    assert os.environ["ImageVersion"] == IMAGE, "seed image differs; comparison refused"


def reset(arm, report):
    write(
        report / arm / "environment.json",
        {
            "image": os.environ.get("ImageVersion"),
            "expected_image": IMAGE,
            "root": str(Path.cwd()),
            "controller_sha": run("git", "rev-parse", "HEAD"),
            "run_id": os.environ.get("GITHUB_RUN_ID"),
            "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        },
    )
    guard()
    assert not ROOT.is_symlink() and not Path(__file__).is_relative_to(ROOT)
    write(report / arm / "start.json", {"monotonic": time.monotonic()})
    # Only the disposable hosted checkout and downloaded Cargo sources are cleared.
    for path in ROOT.iterdir():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
    cargo_home = Path(os.environ["CARGO_HOME"])
    assert cargo_home == Path("/home/runner/.cargo") and not cargo_home.is_symlink()
    for name in ("registry", "git"):
        path = cargo_home / name
        if path.exists():
            assert not path.is_symlink()
            shutil.rmtree(path)
    assert not list(ROOT.iterdir())


def prepare(arm, report):
    guard()
    assert run("git", "rev-parse", "HEAD") == BASE
    assert not run("git", "status", "--porcelain", "--untracked-files=all")
    assert not Path("target").exists(), "checkout must have no prior target"
    verification = load("verify-release-cache")
    verification.prepare("warm", report / arm)
    assert verification.versions() == "2026.2.13"
    cache = load("release-cache")
    files, _ = cache.inputs()
    write(report / arm / "fresh-sources.json", files)
    assert len(files) > 5000
    assert not Path("target").exists(), "preparation unexpectedly created build output"
    original_output = os.environ["GITHUB_OUTPUT"]
    key_file = report / arm / "keys.txt"
    os.environ["GITHUB_OUTPUT"] = str(key_file)
    try:
        cache.keys("server-validation", os.environ["BUILD_TARGET"], NAMESPACE)
    finally:
        os.environ["GITHUB_OUTPUT"] = original_output
    keys = key_file.read_text()
    prefix = next(
        s.removeprefix("prefix=") for s in keys.splitlines() if s.startswith("prefix=")
    )
    assert prefix == PREFIX, f"seed compatibility differs: {prefix}"
    with open(original_output, "a") as stream:
        stream.write(keys)
        stream.write(f"seed-key={SEED_KEY}\n")


def inventory(root):
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            assert not path.is_symlink(), path
            info = path.stat()
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            result[str(path.relative_to(root))] = [
                digest,
                info.st_size,
                info.st_mode,
                info.st_mtime_ns,
            ]
    return result


def dependency_check(arm, report):
    assert os.environ["DEPENDENCY_HIT"] == "true", "exact dependency seed required"
    cache = load("release-cache")
    forbidden = []
    for pattern in cache.artifact_paths(cache.packages()).splitlines():
        forbidden.extend(str(p) for p in Path.cwd().glob(pattern) if p.is_file())
    assert not forbidden, (
        f"workspace artifacts leaked into dependency archive: {forbidden}"
    )
    snapshot = inventory(Path("target"))
    assert snapshot, "dependency target is empty"
    write(report / arm / "dependency-target.json", snapshot)
    files, _ = cache.inputs()
    assert files == json.loads((report / arm / "fresh-sources.json").read_text()), (
        "dependency restoration changed source content/mode/mtime"
    )
    write(report / arm / "dependency.json", {"exact_hit": True, "key": DEPENDENCY_KEY})
    if arm == "workspace-warm":
        assert snapshot == json.loads(
            (report / ARMS[0] / "dependency-target.json").read_text()
        ), "the two restored dependency targets differ"
        previous = json.loads((report / ARMS[0] / "fresh-sources.json").read_text())
        assert {k: v["hash"] for k, v in previous.items()} == {
            k: v["hash"] for k, v in files.items()
        }
        assert all(files[k]["mtime"] > previous[k]["mtime"] for k in files), (
            "second checkout retained source timestamps"
        )


def build(arm, report):
    verification = load("verify-release-cache")
    cache = load("release-cache")
    if arm == "workspace-warm":
        assert os.environ["MATCHED_KEY"] == SEED_KEY
        assert os.environ["ACTUAL_PREFIX"] == PREFIX
        assert cache.STATE.is_file()
        write(
            report / arm / "workspace.json", {"prefix": PREFIX, "matched_key": SEED_KEY}
        )
    else:
        assert not cache.STATE.exists()
    verification.build(
        "cold" if arm == ARMS[0] else "warm", os.environ["BUILD_TARGET"], report / arm
    )
    data = json.loads((report / arm / "build.json").read_text())
    data["phase"] = arm
    local_ids = {p["id"] for p in cache.packages()}
    dependencies = {}
    for line in (report / arm / "cargo.jsonl").read_text().splitlines():
        item = json.loads(line)
        if (
            item.get("reason") == "compiler-artifact"
            and item["package_id"] not in local_ids
        ):
            name = f"{item['package_id']}:{item['target']['name']}:{','.join(item['target']['kind'])}"
            dependencies[name] = item["fresh"]
    write(report / arm / "dependency-fresh.json", dependencies)
    data["dependency_units_fresh"] = sum(dependencies.values())
    data["dependency_units_rebuilt"] = sum(not value for value in dependencies.values())
    write(report / arm / "build.json", data)
    start = json.loads((report / arm / "start.json").read_text())["monotonic"]
    write(
        report / arm / "elapsed.json",
        {
            "reset_checkout_prepare_restore_verify_build_seconds": time.monotonic()
            - start
        },
    )


def compare(report):
    first, second = [
        json.loads((report / arm / "build.json").read_text()) for arm in ARMS
    ]
    assert first["libraries"].keys() == second["libraries"].keys()
    assert len(first["libraries"]) == 36
    assert not any(first["libraries"].values())
    assert all(second["libraries"].values())
    assert (
        first["server"] == second["server"] == "openidea-server 2026.2.13 (protocol 2)"
    )
    versions = [
        json.loads((report / arm / "versions.json").read_text()) for arm in ARMS
    ]
    assert versions[0] == versions[1]
    assert versions[0]["sha"] == BASE
    assert len(versions[0]["components"]) == 43
    result = {
        "baseline_sha": BASE,
        "seed_run": 43520576305,
        "seed_attempt": 1,
        "dependency_key": DEPENDENCY_KEY,
        "workspace_key": SEED_KEY,
        "image": IMAGE,
        "arms": dict(zip(ARMS, [first, second])),
        "build_seconds_saved": first["seconds"] - second["seconds"],
        "build_reduction_percent": 100 * (1 - second["seconds"] / first["seconds"]),
        "limitations": "One sequential pair on one runner; OS page caches are not flushed. Server-only, no signing/bundling/GUI. No cache saves.",
    }
    write(report / "comparison.json", result)
    print(json.dumps(result, indent=2))
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
        stream.write(
            f"## Dependency-warm control\n\n```json\n{json.dumps(result, indent=2)}\n```\n"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation",
        choices=["reset", "prepare", "dependency-check", "build", "compare"],
    )
    parser.add_argument("arm", choices=ARMS, nargs="?")
    args = parser.parse_args()
    report = Path(os.environ["RUNNER_TEMP"]) / "dependency-warm-control"
    if args.operation == "compare":
        compare(report)
    else:
        assert args.arm
        globals()[args.operation.replace("-", "_")](args.arm, report)
