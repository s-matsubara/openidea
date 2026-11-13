# Release versions and compiled workspace caches

The application release lives in `src-tauri/Cargo.toml`, `package.json` and
`src-tauri/tauri.conf.json`. `release:prepare` updates those and only the
`openidea` version in Cargo.lock. `[workspace.package].version` remains at the
component baseline **2026.2.12**; its 43 internal libraries do not change package
identity on each release. This avoids a needless one-time renumbering, too.
Guest SDK and Plugin API versions remain independently versioned.

Executables initialize `ide_core::version` before services start. The desktop
uses its own package version; the server/plugin binaries embed the version from
tauri.conf.json **in their binary targets**, not in ide-host's library. About,
remote server identity/downloads, CLI output, MCP/LSP/agent client identities and
terminal metadata keep the application release. Persistent syntax, SVG and shell
integration cache salts also retain release-based invalidation. Embedded library
users can initialize their own public version; without it they get the component
baseline. New upstream uses of `CARGO_PKG_VERSION` in public metadata need review.

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
RELEASE_CACHE_REPORT=/tmp/cache-report.json python3 scripts/release-cache.test.py
node --test scripts/release-workflow.test.mjs
pnpm vitest run scripts/release-prepare.test.ts scripts/nightly-prepare.test.ts
```

The Linux x86-64 experiment uses real `cargo build --release` with Thin LTO and
incremental disabled. It simulates fresh checkouts at the same absolute path,
a dependency-only archive plus a separate workspace archive, and runs the built
desktop/server fixtures to verify the new public version. It copies the actual
runtime-version implementation and server initializer from this repository.

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

Actual macOS/Windows or full Linux Release duration, cache transfer size and hosted
cache save/restore have **not** been measured. Linking/bundling/signing still run.
The first new cache generation is cold; source/config changes and unverifiable
inputs can reduce reuse. Archives consume repository cache quota and may be
evicted, so inspect cache hit/size logs on the first authorized future release.
No existing release needs to be retried for this change. It first applies to a
new tag containing these scripts after the PR is merged.

## Hosted PR verification

`verify-release-cache.yml` runs on this draft PR's synchronize/open/reopen events,
including a branch push. It is separate from the metadata-only `PR check`.
Two sequential `ubuntu-24.04` jobs use separate fresh hosted machines and the same
head SHA. They build the real `ide-host/openidea-server` with Thin LTO and
incremental disabled. The warm job uses the real release preparation script to
bump only the app release, checks all four app-version locations and unchanged
component/dependency versions, then checks the server's actual `--version`.
It creates no tag, Release, updater manifest or distribution bundle.

Both cache families use a run/attempt-specific **verification namespace**.
Swatinem uses an explicit shared-key so the cold/warm job IDs do not split the
dependency cache. The workspace action accepts an optional namespace and a
save-only generation (cold/warm); its production defaults are unchanged.
Cold must miss, warm must restore the exact cold workspace generation and an
exact dependency hit, and compatibility prefixes must match after the app bump.
Image/toolchain/profile changes fail the comparison instead of silently passing
a new cold build. Inspect the runner image and toolchain logs when that happens.

The workspace archive is explicitly saved **before** Swatinem's post-job cleanup,
and its input snapshot is removed before that dependency-only save. Warm saves
to its own immutable generation, avoiding the same-run cold key collision.
An exact dependency hit skips Swatinem's save as expected. JSON reports and Cargo
compiler-artifact fresh flags are uploaded as public Actions measurement artifacts;
the action logs show compressed transfer sizes, restore/save keys and durations.
The reports also inventory the exact private archive selection and its byte count.
Final binaries, bundle/signature canaries and the server executable must be absent
before the warm build. The final server must be rebuilt while core, host and at
least five real internal libraries are fresh.

These workflows have `contents: read`, use no signing credentials/secrets, and
never upload executable distribution assets. This public repository's Actions
logs and reports can be public. Signing, notarization, installed desktop GUI,
updater/download end-to-end behavior and real bundle names remain separate,
unverified Release checks; the experiment only checks their unchanged version
source contract and archive boundaries. No GUI smoke is substituted for the
repository's Tauri MCP verification procedure.

[PR caches live under refs/pull/.../merge](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).
They are not promoted to main and cannot seed its Release cache. After merge,
the first separately authorized Release must cold-seed main's production cache.
This experiment must not reuse or cancel an existing Release/diagnostic run.
