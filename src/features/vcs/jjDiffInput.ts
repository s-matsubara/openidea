import type { FileStatus, JjFileDiff } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { allInOneDiff, setAllInOneDiff } from "./allInOneDiff";
import { openDiff, withChain, type DiffData } from "./diffInput";
import { effectiveKind, rootOf } from "./model";
import { refreshNow, useVcs } from "./store";

export interface JjDiffChange {
  kind: "working" | "history";
  project: string | null;
  root: string;
  commit: string;
  files: readonly FileStatus[];
}

function jjRootForPath(path: string, state = useVcs.getState()) {
  const owner = rootOf(path, Object.keys(state.kinds));
  return state.jjRoots.find((root) => root.root === owner);
}

export function jjDiffChangeCurrent(change: JjDiffChange): boolean {
  const state = useVcs.getState();
  const root = state.jjRoots.find((r) => r.root === change.root && !r.unavailableReason);
  return (
    !!root &&
    state.root === change.project &&
    (change.kind === "history" || root.workingCopy?.commitId === change.commit)
  );
}

/** Immutable jj snapshot sides keep the shared editor read-only, including its hunk controls. */
export function jjFileDiffData(path: string, pair: JjFileDiff): DiffData {
  return {
    path,
    left: {
      type: "text",
      text: pair.before,
      label: pair.beforeLabel,
      jjBlame: pair.beforeBlame ?? null,
      ...(pair.beforeAbsent ? { absent: true } : {}),
    },
    right: {
      type: "text",
      text: pair.after,
      label: pair.afterLabel,
      jjBlame: pair.afterBlame ?? null,
      ...(pair.afterAbsent ? { absent: true } : {}),
    },
  };
}

/** Parent snapshot vs the live document; deleted files have no editable document. */
export function jjWorkingDiffData(path: string, pair: JjFileDiff, deleted = false): DiffData {
  const data = jjFileDiffData(path, pair);
  return deleted || pair.afterAbsent
    ? data
    : { ...data, right: { type: "worktree", label: "Working copy @", jjBlame: pair.afterBlame ?? null } };
}

/** The selected editor line is in the live buffer, even when @ has no on-disk change. */
export async function openJjWorkingDiffForLine(path: string, line: number, current: () => boolean): Promise<void> {
  const project = useVcs.getState().root;
  const live = () => current() && useVcs.getState().root === project;
  try {
    await refreshNow();
    if (!live()) return;
    const root = jjRootForPath(path);
    const commit = root?.workingCopy?.commitId;
    if (!root || !commit || root.unavailableReason) {
      notifications().notify({
        group: "vcs",
        level: "error",
        title: "Jujutsu working copy is unavailable",
        body: root?.unavailableReason ?? undefined,
      });
      return;
    }
    const pair = await call(commands.vcsJjFileDiff(path, commit));
    const latest = jjRootForPath(path);
    if (!live() || latest?.root !== root.root || latest.workingCopy?.commitId !== commit) return;
    await openDiff({ ...jjWorkingDiffData(path, pair), line }, { preview: true });
  } catch (error) {
    if (live())
      notifications().notify({
        group: "vcs",
        level: "error",
        title: "Cannot show diff in an editor tab",
        body: String(error),
      });
  }
}

/** Loads only the selected file until an all-files view is requested. */
export async function openJjChangeDiff(
  data: DiffData,
  {
    fromViewer = false,
    current = () => true,
  }: {
    fromViewer?: boolean;
    current?: () => boolean;
  } = {},
): Promise<boolean> {
  const { jjChange, ...selected } = data;
  const live = () => current() && (!jjChange || jjDiffChangeCurrent(jjChange));
  if (!live()) return false;
  if ((!fromViewer && !allInOneDiff()) || !jjChange || jjChange.files.length < 2) {
    await openDiff(data);
    return false;
  }

  // Open the other sides from the same immutable commit. A working-copy
  // snapshot was already verified for the selected file; rereading it for
  // every sibling would contend with other jj operations.
  const items: DiffData[] = [];
  const errors: string[] = [];
  const batchSize = 4;
  for (let i = 0; i < jjChange.files.length; i += batchSize) {
    if (!live()) return false;
    const batch = jjChange.files.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        if (file.path === selected.path) return selected;
        const pair = await call(commands.vcsJjHistoryFileDiff(jjChange.root, file.path, jjChange.commit));
        return jjChange.kind === "working"
          ? jjWorkingDiffData(file.path, pair, effectiveKind(file) === "deleted")
          : jjFileDiffData(file.path, pair);
      }),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") items.push(result.value);
      else errors.push(`${batch[index]!.relPath}: ${String(result.reason)}`);
    }
  }
  if (!live()) return false;
  if (errors.length)
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: "Some Jujutsu diffs could not be opened",
      body: errors.join("\n"),
    });
  const index = items.findIndex((item) => item.path === selected.path);
  if (items.length < 2 || index < 0) {
    if (!fromViewer) await openDiff(data);
    return false;
  }
  if (fromViewer) setAllInOneDiff(true);
  await openDiff(withChain(items, index), { allInOne: true });
  return true;
}
