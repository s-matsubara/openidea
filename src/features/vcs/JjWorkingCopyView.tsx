import { editorService } from "@/workbench/contributions";
import type { ChangeKind, FileStatus, VcsRoot } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { macStroke, normalizeBinding, strokeOf } from "@/platform/keymap";
import { copyChangedFiles } from "./changeCopy";
import { useProject } from "@/platform/project";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  T,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import clsx from "clsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckMark } from "./ChangeTreeCheck";
import { buildChangeTree, type ChangeNode } from "./changes";
import styles from "./CommitView.module.css";
import { CommitCheckProblems, runJjCommitChecks, type CommitCheckRun } from "./commitChecks";
import { CommitMessageHistory } from "./CommitMessageHistory";
import { CommitOptionsButton } from "./CommitOptions";
import { messageHistory, rememberMessage, savedDraft, writeDraft, useCommit } from "./commitStore";
import { openMergeEditor } from "./conflictsUi";
import { DiffEditor } from "./DiffEditor";
import { diffInput } from "./diffInput";
import { confirmDialog } from "./dialogs";
import { jjDiffChangeCurrent, jjWorkingDiffData, openJjChangeDiff } from "./jjDiffInput";
import { useJjCommitMessageTarget } from "./jjCommitMessage";
import jjStyles from "./JjWorkingCopyView.module.css";
import { KIND_COLOR, KIND_LABEL, effectiveKind, fileCount } from "./model";
import { errorMessage, runOp } from "./ops";
import { refreshNow, repoName, useVcs } from "./store";

type ReadyRoot = VcsRoot & { workingCopy: NonNullable<VcsRoot["workingCopy"]> };

const ALL_CHANGES_KEY = "jj:all-changes";

const CHANGE_COUNTS = [
  ["added", (count: number) => tx`${count} added`],
  ["modified", (count: number) => tx`${count} modified`],
  ["deleted", (count: number) => tx`${count} deleted`],
  ["renamed", (count: number) => tx`${count} renamed`],
  ["conflicted", (count: number) => tx`${count} conflicted`],
] as const;

function ready(root: VcsRoot): root is ReadyRoot {
  return !!root.workingCopy && !root.unavailableReason;
}

/** Working-copy changes without Git action menus or staging semantics. */
export function JjWorkingCopyView() {
  const roots = useVcs((s) => s.jjRoots);
  const agentButton = useWorkflowSettings((s) => s.vcs.commit.agentButton);
  const gitRootCount = useVcs((s) => s.roots.length);
  const error = useVcs((s) => s.error);
  const trusted = useProject((s) => s.project?.trusted !== false);
  const project = useVcs((s) => s.root);
  const [description, setDescription] = useState(() => (project ? savedDraft(project, "jj") : ""));
  const draft = useRef(description);
  useLayoutEffect(() => {
    draft.current = description;
  }, [description]);
  useEffect(() => {
    if (!project) return;
    const timer = setTimeout(() => writeDraft(project, description, "jj"), 500);
    return () => clearTimeout(timer);
  }, [project, description]);
  useEffect(() => {
    if (!project) return;
    const flush = () => writeDraft(project, draft.current, "jj");
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [project]);
  const descriptionField = useRef<HTMLTextAreaElement>(null);
  const historyScope = { vcs: "jj", project } as const;
  const [diffError, setDiffError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Array<{ root: string; error?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [groupByDir, setJjGroupByDir] = useState(true);
  const [intents, setIntents] = useState(new Map<string, { change: string; paths: Set<string> }>());
  const owners = useMemo(() => {
    const byPath = new Map<string, ReadyRoot>();
    for (const root of roots.filter(ready)) for (const file of root.workingCopy.files) byPath.set(file.path, root);
    return byPath;
  }, [roots]);
  const checked = new Set<string>();
  for (const [path, root] of owners) {
    const intent = intents.get(root.root);
    if (intent?.change === root.workingCopy.changeId && intent.paths.has(path)) checked.add(path);
  }
  const byRoot = roots.filter(ready).flatMap((root) => {
    const files = root.workingCopy.files.filter((f) => checked.has(f.path));
    return files.length ? [{ root, files }] : [];
  });
  const targets = byRoot.map(({ root, files }) => ({
    root: root.root,
    commit: root.workingCopy.commitId,
    paths: files.map((file) => file.path),
  }));
  useJjCommitMessageTarget(project, description, targets, running, setDescription);
  const { analyzeCode, checkTodo } = useWorkflowSettings((state) => state.vcs.commit);
  const checkKey = JSON.stringify([project, description, targets, analyzeCode, checkTodo]);
  const [checkedResult, setCheckedResult] = useState<{ key: string; result: CommitCheckRun } | null>(null);
  const commitChecks = checkedResult?.key === checkKey ? checkedResult.result : null;
  const summary = byRoot
    .map(({ root, files }) => {
      const repo = repoName(root.root);
      const count = files.length;
      return tx`${repo} (${count} selected)`;
    })
    .join(" · ");
  const counts = new Map<ChangeKind, number>();
  for (const { files } of byRoot) {
    for (const { unstaged } of files) {
      if (unstaged) counts.set(unstaged, (counts.get(unstaged) ?? 0) + 1);
    }
  }
  const changeCounts = CHANGE_COUNTS.flatMap(([kind, label]) => {
    const count = counts.get(kind);
    return count ? [{ kind, label: label(count) }] : [];
  });
  const toggleFiles = (files: readonly FileStatus[]) => {
    if (running.current || !files.length) return;
    const remove = files.every((file) => checked.has(file.path));
    setIntents((old) => {
      const next = new Map(old);
      const updated = new Map<string, Set<string>>();
      for (const file of files) {
        const root = owners.get(file.path);
        if (!root) continue;
        const intent = next.get(root.root);
        const change = root.workingCopy.changeId;
        const paths = updated.get(root.root) ?? new Set(intent?.change === change ? intent.paths : []);
        updated.set(root.root, paths);
        if (remove) paths.delete(file.path);
        else paths.add(file.path);
        next.set(root.root, { change, paths });
      }
      return next;
    });
  };
  const current = (root: VcsRoot) => useVcs.getState().jjRoots.includes(root);
  const runChecked = async (operation: "commit" | "rollback") => {
    if (running.current || !trusted || !byRoot.length || (operation === "commit" && !description.trim())) return;
    running.current = true;
    setBusy(true);
    try {
      if (
        operation === "rollback" &&
        !(await confirmDialog({
          title: "Rollback",
          okLabel: "Rollback",
          danger: true,
          message: `${summary}\n\n${tx`Restore ${checked.size} checked file(s) from the parent of @? Added files will be removed and deleted files restored. Unsaved documents must be saved first.`}`,
        }))
      )
        return;
      if (operation === "commit" && !commitChecks?.blocked && (analyzeCode || checkTodo)) {
        const files = new Map<string, string>();
        for (const { root, files: included } of byRoot) {
          for (const file of included) {
            if (file.unstaged !== "deleted") files.set(file.path, root.workingCopy.commitId);
          }
        }
        const result = await runJjCommitChecks(files, project ?? "");
        if (result.blocked) {
          setCheckedResult({ key: checkKey, result });
          return;
        }
      }
      setCheckedResult(null);
      setOutcomes([]);
      const results: typeof outcomes = [];
      await runOp(
        operation === "commit" ? "jj commit" : "Jujutsu rollback",
        async () => {
          try {
            for (const { root, files } of byRoot) {
              let error: string | undefined;
              const live = useVcs.getState().jjRoots.find((candidate) => candidate.root === root.root);
              if (
                !live ||
                !ready(live) ||
                live.workingCopy.commitId !== root.workingCopy.commitId ||
                useProject.getState().project?.trusted === false
              ) {
                error = tx("Working copy changed; review the checked files and try again");
              } else {
                try {
                  const commit = root.workingCopy.commitId;
                  const paths = files.map((file) => file.path);
                  await call(
                    operation === "commit"
                      ? commands.vcsJjCommitFiles(root.root, commit, paths, description)
                      : commands.vcsJjRestoreFiles(root.root, commit, paths),
                  );
                } catch (cause) {
                  error = errorMessage(cause);
                }
              }
              if (!error) {
                setIntents((old) => {
                  const next = new Map(old);
                  next.delete(root.root);
                  return next;
                });
              }
              if (operation === "commit" || error) results.push({ root: root.root, error });
            }
          } finally {
            await refreshNow();
          }
        },
        { refresh: false },
      );
      if (operation === "commit") {
        if (results.some((result) => !result.error)) rememberMessage(description, historyScope);
        if (results.every((result) => !result.error)) setDescription("");
      }
      setOutcomes(results);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const preview = useCommit((s) => s.commitDiffPreview);
  const nodes = useMemo((): ChangeNode[] => {
    const withRootKey = (node: ChangeNode, root: string): ChangeNode => ({
      ...node,
      key: JSON.stringify([root, node.key]),
      children: node.children?.map((child) => withRootKey(child, root)),
    });
    const available = roots.filter(ready);
    const children = available.flatMap((root): ChangeNode[] => {
      const children = buildChangeTree(root.workingCopy.files, root.root, groupByDir)
        .flatMap((node) => (node.group === "changes" ? (node.children ?? []) : [node]))
        .map((node) => withRootKey(node, root.root));
      if (roots.length + gitRootCount === 1) return children;
      return [
        {
          key: JSON.stringify([root.root]),
          type: "group",
          group: "changes",
          label: repoName(root.root),
          path: root.root,
          files: root.workingCopy.files,
          detail: fileCount(root.workingCopy.files.length),
          children,
        },
      ];
    });
    const files = available.flatMap((root) => root.workingCopy.files);
    return files.length > 0
      ? [
          {
            key: ALL_CHANGES_KEY,
            type: "group",
            group: "changes",
            label: tx("Changes"),
            files,
            children,
            detail: fileCount(files.length),
          },
        ]
      : children;
  }, [roots, gitRootCount, groupByDir]);
  const groups: string[] = [];
  const walk = (ns: ChangeNode[]) =>
    ns.forEach((n) => {
      if (n.children?.length) {
        groups.push(n.key);
        walk(n.children);
      }
    });
  walk(nodes);
  const expanded = new Set(groups.filter((k) => !collapsed.has(k)));
  const selectedFile = (ns: readonly ChangeNode[]): FileStatus | undefined => {
    for (const n of ns) {
      if (n.type === "file" && selected.has(n.key)) return n.files[0];
      const child = n.children && selectedFile(n.children);
      if (child) return child;
    }
  };
  const file = preview && selected.size === 1 ? selectedFile(nodes) : undefined;
  const previewCommit = file && owners.get(file.path)?.workingCopy.commitId;
  const opening = useRef(0);
  useEffect(
    () => () => {
      opening.current++;
    },
    [],
  );
  const open = async (file: FileStatus) => {
    const root = owners.get(file.path);
    if (!root) return;
    const copy = root.workingCopy;
    const change = { kind: "working" as const, root: root.root, commit: copy.commitId, project, files: copy.files };
    const request = ++opening.current;
    const live = () => request === opening.current && jjDiffChangeCurrent(change);
    if (!live()) return;
    setDiffError(null);
    try {
      const pair = await call(commands.vcsJjFileDiff(file.path, copy.commitId));
      const data = jjWorkingDiffData(file.path, pair, effectiveKind(file) === "deleted");
      await openJjChangeDiff({ ...data, ...(copy.files.length > 1 ? { jjChange: change } : {}) }, { current: live });
    } catch (error) {
      if (live()) setDiffError(`${file.relPath}: ${String(error)}`);
    }
  };
  const changes = (
    <>
      <div className={styles.toolbar} role="toolbar" aria-label="Working-copy changes">
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshNow()} />
        <IconButton
          icon="undo"
          title="Rollback checked files…"
          size="small"
          disabled={busy || !trusted || !checked.size}
          onClick={() => void runChecked("rollback")}
        />
        <IconButton
          icon="editor-preview"
          title="Preview Diff"
          size="small"
          pressed={preview}
          onClick={() => void executeAction("vcs.jjToggleDiffPreview")}
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
      {error && <div role="alert">{error}</div>}
      {diffError && <div role="alert">{diffError}</div>}
      {roots
        .filter((root) => !ready(root))
        .map((root) => (
          <section key={root.root} aria-label={root.root}>
            <div className={styles.toolbar}>{repoName(root.root)}</div>
            <div role="alert">{root.unavailableReason ?? tx("Working-copy status unavailable")}</div>
          </section>
        ))}
      <div
        className={jjStyles.jjFiles}
        onKeyDownCapture={(e) => {
          if (!selected.size) return;
          const stroke = strokeOf(e.nativeEvent);
          const binding = stroke && normalizeBinding(macStroke(stroke));
          const copyKind = binding === "Meta+C" ? "name" : binding === "Shift+Meta+C" ? "absolute" : null;
          if (!copyKind && (e.key !== " " || e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          e.stopPropagation();
          const files: FileStatus[] = [];
          const collect = (ns: ChangeNode[]) =>
            ns.forEach((n) => {
              if (selected.has(n.key)) files.push(...n.files);
              else if (n.children) collect(n.children);
            });
          collect(nodes);
          if (copyKind) {
            copyChangedFiles(files, copyKind);
            return;
          }
          toggleFiles(files);
        }}
      >
        <Tree<ChangeNode>
          roots={nodes}
          getKey={(n) => n.key}
          getLabel={(n) => n.label}
          getChildren={(n) => n.children}
          isExpandable={(n) => !!n.children?.length}
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
          onJumpToSource={(n) => {
            const file = n.type === "file" ? n.files[0] : null;
            if (file && effectiveKind(file) !== "deleted") void editorService().openFile(file.path, { focus: true });
          }}
          onContextMenu={(node, selection, e) => {
            const file = node?.type === "file" ? node.files[0] : undefined;
            const files: FileStatus[] = [];
            const collect = (ns: ChangeNode[]) =>
              ns.forEach((n) => {
                if (selection.has(n.key)) files.push(...n.files);
                else if (n.children) collect(n.children);
              });
            collect(nodes);
            const targets = [...new Map(files.map((f) => [f.path, f])).values()];
            if (!targets.length) return;
            const items: MenuItem[] = file
              ? [
                  {
                    label: "Show Diff",
                    run: () => void open(file),
                  },
                  { kind: "separator" },
                ]
              : [];
            if (targets.some((f) => effectiveKind(f) === "conflicted"))
              items.push({
                label: "Resolve Conflicts…",
                run: () => {
                  if (useProject.getState().project?.trusted === false) return;
                  for (const f of targets) {
                    const root = owners.get(f.path);
                    if (root && current(root) && effectiveKind(f) === "conflicted") openMergeEditor(f.path, "jj");
                  }
                },
              });
            if (targets.some((f) => effectiveKind(f) === "conflicted")) items.push({ kind: "separator" });
            items.push(
              { label: "Copy Path", icon: "copy", run: () => copyChangedFiles(targets, "absolute") },
              { label: "Copy File Name", icon: "copy", run: () => copyChangedFiles(targets, "name") },
            );
            showContextMenu(e, items);
          }}
          aria-label="Working-copy changes"
          empty={
            roots.some(ready) ? (
              <span className={styles.empty}>
                <T>No working-copy changes</T>
              </span>
            ) : undefined
          }
          onActivate={(n) => {
            const f = n.type === "file" ? n.files[0] : undefined;
            if (!f) return;
            void open(f);
          }}
          renderNode={(n, state) => {
            const count = n.files.filter((f) => checked.has(f.path)).length;
            return (
              <span className={styles.nodeRow}>
                {n.files.length > 0 && (
                  <CheckMark
                    checked={count === n.files.length}
                    indeterminate={count > 0 && count < n.files.length}
                    label={n.key === ALL_CHANGES_KEY ? tx("Select All") : tx`Select ${n.label} for commit`}
                    onToggle={() => toggleFiles(n.files)}
                  />
                )}
                {n.type !== "group" && (
                  <Icon
                    name={n.type === "dir" ? (state.expanded ? "folder-open" : "folder") : fileIconName(n.label)}
                    size={16}
                  />
                )}
                <span
                  className={clsx(jjStyles.jjPath, n.key === ALL_CHANGES_KEY && styles.groupLabel)}
                  style={{ color: n.kind ? KIND_COLOR[n.kind] : undefined }}
                  title={n.kind ? tx(KIND_LABEL[n.kind]) : n.path}
                  aria-label={n.kind ? `${n.label}: ${tx(KIND_LABEL[n.kind])}` : undefined}
                >
                  {n.label}
                </span>
                {n.type === "group" && n.detail && <span className={jjStyles.jjSummary}>{n.detail}</span>}
              </span>
            );
          }}
        />
      </div>
    </>
  );
  const list = preview ? (
    <SplitGroup orientation="horizontal" className={styles.split}>
      <SplitPanel defaultSize="62%" minSize="20%">
        <div className={jjStyles.jjList}>{changes}</div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel defaultSize="38%" minSize="120px">
        {file && previewCommit ? (
          <JjDiffPreview key={JSON.stringify([previewCommit, file.path])} file={file} commit={previewCommit} />
        ) : (
          <EmptyState>
            <T>{owners.size ? "Select a file to preview its changes" : "No changes to preview"}</T>
          </EmptyState>
        )}
      </SplitPanel>
    </SplitGroup>
  ) : (
    <div className={jjStyles.jjList}>{changes}</div>
  );
  const repoCount = byRoot.length;
  const label = commitChecks?.blocked
    ? tx("Commit Anyway")
    : repoCount > 1
      ? tx`Commit to ${repoCount} repositories`
      : tx("Commit");
  return (
    <div className={jjStyles.jjCopies} aria-label="Jujutsu working copies">
      <SplitGroup orientation="vertical" className={styles.split}>
        <SplitPanel id="jj-changes" minSize="60px" defaultSize="70%">
          {list}
        </SplitPanel>
        <SplitHandle aria-label={tx("Description")} />
        <SplitPanel id="jj-description" defaultSize="30%" minSize="120px">
          <div className={jjStyles.jjDescription}>
            <div
              className={clsx(styles.commitBar, jjStyles.jjDescriptionBar)}
              role="group"
              aria-label={tx("Description")}
            >
              <CommitMessageHistory
                key={project}
                messages={messageHistory(historyScope)}
                disabled={busy || !trusted}
                onSelect={(message) => {
                  setDescription(message);
                  descriptionField.current?.focus();
                }}
              />
              {agentButton && (
                <IconButton
                  icon="toolwindow-agents"
                  action="agents.generateCommitMessage"
                  actionArg="jj"
                  title="Generate Commit Message with Agent"
                  size="small"
                  disabled={busy || !trusted || !byRoot.length}
                />
              )}
              {changeCounts.length > 0 && (
                <span
                  className={jjStyles.jjChangeCounts}
                  title={[changeCounts.map(({ label }) => label).join(" · "), summary].join("\n")}
                >
                  {changeCounts.map(({ kind, label }) => (
                    <span key={kind} style={{ color: KIND_COLOR[kind] }}>
                      {label}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <textarea
              ref={descriptionField}
              className={clsx(styles.message, styles.noMargin)}
              aria-label={tx("Description")}
              placeholder={tx("Description")}
              value={description}
              disabled={busy || !trusted}
              spellCheck
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void runChecked("commit");
                }
              }}
            />
            <CommitCheckProblems problems={commitChecks?.problems ?? []} />
            <div className={styles.commitActions}>
              <Button
                variant="primary"
                disabled={busy || !trusted || !byRoot.length || !description.trim()}
                onClick={() => void runChecked("commit")}
              >
                {label}
              </Button>
              <span className={styles.grow} />
              <CommitOptionsButton vcs="jj" />
            </div>
          </div>
        </SplitPanel>
      </SplitGroup>
      {outcomes.length > 0 && (
        <div className={jjStyles.jjOutcomes} aria-live="polite">
          {outcomes.map(({ root, error }) => (
            <div key={root} role={error ? "alert" : undefined}>
              <strong title={root}>{repoName(root)}</strong>
              {" · "}
              {error ?? tx("Committed")}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JjDiffPreview({ file, commit }: { file: FileStatus; commit: string }) {
  const [result, setResult] = useState<{ input: ReturnType<typeof diffInput> } | { error: string } | null>(null);
  const { path, relPath } = file;
  const deleted = effectiveKind(file) === "deleted";
  useEffect(() => {
    let active = true;
    void call(commands.vcsJjFileDiff(path, commit))
      .then((pair) => {
        if (active) setResult({ input: diffInput(jjWorkingDiffData(path, pair, deleted)) });
      })
      .catch((error: unknown) => {
        if (active) setResult({ error: `${relPath}: ${String(error)}` });
      });
    return () => {
      active = false;
    };
  }, [path, relPath, commit, deleted]);
  if (!result)
    return (
      <EmptyState>
        <Spinner size={14} />
      </EmptyState>
    );
  if ("error" in result) return <div role="alert">{result.error}</div>;
  return <DiffEditor input={result.input} />;
}
