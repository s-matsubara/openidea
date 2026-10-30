/** Merge editor tab input; kept apart from `MergeEditor` so opening one does not load it. */
import type { EditorInput } from "@/workbench/contributions";

export const MERGE_KIND = "merge";

export interface MergeData {
  path: string;
  vcs?: "jj";
}

export function mergeInput(path: string, vcs?: "jj"): EditorInput {
  return {
    kind: MERGE_KIND,
    key: vcs === "jj" ? `merge:jj:${path}` : `merge:${path}`,
    path,
    data: { path, vcs } satisfies MergeData,
  };
}
