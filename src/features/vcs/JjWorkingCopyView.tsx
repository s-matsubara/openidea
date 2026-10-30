import type { FileStatus, JjDescriptionEdit, VcsRoot } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  Button,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import clsx from "clsx";
import { useMemo, useState } from "react";
import { CheckMark } from "./ChangeTreeCheck";
import { buildChangeTree, type ChangeNode } from "./changes";
import styles from "./CommitView.module.css";
import { openMergeEditor } from "./conflictsUi";
import { openDiff } from "./diffInput";
import { confirmDialog } from "./dialogs";
import { jjWorkingDiffData } from "./jjDiffInput";
import jjStyles from "./JjWorkingCopyView.module.css";
import { KIND_COLOR, KIND_LABEL, effectiveKind } from "./model";
import { runOp } from "./ops";
import { refreshNow, repoName, useVcs } from "./store";

/** Working-copy changes without Git action menus or staging semantics. */
export function JjWorkingCopyView() {
  const [drafts, setDrafts] = useState<Record<string, JjDescriptionEdit>>({});
  const [diffError, setDiffError] = useState<string | null>(null);
  const roots = useVcs((s) => s.jjRoots);
  const gitRootCount = useVcs((s) => s.roots.length);
  const error = useVcs((s) => s.error);
  return (
    <div
      className={clsx(jjStyles.jjCopies, roots.length > 1 && jjStyles.jjMultiple)}
      aria-label="Jujutsu working copies"
    >
      {!roots.some((root) => root.workingCopy && !root.unavailableReason) && (
        <div className={styles.toolbar}>
          <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshNow()} />
        </div>
      )}
      {error && <div role="alert">{error}</div>}
      {diffError && <div role="alert">{diffError}</div>}
      {roots.map((root) => (
        <section
          key={root.root}
          aria-label={root.root}
          className={root.workingCopy && !root.unavailableReason ? jjStyles.jjRoot : undefined}
        >
          {roots.length + gitRootCount > 1 && <div className={styles.toolbar}>{repoName(root.root)}</div>}
          {root.unavailableReason ? (
            <div role="alert">{root.unavailableReason}</div>
          ) : root.workingCopy ? (
            <SplitGroup
              orientation="vertical"
              className={styles.split}
              id={`jj-working-copy-${encodeURIComponent(root.root)}`}
            >
              <SplitPanel defaultSize="65%" minSize="60px">
                <JjChangesTree root={root} onError={setDiffError} />
              </SplitPanel>
              <SplitHandle aria-label={tx("Description")} />
              <SplitPanel defaultSize="35%" minSize="120px">
                <JjDescription
                  root={root}
                  draft={drafts[`${root.root}\0${root.workingCopy.changeId}`]}
                  onDraft={(draft) => {
                    const key = `${root.root}\0${root.workingCopy!.changeId}`;
                    setDrafts((old) => {
                      const next = { ...old };
                      if (draft) next[key] = draft;
                      else delete next[key];
                      return next;
                    });
                  }}
                />
              </SplitPanel>
            </SplitGroup>
          ) : (
            <div role="alert">Working-copy status unavailable</div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Drafts belong to a root/change, not to each auto-snapshotted commit version. */
function JjDescription({
  root,
  draft,
  onDraft,
}: {
  root: VcsRoot;
  draft?: JjDescriptionEdit;
  onDraft: (draft: JjDescriptionEdit | null) => void;
}) {
  const copy = root.workingCopy!;
  const trusted = useProject((s) => s.project?.trusted !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edit = draft ?? {
    commit: copy.commitId,
    change: copy.changeId,
    original: copy.description,
    description: copy.description,
  };
  const conflict = !!draft && draft.original !== copy.description;
  const unchanged = edit.description === edit.original;
  const save = async () => {
    const current = useVcs.getState().jjRoots.find((r) => r.root === root.root);
    if (
      busy ||
      unchanged ||
      conflict ||
      !trusted ||
      !current?.workingCopy ||
      current.unavailableReason ||
      current.workingCopy.changeId !== edit.change ||
      current.workingCopy.description !== edit.original ||
      useProject.getState().project?.trusted === false
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await runOp(
        "Jujutsu description",
        async () => {
          try {
            await call(commands.vcsJjDescribe(root.root, edit));
            onDraft(null);
          } finally {
            await refreshNow();
          }
        },
        {
          refresh: false,
          onError: (message) => {
            setError(message);
            return true;
          },
        },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={jjStyles.jjDescription}>
      <label className={styles.commitBar} htmlFor={`jj-description-${root.root}`}>
        <T>Description</T>
      </label>
      <textarea
        id={`jj-description-${root.root}`}
        className={clsx(styles.message, styles.noMargin)}
        aria-label="Description"
        placeholder={tx("Description")}
        value={edit.description}
        disabled={busy || !trusted}
        spellCheck
        onChange={(e) => {
          onDraft({ ...edit, description: e.target.value });
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {conflict && (
        <div role="alert">
          <T>Description changed externally. Your draft is preserved.</T>
        </div>
      )}
      {error && <div role="alert">{error}</div>}
      <div className={styles.commitActions}>
        <Button variant="primary" disabled={busy || !trusted || unchanged || conflict} onClick={() => void save()}>
          <T>Save</T>
        </Button>
        {conflict && (
          <Button
            disabled={busy}
            onClick={() => {
              onDraft(null);
              setError(null);
            }}
          >
            <T>Reload description</T>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Check state is local rollback intent, independent of Git inclusion and row focus. */
function JjChangesTree({ root, onError }: { root: VcsRoot; onError: (message: string | null) => void }) {
  const copy = root.workingCopy!;
  const [groupByDir, setJjGroupByDir] = useState(true);
  const trusted = useProject((s) => s.project?.trusted !== false);
  const [intent, setIntent] = useState({ commit: copy.commitId, paths: new Set<string>() });
  const checked = intent.commit === copy.commitId ? intent.paths : new Set<string>();
  const setChecked = (update: (old: Set<string>) => Set<string>) =>
    setIntent((old) => ({
      commit: copy.commitId,
      paths: update(old.commit === copy.commitId ? old.paths : new Set()),
    }));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const nodes = useMemo(() => buildChangeTree(copy.files, root.root, groupByDir), [copy.files, root.root, groupByDir]);
  const groups: string[] = [];
  const walk = (ns: ChangeNode[]) =>
    ns.forEach((n) => {
      if (n.children) {
        groups.push(n.key);
        walk(n.children);
      }
    });
  walk(nodes);
  const expanded = new Set(groups.filter((k) => !collapsed.has(k)));
  const current = () => useVcs.getState().jjRoots.find((r) => r.root === root.root) === root;
  const rollback = async () => {
    const paths = copy.files.filter((f) => checked.has(f.path)).map((f) => f.path);
    if (!paths.length || busy || !trusted || !current()) return;
    if (
      !(await confirmDialog({
        title: "Rollback",
        okLabel: "Rollback",
        danger: true,
        message: tx`Restore ${paths.length} checked file(s) from the parent of @? Added files will be removed and deleted files restored. Unsaved documents must be saved first.`,
      }))
    )
      return;
    if (!current() || useProject.getState().project?.trusted === false) return;
    setBusy(true);
    try {
      await runOp(
        "Jujutsu rollback",
        async () => {
          try {
            await call(commands.vcsJjRestoreFiles(root.root, copy.commitId, paths));
          } finally {
            await refreshNow();
          }
        },
        { refresh: false },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={styles.toolbar} role="toolbar" aria-label="Working-copy changes">
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshNow()} />
        <IconButton
          icon="undo"
          title="Rollback checked files…"
          size="small"
          disabled={busy || !trusted || !copy.files.some((f) => checked.has(f.path))}
          onClick={() => void rollback()}
        />
        <IconButton icon="eye" title="Group by Directory" size="small" onClick={() => setJjGroupByDir(!groupByDir)} />
        <IconButton icon="expand-all" title="Expand All" size="small" onClick={() => setCollapsed(new Set())} />
        <IconButton
          icon="collapse-all"
          title="Collapse All"
          size="small"
          onClick={() => setCollapsed(new Set(groups))}
        />
      </div>
      <div
        className={jjStyles.jjFiles}
        onKeyDownCapture={(e) => {
          if (e.key !== " " || e.metaKey || e.ctrlKey || !selected.size) return;
          e.preventDefault();
          e.stopPropagation();
          const files: FileStatus[] = [];
          const collect = (ns: ChangeNode[]) =>
            ns.forEach((n) => {
              if (selected.has(n.key)) files.push(...n.files);
              else if (n.children) collect(n.children);
            });
          collect(nodes);
          setChecked((old) => {
            const next = new Set(old);
            const all = files.every((f) => old.has(f.path));
            for (const f of files) {
              if (all) next.delete(f.path);
              else next.add(f.path);
            }
            return next;
          });
        }}
      >
        <Tree<ChangeNode>
          roots={nodes}
          getKey={(n) => n.key}
          getLabel={(n) => n.label}
          getChildren={(n) => n.children}
          isExpandable={(n) => n.type !== "file"}
          expanded={expanded}
          onExpandedChange={(_next, n, open) =>
            setCollapsed((old) => {
              const next = new Set(old);
              if (open) next.delete(n.key);
              else next.add(n.key);
              return next;
            })
          }
          selected={selected}
          onSelectionChange={setSelected}
          onContextMenu={(node, selection, e) => {
            const file = node?.type === "file" ? node.files[0] : undefined;
            if (!file) return;
            const files: FileStatus[] = [];
            const collect = (ns: ChangeNode[]) =>
              ns.forEach((n) => {
                if (selection.has(n.key)) files.push(...n.files);
                else if (n.children) collect(n.children);
              });
            collect(nodes);
            const targets = [...new Map(files.map((f) => [f.path, f])).values()];
            const paths = targets.map((f) => f.path);
            const items: MenuItem[] = [
              {
                label: "Show Diff",
                run: () => {
                  if (!current()) return;
                  void call(commands.vcsJjFileDiff(file.path, copy.commitId))
                    .then((pair) => {
                      if (current())
                        return openDiff(jjWorkingDiffData(file.path, pair, effectiveKind(file) === "deleted"));
                    })
                    .catch((e) => onError(`${file.relPath}: ${String(e)}`));
                },
              },
              { kind: "separator" },
            ];
            if (targets.some((f) => effectiveKind(f) === "conflicted"))
              items.push({
                label: "Resolve Conflicts…",
                run: () => {
                  if (!current() || useProject.getState().project?.trusted === false) return;
                  for (const f of targets) if (effectiveKind(f) === "conflicted") openMergeEditor(f.path, "jj");
                },
              });
            if (targets.some((f) => effectiveKind(f) === "conflicted")) items.push({ kind: "separator" });
            items.push({ label: "Copy Path", run: () => void navigator.clipboard?.writeText(paths.join("\n")) });
            showContextMenu(e, items);
          }}
          aria-label="Working-copy changes"
          empty={<span className={styles.empty}>No working-copy changes</span>}
          onActivate={(n) => {
            const f = n.type === "file" ? n.files[0] : undefined;
            if (!f) return;
            onError(null);
            void call(commands.vcsJjFileDiff(f.path, copy.commitId))
              .then((pair) => {
                if (current()) return openDiff(jjWorkingDiffData(f.path, pair, effectiveKind(f) === "deleted"));
              })
              .catch((e) => onError(`${f.relPath}: ${String(e)}`));
          }}
          renderNode={(n, state) => {
            const count = n.files.filter((f) => checked.has(f.path)).length;
            return (
              <span className={styles.nodeRow}>
                <CheckMark
                  checked={count === n.files.length}
                  indeterminate={count > 0 && count < n.files.length}
                  label={tx`Select ${n.label} for rollback`}
                  onToggle={() =>
                    setChecked((old) => {
                      const next = new Set(old);
                      const all = n.files.every((f) => old.has(f.path));
                      for (const f of n.files) {
                        if (all) next.delete(f.path);
                        else next.add(f.path);
                      }
                      return next;
                    })
                  }
                />
                {n.type !== "group" && (
                  <Icon
                    name={n.type === "dir" ? (state.expanded ? "folder-open" : "folder") : fileIconName(n.label)}
                    size={16}
                  />
                )}
                <span
                  className={jjStyles.jjPath}
                  style={{ color: n.kind ? KIND_COLOR[n.kind] : undefined }}
                  title={n.kind ? tx(KIND_LABEL[n.kind]) : n.path}
                  aria-label={n.kind ? `${n.label}: ${tx(KIND_LABEL[n.kind])}` : undefined}
                >
                  {n.label}
                </span>
              </span>
            );
          }}
        />
      </div>
    </>
  );
}
