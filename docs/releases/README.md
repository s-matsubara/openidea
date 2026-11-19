# Fork release operation

Use the personal repository `s-matsubara/openidea`. After merging and verifying
changes, prepare the next unused `vYYYY.x.x` version with `pnpm release:prepare`,
commit it using the fork's noreply identity, and follow this order:

1. Normally push the final commit to `main` and verify the remote commit.
2. Create and push a new tag on that commit. Never move an existing tag. Create
   tags from the updated main containing the dispatch-only workflow: historical
   commits still contain their historical tag-push workflow.
3. Explicitly dispatch the workflow on `main`, passing the newly pushed tag:

   ```sh
   tag='vYYYY.x.x' # Replace with the new, unused release tag.
   gh workflow run release.yml --repo s-matsubara/openidea --ref main -f tag="$tag"
   gh run list --repo s-matsubara/openidea --workflow release.yml --event workflow_dispatch --limit 5
   ```

Confirm the run's `head_branch` is `main`, its input is the intended tag, and
`create-release` resolves that tag to the expected release commit. The workflow
definition comes from main; every build checks out the resolved tag commit SHA,
not main's source. No Release starts merely by pushing main or a new tag.

The workflow rejects other refs/repositories, malformed/missing tags, commits
outside main's history, and inconsistent app versions. It serializes runs for a
tag without cancelling the active run. A hidden draft-body marker binds the
release to its run ID and target commit. Only that same run can resume its draft;
a separate dispatch cannot reuse an existing draft or published release. Every
upload/manifest/publish job checks ownership, draft state and the unchanged tag
before proceeding. Do not edit the marker or manually publish an active draft.

For a transient failure, inspect the original run and use
`gh run rerun <run-id> --repo s-matsubara/openidea --failed` only when authorized.
Do not dispatch the tag again. Once published, even a single upload/publish job's
rerun is rejected before it changes assets. Re-runs retain their original
[workflow ref and SHA](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs),
so this main change does not repair old tag-triggered runs or adopt their drafts.
Historical refs also keep their historical dispatch definitions: always dispatch
with `--ref main`, never an old tag or branch.
If a released source needs a fix, make a new version/tag rather than modifying
the existing release.

The desktop release ships macOS arm64 and Linux amd64. The SSH server ships
macOS and Linux builds for both arm64 and x86_64. The app's official plugin
catalog and packages come from upstream, and release builds pin the public key
recorded in the [upstream plugin index](https://github.com/l0ng-ai/openidea/releases/download/v0.1.49/plugins-index.json).

The macOS build saves the Developer ID-signed app and DMG as workflow artifacts.
The notarization job uses `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` to
submit both bundles and staple their tickets. It then signs the updater archive
made from the stapled app when updater signing is configured. If notarization
fails, rerun failed jobs in the same workflow run while the build artifact is
available. The notarization job downloads it again and reuses the successful
build. Publication waits for notarization, the required builds and the updater
manifest. Check both desktop platforms, all four server checksums, updater
signatures and `latest.json` after publication.

Validation without creating tags or releases:
`node --test scripts/release-workflow.test.mjs` runs the actual inline guards with
mocked GitHub responses, the manifest-version check on temporary files, and the
notarization retry path with mocked Apple and GitHub commands.
Workflow guard steps share a [YAML anchor](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#yaml-anchors-and-aliases).

## Build version and cache policy

`src-tauri/Cargo.toml` carries the application version. Omit `version` from
`[workspace.package]` and every internal `crates/*/Cargo.toml` package; Cargo
reports their versions as `0.0.0`. Do not add `version.workspace` on imports.
Run `python3 scripts/verify-release-cache.py policy` to check all current and
new internal crates against Cargo metadata. SDK, plugins and fixtures retain
their separate version policies. Internal libraries receive the public version
at runtime; uninitialized library users get `0.0.0`. See [build cache design and verification](build-cache.md)
for immutable cache generations, source-mtime safety, limitations and experiments.
