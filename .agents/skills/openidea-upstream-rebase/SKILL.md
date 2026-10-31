---
name: openidea-upstream-rebase
description: Rebase the OpenIDEA Jujutsu fork onto a user-selected upstream release tag, resolve conflicts, and review upstream version-control features for possible jj adaptation. Use for OpenIDEA upstream release imports.
---

# Rebase the OpenIDEA fork onto an upstream release

Use this skill in the OpenIDEA fork. Follow the repository's `AGENTS.md` and the Jujutsu skill for working-copy and history operations.

## 1. Identify the release and fork stack

- Use the upstream version the user supplied, such as `v0.1.37`. Ask for the version if it is missing.
- Open the matching official release note from [OpenIDEA releases](https://github.com/l0ng-ai/openidea/releases). Read the **Version control** section and check linked changes where the summary is insufficient.
- Inspect `jj status`, `jj log -r 'fork-start::'`, `jj bookmark list`, and `jj git remote list`. Confirm that `fork-start` points to the fork configuration change and record the descendants it will carry. The import covers that entire local tree, including any branches under it. Record the existing fork release tag targets before rebasing.
- Verify that `upstream` points to `https://github.com/l0ng-ai/openidea.git`. Fetch the requested tag and resolve its target from that remote. Record the commit ID and resolve any missing tag or mismatch with the official release before rebasing.

Example for `v0.1.37`:

```sh
rtk jj git fetch --remote upstream --tag v0.1.37
rtk jj log -r 'v0.1.37@upstream' --no-graph -T 'commit_id ++ "\n"'
```

The historical workflow used `--tag '*'` to fetch all upstream tags. Use a single tag when the user specifies one version.

## 2. Rebase the fork tree and resolve conflicts

Rebase `fork-start` and all its descendants onto the verified upstream release tag. Keep the existing `fork-start` bookmark as the fork's root for subsequent imports. Some local descendants may be protected because they are reachable from existing release tags. This repository's import workflow uses `--ignore-immutable` for this specific operation.

```sh
rtk jj rebase -s fork-start -o 'v0.1.37@upstream' --ignore-immutable
```

Substitute the requested, verified tag. Check that the new parent of `fork-start` is the target commit, that the descendant structure and bookmarks followed the rebase, and that existing fork release tags still point to their original commits. Rebase and resolve locally. Pushing updated bookmarks or tags requires a separate request.

- Work from the earliest conflicted change forward. Use `jj resolve --list -r <revision>`. Inspect the original fork patch, the upstream change, and the conflicting result. Attribute inherited conflicts to the change where they first appear.
- Preserve upstream and fork behavior at their existing boundaries. Where Git and jj have separate code, take the upstream Git changes and retain the jj entry points. A registration or translation that can keep both sides takes less judgment than a conflict in behavior. Resolve source manifests and IPC definitions before regenerating affected lockfiles or bindings using the repository's normal commands.
- Check the entire rebased range for unresolved conflicts and review the resolution diffs.
- Run focused checks for behavior that had to be reconciled during conflict resolution, such as repository selection, action routing, or an IPC or dependency change that affects the integrated result. Use the smallest existing test or smoke check that exercises the reconciled behavior.
- Skip tests for low-risk resolutions when diff inspection shows behavior is preserved, such as formatting or independent translation additions. Upstream and the fork have already been tested. The release import alone does not call for a full suite.
- Report the tag and commit, resulting stack, material resolution decisions, checks run, and any checks skipped or gaps. Describe effort in terms of the decisions and checks required. Report elapsed resolution time only if measured.

## 3. Review what to bring to jj

After the rebase and conflict resolution, compare the release's VCS changes with the resulting fork. Check existing jj behavior, the upstream implementation, and the jj command or data model on which a candidate would rely. Distinguish:

- **Inherited as-is**: The rebase already brought in the change.
- **Candidate for jj**: The behavior has a useful jj equivalent. Explain what to adapt, what can be shared safely, and which upstream files would be affected.
- **Already covered** or **out of scope**: The fork already supports it, or the behavior has no useful equivalent under this jj workflow.

Present the candidates and their uncertainties to the user. Wait for approval before adapting any of them. Approval of the rebase does not approve feature adaptation. Implement only the approved candidates, following the user's change boundaries, and verify the results.

For an example, read [v0.1.37 VCS triage](references/v0.1.37-vcs-triage.md).
