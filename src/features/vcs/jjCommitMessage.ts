import { useLayoutEffect, useRef, type RefObject } from "react";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideJjCommitMessageTarget } from "@/workbench/contributions";
import { repoName, useVcs } from "./store";

export interface JjCommitTarget {
  root: string;
  commit: string;
  paths: string[];
}

export function useJjCommitMessageTarget(
  project: string | null,
  description: string,
  targets: readonly JjCommitTarget[],
  busy: RefObject<boolean>,
  setDescription: (message: string) => void,
) {
  const draft = useRef<{ key: string; revision: number; project: string | null; targets: readonly JjCommitTarget[] }>(
    null,
  );
  useLayoutEffect(() => {
    const key = JSON.stringify([project, description, targets]);
    if (draft.current?.key !== key)
      draft.current = { key, revision: (draft.current?.revision ?? 0) + 1, project, targets };
  });
  useLayoutEffect(() => {
    let active = true;
    const current = () => {
      if (!active || busy.current || useProject.getState().project?.trusted === false) return null;
      const currentDraft = draft.current;
      const { root, jjRoots } = useVcs.getState();
      if (!currentDraft || currentDraft.project !== root) return null;
      return currentDraft.targets.every(({ root, commit }) =>
        jjRoots.some((repo) => repo.root === root && !repo.unavailableReason && repo.workingCopy?.commitId === commit),
      )
        ? currentDraft
        : null;
    };
    const dispose = provideJjCommitMessageTarget({
      revision: () => current()?.revision ?? -1,
      async changes() {
        const at = current();
        if (!at) return null;
        const patches = await Promise.all(
          at.targets.map(async ({ root, commit, paths }) => {
            const patch = await call(commands.vcsJjPendingPatch(root, commit, paths));
            return patch.trim() && at.targets.length > 1
              ? `Repository ${JSON.stringify(repoName(root))}\n${patch}`
              : patch;
          }),
        );
        if (current() !== at) return null;
        return { revision: at.revision, roots: at.targets.map(({ root }) => root), patch: patches.join("\n") };
      },
      setMessage(revision, message) {
        if (current()?.revision !== revision) return false;
        setDescription(message);
        return true;
      },
    });
    setContext("vcsJjCommit", true);
    return () => {
      active = false;
      dispose();
      setContext("vcsJjCommit", false);
    };
  }, [busy, setDescription]);
}
