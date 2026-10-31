/** Jujutsu row actions, deliberately independent of Git selection/operation state. */
import type { JjHistoryCommit, JjLogAction } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService } from "@/workbench/contributions";
import { copyText, type MenuItem } from "@/ui";
import { confirmDialog, promptText } from "./dialogs";
import { runOp } from "./ops";
import { refreshNow } from "./store";

export function validateJjName(name: string): string | null {
  if (!name.trim()) return "Name must not be empty";
  if (name.startsWith("-") || /[\s\p{Cc}]/u.test(name)) return "Invalid Jujutsu reference name";
  return null;
}

export function jjLogMenu(root: string, row: JjHistoryCommit, current: () => boolean, reload: () => void): MenuItem[] {
  const enabled = () => current() && useProject.getState().project?.trusted !== false;
  const run = async (action: JjLogAction) => {
    if (!enabled()) return;
    await runOp(
      "Jujutsu " + action.kind,
      async () => {
        if (action.kind === "new" || action.kind === "edit" || action.kind === "abandon") {
          // Unlike the Git convenience save, failure must abort switching the tree.
          await maybeEditorService()?.saveAll();
        }
        if (!enabled()) return;
        try {
          await call(commands.vcsJjLogAction(root, row.id, row.changeId, action));
        } finally {
          // A failed jj command can still snapshot disk or partially update the tree.
          // A remounted history already loads its own first page; otherwise reload here.
          await refreshNow();
          if (current()) reload();
        }
      },
      { refresh: false },
    );
  };
  const named = async (kind: "bookmark" | "tag") => {
    if (!enabled()) return;
    const result = await promptText({
      title: kind === "bookmark" ? "New Bookmark" : "New Tag",
      label: "Name",
      mono: true,
      okLabel: "Create",
      validate: validateJjName,
    });
    if (result && enabled()) await run({ kind, name: result.value });
  };
  const disabled = !enabled();
  return [
    { label: "Copy Change ID", run: () => void copyText(row.changeId) },
    { label: "Copy Description", run: () => void copyText(row.description) },
    { label: "New Change", disabled, run: () => void run({ kind: "new" }) },
    { label: "Edit Change", disabled, run: () => void run({ kind: "edit" }) },
    {
      label: "Abandon Change…",
      disabled,
      run: () =>
        void (async () => {
          if (!enabled()) return;
          if (
            await confirmDialog({
              title: "Abandon Change",
              okLabel: "Abandon",
              danger: true,
              message: `Remove change ${row.changeId}? Descendants will be rebased onto its parents. The selected change's changes will be removed.`,
            })
          )
            await run({ kind: "abandon" });
        })(),
    },
    { label: "New Bookmark…", disabled, run: () => void named("bookmark") },
    { label: "New Tag…", disabled, run: () => void named("tag") },
  ];
}
