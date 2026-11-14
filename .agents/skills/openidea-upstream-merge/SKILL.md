---
name: openidea-upstream-merge
description: Merge an official upstream OpenIDEA release into the Jujutsu fork, evaluate Git changes for jj, implement applicable adaptations, test, and create a new fork release tag. Use for current and future upstream release imports.
---

# Merge upstream releases into the fork

Follow AGENTS.md. Preserve published history. The fork uses merge-based imports;
never rebase the fork stack, move existing release tags, or force-update main.
The former openidea-upstream-rebase procedure is superseded.

## Establish the inputs

- Inspect the working tree, local branches/bookmarks, remotes, and fork release tags.
  Preserve unrelated work in its existing worktree.
- Confirm origin is s-matsubara/openidea and upstream is l0ng-ai/openidea.
- Set repository Git `user.email` and jj `user.email` to
  `17187820+s-matsubara@users.noreply.github.com` before creating commits.
  Ensure both Git author and committer emails use this address; environment
  overrides must not introduce a personal email. Keep email privacy protection
  enabled, and inspect all new fork commits before pushing.
- Fetch and verify the requested official release tag. When asked for the latest,
  resolve the latest non-draft, non-prerelease release from GitHub; compare its
  release page and remote tag commit. Do not merge unreleased upstream main.
- Identify the fork tip containing all existing jj work. Do not assume main is
  current: compare ancestry with the latest vYYYY.x.x tag. If branch and release
  histories diverge, investigate before selecting the base.
- Record the fork tip, upstream commit, and all existing fork tag targets.
  If upstream is already an ancestor of the fork, report no new import needed.

## Merge without rewriting history

- Create a task branch/worktree from the confirmed fork tip.
- Merge the upstream release using `git merge --no-ff --no-commit <upstream-tag>`.
  A jj equivalent must create a new revision with both original commits as parents;
  it must not rebase or rewrite either parent.
- Keep the fork's removed workflows absent: Language smoke, Plugin index, and
  CNB mirror. Do not restore their workflow files or the Release CNB mirror call
  when importing upstream changes. Local smoke commands remain available.
- Preserve the Release Linux arm64 Thin LTO override. Fat LTO exhausted the
  standard runner's RAM and swap; the isolated Thin LTO build completed successfully.
- Resolve conflicts by preserving the fork's jj support, identity, and dependency
  changes alongside upstream behavior. Review auto-merged shared code as well.
- Regenerate lockfiles and IPC bindings with normal repository commands after
  resolving their source manifests/types; never hand-edit generated bindings.
- Make a merge commit whose parents are the original fork tip and upstream tag.
  Verify both are ancestors and existing tags are unchanged.

## Adapt and verify

Read the release's Version control notes and implementation changes. Classify
changes as inherited, useful jj adaptations, already covered, or Git-specific.
Use jj semantics for bookmarks, workspaces, snapshots, and change/commit IDs.
Implement useful adaptations when requested; ask only for unresolved product
choices or scope beyond the request. An import-only request does not itself
request new feature implementations.

Upstream releases are already tested. For a conflict-free import, a brief smoke
check or no additional tests is sufficient; state what was checked or skipped.
For conflicts, run lightweight checks focused on the resolved behavior. An import
alone does not require the full upstream suite, full workspace clippy, or a full
application build. Test new jj implementations in proportion to their changes.
Regenerate bindings only when affected source types/commands require it. Report
failed or unavailable checks and remaining uncertainty accurately; do not call an
untested build verified. Expand verification only when a failure or unresolved
risk warrants it.

## Version and handoff

- Fork tags use vYYYY.x.x. Inspect established version history; choose an unused,
  increasing version consistent with that history and explain the choice.
- Preserve omitted versions in the root workspace and internal `crates/*`
  manifests (Cargo defaults to `0.0.0`) and the explicit application version in
  `src-tauri/Cargo.toml`. Do not restore `version.workspace` in upstream-added
  crates. Run `python3 scripts/verify-release-cache.py policy` after imports.
  Preserve runtime public-version initialization and the content-verified cache
  policy (`docs/releases/build-cache.md`). Audit new upstream public uses of
  `CARGO_PKG_VERSION` so they do not expose the uninitialized library fallback `0.0.0`.
- Use `pnpm release:prepare <version>` to align manifests, Cargo.lock, and the
  released plugin API snapshot. Commit the version change and create the requested
  new tag on the final commit. Never retarget an existing tag.
- Verify ancestry, clean state, tag target, and synchronized manifest versions.
- Report the upstream release, fork base, merge/final commits, adapted features,
  verification results, tag, and remote state.
- Push or publish only when explicitly authorized; importing and creating a local
  tag do not authorize a remote release. Never force-push main or existing tags.
- When release execution is authorized, push main first, then the new tag, then
  dispatch `release.yml` from `main` with the explicit tag input. Tag push must
  not trigger Release automatically. Preserve the fork's dispatch validation,
  resolved-tag commit checkout and per-run draft ownership on upstream imports.
  Follow `docs/releases/README.md`; never redispatch an existing release tag or
  adopt another run's draft. Resume failures through the original run instead.
