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
- Use `pnpm release:prepare <version>` to align manifests, Cargo.lock, and the
  released plugin API snapshot. Commit the version change and create the requested
  new tag on the final commit. Never retarget an existing tag.
- Verify ancestry, clean state, tag target, and synchronized manifest versions.
- Report the upstream release, fork base, merge/final commits, adapted features,
  verification results, tag, and remote state.
- Push or publish only when explicitly authorized; importing and creating a local
  tag do not authorize a remote release. Never force-push main or existing tags.
