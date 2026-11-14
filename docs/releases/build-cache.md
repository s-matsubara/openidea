# Release versions and compiled workspace caches

The application release lives in `src-tauri/Cargo.toml`, `package.json` and
`src-tauri/tauri.conf.json`. `release:prepare` updates those and only the
`openidea` version in Cargo.lock. Omit `version` from `[workspace.package]` and
all 43 internal `crates/*/Cargo.toml` packages, including `version.workspace`.
Cargo assigns these internal packages **0.0.0**; their identities remain unchanged
on subsequent app-only releases. Guest SDK, plugins and fixtures retain their
separate version policies.

Migrating from the former explicit **2026.2.12** baseline changes internal
package identities and the workspace cache compatibility digest once, so the
first build safely starts a new workspace artifact cache. Later app-only releases
keep the same internal identities.
Run `python3 scripts/verify-release-cache.py policy` to reject version fields
reintroduced by new upstream crates and require Cargo metadata to report `0.0.0`
for every internal package.

Executables initialize `ide_core::version` before services start. The desktop
uses its own package version; the server/plugin binaries embed the version from
tauri.conf.json **in their binary targets**, not in ide-host's library. About,
remote server identity/downloads, CLI output, MCP/LSP/agent client identities and
terminal metadata keep the application release. Persistent syntax, SVG and shell
integration cache salts also retain release-based invalidation. Embedded library
users can initialize their own public version; without it they get `0.0.0`. New upstream uses of `CARGO_PKG_VERSION` in public metadata need review.

The Release tag/app-version guard now reads the application's Cargo.toml. Asset
names and updater `latest.json` still use the explicit validated tag. This fork
has no separate appcast generator. Main-only dispatch, draft ownership, immutable
resolved-tag checkout, four desktop platforms and Thin LTO remain unchanged.

## Two cache layers

The inspected [Swatinem configuration](https://github.com/Swatinem/rust-cache/blob/v2/src/config.ts)
normalizes manifest versions and ignores local lockfile package versions. Its
[restore](https://github.com/Swatinem/rust-cache/blob/v2/src/restore.ts) and
[save](https://github.com/Swatinem/rust-cache/blob/v2/src/save.ts) skip saving an
exact hit. Adding a commit to its `key` also changes its restore prefix. Merely
setting `cache-workspace-crates: true` therefore does not solve this problem.

Keep Swatinem's dependency-only target/registry cache (workspace crates remain
excluded). Add a separate archive containing only local library artifacts,
local fingerprints/build outputs and their input snapshot. It excludes the app,
server/plugin binaries, bundles and incremental state. Save it before Swatinem's
post-job cleanup, then remove the snapshot from the dependency-only archive.
This avoids storing another complete copy of the third-party dependency target.

[Actions caches are immutable](https://github.com/actions/cache/blob/main/README.md).
The new save key has a unique **run ID + attempt** suffix. Restore uses a separate
prefix without that suffix, tag or commit SHA. Its compatibility digest covers
rustc/cargo versions and host, target, job scope, profile/dependency manifests,
normalized app version/local lock entry, Cargo configuration, build flags,
relevant environment, runner image/SDK and the cache implementation/workflow.
Dependency/toolchain/configuration changes conservatively start a new compiled
workspace cache. Swatinem separately restores third-party dependencies. Its key
also includes runner-image/SDK environment, without a per-commit suffix.
All builds still run Cargo; a cache hit never skips the build or validation.

## Content verification, not commit timestamps

[Stable Cargo uses source/dep-info mtimes](https://doc.rust-lang.org/stable/nightly-rustc/cargo/compiler/fingerprint/index.html),
including build.rs `rerun-if-changed` inputs. A fresh checkout can invalidate an
unchanged source. Conversely, resetting every file to its Git commit date can
hide changed or reverted content. Do not do that.

`release-cache.py` snapshots tracked file content hashes, modes and actual
nanosecond mtimes after a successful build. A directory is known only when its
complete entry tree is known. On restore, only identical inputs get their prior
mtime. Changed/new files and directories get the current time. A cached anchor
not older than the runner clock causes workspace fingerprints to be discarded;
we never synthesize future timestamps that could leave a unit permanently dirty.

The snapshot records rustc dep-info inputs and custom-build `rerun-if-changed`
paths. Missing, external, untracked/generated, symlinked or unrecognised inputs
force that compilation target dirty. Directory deletions change the directory
signature; unknown custom-build inputs force recompilation of the build script.
Missing/foreign metadata discards workspace fingerprints. Cargo still checks
features, dependency fingerprints and declared `rerun-if-env-changed` itself.
The scheme relies on trusted main caches and Cargo's declared-input contract;
it is not a sandbox for build scripts that hide filesystem/network dependencies.
Unsupported dep-info escaping/layouts can cost cache hits rather than silently
reusing unverifiable workspace output. Custom target directories are rejected.

## Reproducible verification

Requires Python 3.12, Git and a Rust toolchain. Fetch Cargo dependencies first
(`cargo fetch --locked`); the miniature builds then run offline. Run:

```sh
python3 scripts/verify-release-cache.py policy
python3 scripts/verify-release-cache.test.py
RELEASE_CACHE_REPORT=/tmp/cache-report.json python3 scripts/release-cache.test.py
node --test scripts/release-workflow.test.mjs
pnpm vitest run scripts/release-prepare.test.ts scripts/nightly-prepare.test.ts
```

The Linux x86-64 experiment uses real `cargo build --release` with Thin LTO and
incremental disabled. It simulates fresh checkouts at the same absolute path,
a dependency-only archive plus a separate workspace archive, and runs the built
desktop/server fixtures to verify the new public version. It copies the actual
runtime-version implementation and server initializer from this repository. The
production fixture omits internal versions; the inherited-version control adds
explicit workspace inheritance only for that control.
The current 15-case suite also executes the canonical release/nightly preparation
scripts, checks that their Cargo updates preserve omitted internal versions, and
verifies that migration from explicit inheritance changes the cache prefix once.
The omitted-version app-only experiment keeps all three internal library targets
fresh while rebuilding both executables with the real application version.

The following recorded measurements predate omission and used the explicit
2026.2.12 internal baseline. They remain historical evidence, not measurements
of the new omission policy.

| Version-only change after a fresh checkout                | Internal libraries recompiled |
| --------------------------------------------------------- | ----------------------------- |
| Workspace-wide version bump, even with verified mtimes    | 3 / 3                         |
| Split version, restored artifacts without verified mtimes | 3 / 3                         |
| Split version + content-verified workspace cache          | **0 / 3**                     |

Thirteen experiment cases also cover backdated edits, subsequent unchanged builds,
build.rs directory deletion, unknown generated/include inputs, declared environment
changes, missing metadata/dep-info, clock skew, immutable save generations and
compatibility boundaries. It asserts that app/server binaries are rebuilt with
the new version while no installer, signature or final binary enters the
workspace archive.
[Raw local measurements](build-cache-experiment.json) record Cargo's `fresh` flags;
the tiny fixture's elapsed seconds are **not** an IDE Release benchmark.
A copied real-repository `release:prepare 2026.2.13` also changed only openidea's
lockfile version, leaving the root and all 43 internal versions unchanged. No
release/tag was made for this test.

## Hosted measurements

[Run 43520576305](https://github.com/s-matsubara/openidea/actions/runs/43520576305),
at `f80a5c9f9b2de1aeaba6b9b5588b6068e76f7245`, completed both original
cold/warm jobs. Both used Ubuntu 24.04 ImageVersion **20261111.370.1**, Rust/cargo
1.99.1, `x86_64-unknown-linux-gnu`, Thin LTO, incremental=0 and two build jobs.
Both checked out the same SHA at `/home/runner/work/openidea/openidea`.

| Real server build                  | Both caches cold | Both caches warm, app-only bump |
| ---------------------------------- | ---------------- | ------------------------------- |
| Build seconds                      | 1037.554         | 246.728                         |
| Internal libraries rebuilt / fresh | 36 / 0           | 0 / 36                          |
| Actual server version (protocol 2) | 2026.2.12        | 2026.2.13                       |
| Final server restored              | No               | No; rebuilt                     |
| Whole hosted job                   | 18m00s           | 4m57s                           |

The 76.2% shorter build compares **both caches empty** with **both warm**. It is
not the incremental benefit over the old dependency-only warm cache, nor a full
IDE Release/macOS/Windows claim. All 43 component versions remained 2026.2.12.
The app's four version locations agreed at 2026.2.13 after preparation.
[Recorded measurements and library fresh flags](build-cache-hosted.json) preserve
the evidence beyond the Actions artifacts' seven-day retention.

The dependency archive was **814,471,562 compressed bytes**. The workspace archive
contained **257 files / 502,714,371 raw bytes** and **166,046,019 compressed bytes**.
Warm restored the exact dependency key and the exact cold workspace generation
through a prefix hit. It saved its own workspace generation (166,046,006 bytes),
without a dependency save on an exact hit. Source verification reported 6501
reused mtimes, 6 changed inputs/directories and 1 target forced dirty. Final
executables, bundle and signature canaries were absent before the build and were
excluded from the workspace archive. This is archive/version evidence, not a
real signing test.

The earlier [run 43517440856](https://github.com/s-matsubara/openidea/actions/runs/43517440856)
correctly rejected cold AWS image **20261111.127.1** versus warm Azure image
**20261111.370.1**. It remains a failed comparison. Production image invalidation
was not weakened to obtain a hit; updates/provider image changes can cold-start.

## Dependency-only warm control

[Run 43526804698](https://github.com/s-matsubara/openidea/actions/runs/43526804698)
completed successfully on controller commit `d6131904`, attempt 1. Both arms
built the exact source commit `f80a5c9f`, using the same Azure Ubuntu 24.04 image
**20261111.370.1** and the toolchain/profile/root described above.

| Measurement                                      | Dependency cache only  | Dependency + workspace cache |
| ------------------------------------------------ | ---------------------- | ---------------------------- |
| Actual server build                              | **737.567 s**          | **311.728 s**                |
| Internal libraries rebuilt / fresh               | **36 / 0**             | **0 / 36**                   |
| External dependency units rebuilt / fresh        | 0 / 699                | 0 / 699                      |
| Actual server version                            | 2026.2.13 (protocol 2) | 2026.2.13 (protocol 2)       |
| Final server compiler-artifact fresh flag        | false                  | false                        |
| Approx. per-arm elapsed from log step boundaries | 763.8 s                | 342.6 s                      |

Adding the workspace cache saved **425.839 build seconds (57.7%, 2.37x)**
relative to an already-warm dependency cache in this pair. Both restored the
same **814,471,562-byte** dependency archive with exact hits; the entire restored
target inventory matched. The extra workspace restore transferred
**166,046,006 bytes**. Its complete action took **4.266 s**, including **1.846 s**
download/extraction and **1.511 s** verified-mtime recovery (6506 reused, 1 changed,
1 target forced dirty). Neither arm saved a cache. Per-arm log boundaries include
checkout/setup/verification differences and show about **421.2 s** net savings;
they are not a measurement of full production Release cost.

The additional restore overhead was much smaller than the saved compilation
time. This supports adopting the cache mechanism after the review/desktop checks
below. It does not establish the same percentage on other builds or platforms.
[Raw reports](https://github.com/s-matsubara/openidea/actions/runs/43526804698/artifacts/14087065239)
include Cargo JSON, inventories and per-arm monotonic elapsed times. The committed
[hosted summary](build-cache-hosted.json) preserves exact build seconds, all 36
fresh flags, provenance, cache keys, transfer evidence and the artifact digest.
Local checks for the control passed: 5 controller gates, 3 existing verification
gates, 14 version tests, 23 Release workflow tests, actionlint 1.7.12, Ruff and
format/diff checks. No production Rust/cache implementation changed in this
follow-up; the earlier 13 real Cargo cache tests and runtime-version test remain
the existing evidence, not newly rerun tests in the replacement environment.

The current `verify-release-cache.yml` replaces the original two-job experiment
with one runner and two completely fresh checkouts of the measured SHA above.
It only builds a PR head whose commit body has the exact trailer
`Cache-Control: dependency-warm-v1`; report-only follow-ups run a small gate and
skip the builds. PR path filters inspect cumulative changes, so adding a second
workflow alone would not have prevented duplicate cold builds.

This is a **one-off control pinned to an existing seed**, not a general release
benchmark. An ordinary push without the marker skips measurement. The seed may
be evicted, and a different image/toolchain/root must fail compatibility rather
than silently run cold or weaken production boundaries. Do not blindly rerun to
obtain a matching image.

The original cold/warm seed-producing workflow is preserved in Git at
`f80a5c9f9b2de1aeaba6b9b5588b6068e76f7245`. Inspect it without running anything:

```sh
git show f80a5c9f9b2de1aeaba6b9b5588b6068e76f7245:.github/workflows/verify-release-cache.yml
```

For an intentionally requested new cold/warm experiment, restore that workflow
to the same filename in a **new commit on this PR branch**; do not reset/force the
published branch or change main/tags. Pin its shared checkout step to the full
source SHA above when reproducing these exact sources. Keep the original
`scripts/verify-release-cache.py`, cache action and cache script at that revision.
Review/actionlint it, then push the new verification commit. Its PR trigger and
branch guard start cold then warm, with a new run/attempt namespace, a shared
dependency key, and separate workspace save generations. Cold must miss both
caches; warm bumps only the app version and must restore the cold generation and
exact dependency archive. Its image guard rejects a mismatched second runner.
Record that rejection as a failed comparison; do not use a blind retry. Restore
the marker-gated control workflow afterwards if continuing report-only work.
No such new seed-producing experiment was run in this follow-up.

The controller is copied to the runner's temporary directory before either
checkout. Between arms it removes the disposable checkout (including `.git`,
all sources and `target`) and Cargo's downloaded registry/git directories.
Neither a previous target nor restored source mtimes can survive into the next
checkout. It checks clean checkout/no target, then applies the identical real
`release-prepare` app-only change **2026.2.12 -> 2026.2.13** in both arms.

Both arms require the original run's exact dependency seed through its original
shared-key. The workspace compatibility prefix must match in full, including
image/toolchain/profile/root/environment. Before building, a lookup requires the
existing immutable workspace seed, and the dependency target must contain no
workspace-library artifacts, fingerprints or input snapshot. The second arm's
dependency target is compared file-for-file (SHA-256, size, mode, nanosecond mtime)
against the first. Tracked source content/modes must match across arms, all
second-checkout file mtimes must be newer, and dependency restoration must not
modify source mtimes.

Only the second arm runs the original workspace cache action and its verified
mtime restore. Its matched key must be run **43520576305 / attempt 1 / warm**,
which was saved after the successful app-2026.2.13 build. Both builds must
regenerate the final server and return **2026.2.13 (protocol 2)**. The comparison
requires the same 36 library names, all rebuilt in the dependency-only arm and
all fresh in the workspace-warm arm. Both Swatinem saves are disabled and no
workspace save runs. No cache is produced by the control.

This is one sequential pair, dependency-only first, on the same hosted runner.
It removes image/CPU differences between arms but does not flush OS page caches
or establish a statistical distribution. Build-only timing excludes transfers;
per-arm elapsed timing also includes reset, checkout, preparation, restore and
verification (the first arm additionally checks seed availability). Production
save/bundling/signing costs are not measured by that elapsed timing.

The workflow uses `contents: read`, no signing secrets, and uploads only public
measurement JSON, raw Cargo fresh flags and inventories. It creates no tag,
Release, updater manifest, executable distribution artifact or installer.

## Historical verification and adoption notes

These notes record the experiment's review checklist before PR #1 was merged
at `a1a31318`. They are not a statement of the current Release's status.
At measurement time the PR remained draft pending review and desktop validation. The GNU/Linux
server experiment does not measure desktop, musl, macOS/Windows, real signing,
notarization, bundle names or updater download/signature end-to-end behavior.
The unchanged version source contract and archive exclusions do not prove those
release paths.

Prior aggregate verification is explicitly partial:

- Focused nextest: **1738 passed / 4 failed / 35 skipped**, 1742 executed. All four
  failures were reproduced on base `4bc4d0e4` and head `a3a42856`, with identical
  errors after normalizing PIDs: case-only rename, repository ancestor detection,
  and two process-tree tests. No regression difference was observed for those
  four cases; this is not a full-suite pass.

  | Exact test                                                              | Matching base/head failure                                            |
  | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
  | `ide-agent worktree::tests::accept_applies_a_case_only_rename`          | Both A.txt and a.txt remained; expected A.txt only                    |
  | `ide-core ignored::tests::finds_the_repository_at_or_above_a_directory` | `assertion failed: !inside_git_repo(&sub)`; empty sandbox `/tmp/.git` |
  | `ide-core process::tests::kill_tree_of_reaches_what_the_child_started`  | Grandchild PID survived; observed PPID 1 / STAT Z                     |
  | `ide-core process::kill_tests::kill_tree_kills_what_the_child_started`  | Process PID survived; observed PPID 1 / STAT Z                        |

- Two `ide-vcs` Clippy diagnostics also matched base/head. Full workspace Clippy
  did not pass. Full workspace nextest stopped before testing when the old
  Cloud environment's 32GB disk filled.
- The previous Tauri dev build succeeded, but the app stopped because the
  standard `WebKitNetworkProcess` path was missing. Real About/current version
  and terminal `TERM_PROGRAM_VERSION` remain unverified. The replacement Cloud
  environment also lacks the standard WebKit helper, Rust toolchain and the
  scoped system package installer/sudo. No root-system modification, sandbox
  disabling, binary patching or unsupported WebKit relocation was attempted.

The minimum desktop follow-up is to provision a normal supported Tauri/WebKit
environment, build this branch, and follow `.agents/skills/verify/SKILL.md` to
check the actual app version and terminal metadata through Tauri MCP. A browser
page or server `--version` is not that runtime check.

Before adoption, review version entrypoints, fail-closed invalidation, archive
boundaries and the controlled timing including transfer overhead. Retain
main-only dispatch, immutable resolved-tag checkout, draft ownership, four
platforms, Thin LTO and merge-based fork history. A future main merge requires
separate approval; no merge/auto-merge is performed by this experiment.

[PR caches live under refs/pull/.../merge](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).
They cannot seed main. Verification namespaces also differ from production.
After a separately approved merge, the first separately authorized new Release
must seed production caches for each scope/target/image. Follow
[the existing release procedure](README.md): prepare a new unused app version,
push main, push its new immutable tag, then dispatch from main with that tag.
Do not retry or modify the existing v2026.2.12 Release to seed caches. Image
updates, source/config changes, eviction and unverifiable inputs can cause
future cold builds. Main, tags and Releases remain untouched by this work.
