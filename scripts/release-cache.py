"""Content-verified source mtimes for the private release target cache (Python 3.12)."""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import time
import tomllib
from pathlib import Path

FORMAT = 1
STATE = Path("target/.release-inputs.json")


def artifact_paths(workspace):
    # Select leaves rather than parent directories: tar must not re-include excluded app bundles.
    paths = {"target/.release-inputs.json"}
    for package in workspace:
        if package["name"] == "openidea":
            continue
        name = package["name"]
        paths.add(f"target/**/.fingerprint/{name}-*/*")
        for target in package["targets"]:
            if "lib" in target["kind"] or "proc-macro" in target["kind"]:
                crate = target["name"].replace("-", "_")
                paths.update(
                    [f"target/**/deps/{crate}-*.d", f"target/**/deps/lib{crate}-*"]
                )
            if "custom-build" in target["kind"]:
                for leaf in [
                    "output",
                    "stderr",
                    "root-output",
                    "invoked.timestamp",
                    "build*",
                    "out",
                ]:
                    paths.add(f"target/**/build/{name}-*/{leaf}")
    return "\n".join(sorted(paths))


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def tracked():
    return subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")[:-1]


def relative(path):
    """Never follow symlinks or accept paths outside this checkout."""
    path = Path(os.path.abspath(path))
    try:
        rel = path.relative_to(Path.cwd())
    except ValueError:
        return None
    if any(
        parent.is_symlink() for parent in [path, *path.parents] if parent != Path.cwd()
    ):
        return None
    return str(rel) if str(rel) != "." else "."


def inputs():
    files, dirs = {}, {"."}
    for name in tracked():
        path = Path(name)
        if relative(path) is None or not path.is_file():
            continue
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            continue
        h = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(chunk)
        files[name] = {
            "hash": digest([h.hexdigest(), stat.S_IMODE(info.st_mode)]),
            "mtime": info.st_mtime_ns,
        }
        dirs.update(str(parent) for parent in path.parents)
    directory = {}
    for name in sorted(dirs, key=lambda n: len(Path(n).parts), reverse=True):
        path = Path(name)
        entries, known = [], True
        for entry in path.iterdir():
            key = str(entry)
            item = files.get(key) or directory.get(key)
            if item is None or item["hash"] is None:
                known = False
            else:
                entries.append([entry.name, item["hash"]])
        info = path.stat()
        directory[name] = {
            "hash": digest([sorted(entries), stat.S_IMODE(info.st_mode)])
            if known
            else None,
            "mtime": info.st_mtime_ns,
        }
    return files, directory


def packages():
    metadata = json.loads(
        command("cargo", "metadata", "--no-deps", "--format-version=1")
    )
    if Path(metadata["target_directory"]) != Path.cwd() / "target":
        raise ValueError("release cache supports only this checkout's target directory")
    return [p for p in metadata["packages"] if p["id"] in metadata["workspace_members"]]


def fingerprints(name, pattern="*"):
    for prefix in ["*/.fingerprint", "*/*/.fingerprint"]:
        yield from Path("target").glob(f"{prefix}/{name}-*/{pattern}")


def anchors():
    paths = []
    for prefix in ["*/.fingerprint", "*/*/.fingerprint"]:
        paths.extend(Path("target").glob(f"{prefix}/*/*"))
    for prefix in ["*/build", "*/*/build"]:
        paths.extend(Path("target").glob(f"{prefix}/*/output"))
    return max((p.stat().st_mtime_ns for p in paths if p.is_file()), default=0)


def source_rules(path):
    """rustc's empty Makefile rules name its inputs. Reject unfamiliar escaping."""
    result = []
    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or not line.endswith(":"):
            continue
        value = line[:-1]
        if (
            "$" in value
            or "\\" in value
            or not value
            or any(c.isspace() for c in value)
        ):
            raise ValueError("unrecognised dep-info input")
        result.append(relative(value))
    if not result:
        raise ValueError("missing dep-info inputs")
    return result


def known(path, files, dirs):
    entry = files.get(path) or dirs.get(path)
    return entry is not None and entry["hash"] is not None


def capture():
    files, dirs = inputs()
    units = []
    for package in packages():
        root = Path(package["manifest_path"]).parent
        for target in package["targets"]:
            primary = relative(target["src_path"])
            dependencies, uncertain = [], False
            if "custom-build" in target["kind"]:
                runs = list(fingerprints(package["name"], "run-build-script-*.json"))
                if not runs:
                    if not list(fingerprints(package["name"], "build-script-*.json")):
                        continue
                    uncertain = True
                for run in runs:
                    try:
                        changed = False
                        for item in json.loads(run.read_text())["local"]:
                            if "RerunIfChanged" in item:
                                changed = True
                                dependencies.extend(
                                    relative(root / p)
                                    for p in item["RerunIfChanged"]["paths"]
                                )
                            elif "RerunIfEnvChanged" not in item:
                                uncertain = True
                        uncertain |= not changed
                    except (ValueError, KeyError, TypeError):
                        uncertain = True
            else:
                paths = []
                for prefix in ["*/deps", "*/*/deps"]:
                    paths.extend(
                        Path("target").glob(
                            f"{prefix}/{target['name'].replace('-', '_')}-*.d"
                        )
                    )
                if not paths:
                    if not set(target["kind"]) & {
                        "lib",
                        "rlib",
                        "dylib",
                        "cdylib",
                        "staticlib",
                        "proc-macro",
                    }:
                        continue
                    if not list(fingerprints(package["name"], "lib-*.json")):
                        continue
                    uncertain = True
                for path in paths:
                    try:
                        dependencies.extend(source_rules(path))
                    except (ValueError, UnicodeError):
                        uncertain = True
            units.append(
                {
                    "primary": primary,
                    "inputs": dependencies,
                    "uncertain": uncertain or primary is None,
                }
            )
    state = {
        "format": FORMAT,
        "root": str(Path.cwd()),
        "files": files,
        "dirs": dirs,
        "units": units,
        "anchor": anchors(),
    }
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, sort_keys=True))
    print(
        f"Snapshotted {len(files)} tracked inputs; unknown inputs force their compilation target dirty"
    )


def purge_workspace_fingerprints():
    # Missing/foreign metadata must never make a restored workspace artifact look fresh.
    import shutil

    for package in packages():
        for item in list(fingerprints(package["name"])):
            shutil.rmtree(item.parent, ignore_errors=True)


def restore():
    try:
        state = json.loads(STATE.read_text())
        if state["format"] != FORMAT or state["root"] != str(Path.cwd()):
            raise ValueError("foreign cache metadata")
        files, dirs = inputs()
        barrier = time.time_ns()
        if max(state["anchor"], anchors()) >= barrier:
            purge_workspace_fingerprints()
            print(
                "Cached fingerprints are not older than this clock: forced a safe rebuild"
            )
        restored, dirty = 0, 0
        for kind, current in [("files", files), ("dirs", dirs)]:
            for name, item in current.items():
                previous = state[kind].get(name)
                same = (
                    previous
                    and item["hash"] is not None
                    and item["hash"] == previous["hash"]
                )
                stamp = previous["mtime"] if same else barrier
                os.utime(name, ns=(stamp, stamp))
                restored += bool(same)
                dirty += not same
        forced = set()
        for unit in state["units"]:
            if unit["uncertain"] or any(
                not known(p, files, dirs) for p in unit["inputs"]
            ):
                primary = unit["primary"]
                if (
                    primary is None
                    or relative(primary) != primary
                    or primary not in files
                ):
                    purge_workspace_fingerprints()
                    print(
                        "Unverifiable compilation target: discarded workspace fingerprints"
                    )
                    return
                forced.add(primary)
        for name in forced:
            os.utime(name, ns=(barrier, barrier))
        print(
            f"Content-verified mtimes: {restored} reused, {dirty} changed, {len(forced)} targets forced dirty"
        )
    except (OSError, ValueError, KeyError, TypeError):
        purge_workspace_fingerprints()
        print("No valid input snapshot: discarded workspace fingerprints")


def keys(scope, target):
    manifests = {}
    workspace = packages()
    for package in workspace:
        path = Path(package["manifest_path"])
        data = tomllib.loads(path.read_text())
        if package["name"] == "openidea":
            data["package"]["version"] = "<application-release>"
        manifests[str(path.relative_to(Path.cwd()))] = data
    root = tomllib.loads(Path("Cargo.toml").read_text())
    lock = tomllib.loads(Path("Cargo.lock").read_text())
    for package in lock["package"]:
        if package["name"] == "openidea" and "source" not in package:
            package["version"] = "<application-release>"
    environment = {
        key: value
        for key, value in os.environ.items()
        if re.match(
            r"^(RUST|CARGO_|CC($|_)|CXX($|_)|AR($|_)|CFLAGS|CXXFLAGS|LDFLAGS|OPENIDEA_|MACOSX_DEPLOYMENT_TARGET$|SDKROOT$|ImageOS$|ImageVersion$)",
            key,
        )
    }
    configuration = {
        name: Path(name).read_text()
        for name in tracked()
        if name.startswith((".cargo/", "rust-toolchain"))
        or name
        in [
            ".github/workflows/release.yml",
            ".github/actions/release-cache/action.yml",
            "scripts/release-cache.py",
        ]
    }
    compatibility = digest(
        [
            FORMAT,
            scope,
            target,
            str(Path.cwd()),
            command("rustc", "-vV"),
            command("cargo", "-V"),
            environment,
            root,
            manifests,
            lock,
            configuration,
        ]
    )
    prefix = f"release-target-v{FORMAT}-{os.environ.get('RUNNER_OS', os.name)}-{scope}-{target}-{compatibility}"
    # The unique suffix is save-only. It must never enter the cross-commit restore prefix.
    key = f"{prefix}-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}"
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(
            f"key={key}\nprefix={prefix}-\npaths<<CACHE_PATHS\n{artifact_paths(workspace)}\nCACHE_PATHS\n"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["capture", "restore", "keys"])
    parser.add_argument("--scope")
    parser.add_argument("--target")
    args = parser.parse_args()
    if args.operation == "keys":
        keys(args.scope, args.target)
    elif args.operation == "capture":
        capture()
    else:
        restore()
