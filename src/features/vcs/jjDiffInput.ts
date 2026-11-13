import type { JjFileDiff } from "@/bindings";
import type { DiffData } from "./diffInput";

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
  return deleted
    ? data
    : { ...data, right: { type: "worktree", label: "Working copy @", jjBlame: pair.afterBlame ?? null } };
}
