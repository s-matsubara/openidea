/** Jujutsu history and its selected change details. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileLineStats, FileStatus, JjHistoryCommit, JjHistoryPage } from "@/bindings";
import { useGitLogChecks } from "@/workbench/contributions";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  SearchField,
  Tree,
  fileIconName,
  T,
  showContextMenu,
} from "@/ui";
import { compactLanes, computeGraph, straightenLaneChanges } from "./graph";
import { JjGraphCell } from "./JjGraphCell";
import { effectiveKind, fileCount, formatTime, KIND_COLOR } from "./model";
import { refreshNow, useVcs } from "./store";
import styles from "./GitLog.module.css";
import jjStyles from "./JjLog.module.css";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import { openDiff } from "./diffInput";
import { jjFileDiffData } from "./jjDiffInput";
import { setLogOptions, useLogOptions } from "./logOptions";
import { LineStats } from "./LogLineStats";
import { jjLogMenu } from "./jjLogActions";
import { tx } from "@/platform/i18n";

export function JjLog() {
  useEffect(() => {
    setContext("vcsJjHistory", true);
    return () => setContext("vcsJjHistory", false);
  }, []);
  const roots = useVcs((s) => s.jjRoots);
  const project = useVcs((s) => s.root);
  const version = useVcs((s) => s.version);
  const activeRoot = useVcs((s) => s.repo);
  const root = roots.find((r) => r.root === activeRoot) ?? roots[0];
  const [query, setQuery] = useState("");
  // Key both workspace and repository; remounting synchronously drops old rows/selection.
  return (
    <div className={jjStyles.root}>
      {root ? (
        <History
          key={`${project}\0${root.root}\0${version}\0${root.unavailableReason}`}
          query={query}
          setQuery={setQuery}
          root={root.root}
          unavailable={root.unavailableReason}
        />
      ) : (
        <EmptyState>No Jujutsu repositories</EmptyState>
      )}
    </div>
  );
}

function History({
  root,
  unavailable,
  query,
  setQuery,
}: {
  root: string;
  unavailable: string | null;
  query: string;
  setQuery: (query: string) => void;
}) {
  const ChecksCell = useGitLogChecks((s) => s.cell);
  const showChecks = useLogOptions((s) => s.showGitHubChecks);
  const [page, setPage] = useState<JjHistoryPage>({ commits: [], next: null });
  const [selected, select] = useState<string | null>(null);
  const [loading, setLoading] = useState(!unavailable);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const currentQuery = useRef(query);
  useEffect(() => {
    currentQuery.current = query;
  }, [query]);
  const pending = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const readFirst = useCallback(
    (request: number) => {
      void call(commands.vcsJjHistory(root, null))
        .then((next) => {
          if (request !== generation.current) return;
          setPage(next);
          select(next.commits[0]?.id ?? null);
        })
        .catch((e) => request === generation.current && setError(String(e)))
        .finally(() => {
          if (request === generation.current) {
            pending.current = false;
            setLoading(false);
          }
        });
    },
    [root],
  );
  const reload = () => {
    const request = ++generation.current;
    setPage({ commits: [], next: null });
    select(null);
    setError(null);
    if (unavailable) return;
    pending.current = true;
    setLoading(true);
    readFirst(request);
  };
  useEffect(() => {
    if (unavailable) return;
    const request = ++generation.current;
    const requests = generation;
    pending.current = true;
    readFirst(request);
    return () => {
      requests.current++;
    };
  }, [readFirst, unavailable]);
  const more = useCallback(() => {
    if (!page.next || pending.current) return;
    const request = generation.current;
    pending.current = true;
    setLoading(true);
    setError(null);
    void call(commands.vcsJjHistory(root, page.next))
      .then((next) => {
        if (request !== generation.current) return;
        setPage((before) => ({ commits: [...before.commits, ...next.commits], next: next.next }));
      })
      .catch((e) => request === generation.current && setError(String(e)))
      .finally(() => {
        if (request === generation.current) {
          pending.current = false;
          setLoading(false);
        }
      });
  }, [page.next, root]);
  const needle = query.trim().toLocaleLowerCase();
  // Search the entire pinned operation, rather than silently limiting matches to loaded rows.
  // One page at a time; clearing the query stops further reads and in-flight pages remain valid.
  useEffect(() => {
    if (!needle || !page.next || loading || error || unavailable) return;
    const timer = setTimeout(more, 180);
    return () => clearTimeout(timer);
  }, [needle, page.next, loading, error, unavailable, more]);
  const visible = useMemo(
    () =>
      page.commits.filter(
        (c) => !needle || [c.description, c.id, c.changeId].some((value) => value.toLocaleLowerCase().includes(needle)),
      ),
    [page.commits, needle],
  );
  const visibleSelected = visible.some((c) => c.id === selected) ? selected : (visible[0]?.id ?? null);
  const graph = useMemo(() => {
    const commits = visible.map((c) => ({
      ...c,
      refs: [...c.localBookmarks, ...c.remoteBookmarks, ...c.tags],
    }));
    return straightenLaneChanges(compactLanes(computeGraph(commits).rows));
  }, [visible]);
  const commit = visible.find((c) => c.id === visibleSelected);
  return (
    <div className={jjStyles.root}>
      {(error || unavailable) && (
        <div className={styles.message} role="alert">
          {error ?? unavailable}
        </div>
      )}
      <SplitGroup orientation="horizontal" id="jj-log">
        <SplitPanel id="history" defaultSize="60%" minSize="120px">
          <div className={jjStyles.root}>
            <div className={styles.filters} role="toolbar" aria-label={tx("Log filters")}>
              <SearchField
                className={styles.textFilter}
                value={query}
                onChange={(value) => {
                  currentQuery.current = value;
                  setQuery(value);
                }}
                placeholder="Text or hash"
                aria-label="Filter by message"
              />
              {needle && !error && !unavailable && (loading || page.next) && (
                <span role="status">
                  <T>Searching history…</T>
                </span>
              )}
              {loading && <Spinner size={12} />}
              <span className={styles.grow} />
              {ChecksCell && (
                <IconButton
                  icon="success"
                  title="GitHub Commit Checks"
                  size="small"
                  pressed={showChecks}
                  onClick={() => setLogOptions({ showGitHubChecks: !showChecks })}
                />
              )}
              <IconButton
                icon="refresh"
                title="Refresh Jujutsu history"
                size="small"
                onClick={unavailable ? () => void refreshNow() : reload}
              />
            </div>

            <div
              className={jjStyles.list}
              ref={list}
              role="listbox"
              aria-label="Jujutsu history"
              tabIndex={0}
              aria-activedescendant={visibleSelected ? `jj-${visibleSelected}` : undefined}
              onKeyDown={(e) => {
                const index = visible.findIndex((c) => c.id === visibleSelected);
                const next =
                  e.key === "ArrowDown"
                    ? Math.min(index + 1, visible.length - 1)
                    : e.key === "ArrowUp"
                      ? Math.max(0, index - 1)
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? visible.length - 1
                          : -1;
                const c = visible[next];
                if (c) {
                  e.preventDefault();
                  select(c.id);
                  document.getElementById(`jj-${c.id}`)?.scrollIntoView?.({ block: "nearest" });
                }
              }}
            >
              {visible.map((c, i) => (
                <div
                  key={c.id}
                  id={`jj-${c.id}`}
                  role="option"
                  aria-selected={c.id === visibleSelected}
                  className={`${jjStyles.row} ${c.id === visibleSelected ? jjStyles.selected : ""}`}
                  onClick={() => {
                    select(c.id);
                    list.current?.focus();
                  }}
                  onContextMenu={(e) => {
                    select(c.id);
                    const request = generation.current;
                    showContextMenu(
                      e,
                      jjLogMenu(
                        root,
                        c,
                        () => request === generation.current && query === currentQuery.current,
                        reload,
                      ),
                    );
                  }}
                  title={c.description}
                >
                  <span className={styles.colSubject}>
                    <JjGraphCell row={graph[i]!} head={c.workingCopy} />
                    <span className={jjStyles.subject}>
                      {c.workingCopy ? "@ " : ""}
                      {c.description.split("\n")[0] || "(no description)"}
                    </span>
                    <JjRefs commit={c} />
                  </span>
                  {showChecks && ChecksCell && <ChecksCell root={root} revision={c.id} />}
                  <span className={`${styles.colAuthor} ${styles.muted}`} title={`${c.author} <${c.email}>`}>
                    {c.author}
                  </span>
                  <span className={`${styles.colDate} ${styles.muted}`}>{formatTime(Number(c.timeMs))}</span>
                </div>
              ))}
              {!loading && !error && !visible.length && !page.next && (
                <EmptyState>{needle ? <T>No matches</T> : <T>No history</T>}</EmptyState>
              )}
            </div>
            {page.next && !needle && (
              <button type="button" disabled={loading} onClick={more}>
                Load more
              </button>
            )}
          </div>
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="details" minSize="120px">
          {commit ? (
            <SplitGroup orientation="vertical" id="jj-log-details">
              <SplitPanel id="files" defaultSize="60%" minSize="60px">
                <HistoryFiles key={commit.id} root={root} commit={commit.id} />
              </SplitPanel>
              <SplitHandle />
              <SplitPanel id="message" minSize="60px">
                <HistoryDetails commit={commit} />
              </SplitPanel>
            </SplitGroup>
          ) : (
            <EmptyState>Select a change to view details</EmptyState>
          )}
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

/** Scoped to one immutable commit: unmount invalidates lists, previews and in-flight opens. */
function HistoryFiles({ root, commit }: { root: string; commit: string }) {
  const [files, setFiles] = useState<FileStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const alive = useRef(false);
  const opening = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const preview = useLogOptions((s) => s.diffPreview);
  const showLineStats = useLogOptions((s) => s.showLineStats);
  const [lineStats, setLineStats] = useState<{ byPath: Map<string, FileLineStats> } | { error: string } | null>(null);
  useEffect(() => {
    if (!showLineStats) return;
    let current = true;
    void call(commands.vcsJjHistoryLineStats(root, commit))
      .then((stats) => current && setLineStats({ byPath: new Map(stats.map((f) => [f.path, f])) }))
      .catch((e) => current && setLineStats({ error: String(e) }));
    return () => {
      current = false;
    };
  }, [root, commit, showLineStats]);
  const statsByPath = showLineStats && lineStats && "byPath" in lineStats ? lineStats.byPath : undefined;
  const totals = useMemo(() => {
    if (!files?.length || !statsByPath) return null;
    let added = 0;
    let removed = 0;
    for (const file of files) {
      const stat = statsByPath.get(file.relPath);
      if (!stat) return null;
      added += stat.added;
      removed += stat.removed;
    }
    return { added, removed };
  }, [files, statsByPath]);
  useEffect(() => {
    alive.current = true;
    let current = true;
    const requests = opening;
    const previews = timer;
    void call(commands.vcsJjHistoryFiles(root, commit))
      .then((next) => current && setFiles(next))
      .catch((e) => current && setError(String(e)));
    return () => {
      current = false;
      alive.current = false;
      requests.current++;
      clearTimeout(previews.current);
    };
  }, [root, commit]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      opening.current++;
    },
    [preview],
  );
  const tree = useMemo(() => buildFileTree(files ?? [], (f) => f.relPath), [files]);
  const dirs = useMemo(() => dirKeys(tree), [tree]);
  const open = (file: FileStatus, isPreview = false) => {
    clearTimeout(timer.current);
    const request = ++opening.current;
    setError(null);
    void call(commands.vcsJjHistoryFileDiff(root, file.path, commit))
      .then((pair) => {
        if (alive.current && request === opening.current)
          return openDiff(jjFileDiffData(file.path, pair), { preview: isPreview, focus: !isPreview });
      })
      .catch((e) => alive.current && request === opening.current && setError(`${file.relPath}: ${String(e)}`));
  };
  const select = (keys: ReadonlySet<string>) => {
    setSelected(keys);
    clearTimeout(timer.current);
    opening.current++;
    if (!preview || keys.size !== 1) return;
    const file = files?.find((f) => keys.has(`f:${f.relPath}`));
    if (file) timer.current = setTimeout(() => open(file, true), 120);
  };
  const chosen = files?.find((f) => selected.has(`f:${f.relPath}`));
  return (
    <div className={styles.filesPane}>
      <div className={styles.detailsBar} role="toolbar" aria-label={tx("Changed files")}>
        <IconButton
          icon="diff"
          title="Show Diff"
          size="small"
          disabled={!chosen}
          onClick={() => chosen && open(chosen)}
        />
        <IconButton
          icon="eye"
          title="View Options"
          size="small"
          aria-haspopup="menu"
          onClick={(e) => {
            const { left, bottom } = e.currentTarget.getBoundingClientRect();
            showContextMenu({ x: left, y: bottom + 2 }, [
              {
                label: "Show lines added and deleted",
                checked: showLineStats,
                run: () => setLogOptions({ showLineStats: !showLineStats }),
              },
            ]);
          }}
        />
        <span className={styles.detailsCount}>{files ? fileCount(files.length) : ""}</span>
        {totals && <LineStats {...totals} />}
        <span className={styles.grow} />
        <IconButton
          icon="expand-all"
          title="Expand All"
          size="small"
          disabled={!dirs.length}
          onClick={() => setExpanded(new Set(dirs))}
        />
        <IconButton
          icon="collapse-all"
          title="Collapse All"
          size="small"
          disabled={!dirs.length}
          onClick={() => setExpanded(new Set())}
        />
      </div>
      {error && (
        <div className={styles.message} role="alert">
          {error}
        </div>
      )}
      {showLineStats && lineStats && "error" in lineStats && (
        <div className={styles.message} role="status" title={lineStats.error}>
          <T>Line statistics unavailable</T>
        </div>
      )}
      {!files && !error && (
        <div className={styles.message}>
          <Spinner size={12} />
        </div>
      )}
      {files?.length === 0 && (
        <EmptyState>
          <T>No changes</T>
        </EmptyState>
      )}
      {files && files.length > 0 && (
        <Tree<FileTreeNode<FileStatus>>
          roots={tree}
          getKey={(n) => n.key}
          getLabel={(n) => n.name}
          getChildren={(n) => (n.file ? undefined : n.children)}
          isExpandable={(n) => !n.file}
          expanded={expanded ?? new Set(dirs)}
          onExpandedChange={setExpanded}
          selected={selected}
          onSelectionChange={select}
          onActivate={(n) => n.file && open(n.file)}
          aria-label="Changed files"
          className={styles.fileTree}
          renderNode={(n) => {
            const stat = n.file && statsByPath?.get(n.file.relPath);
            return (
              <span
                className={styles.fileRow}
                title={n.file?.renamedFrom ? `${n.file.renamedFrom} → ${n.file.relPath}` : n.file?.relPath}
              >
                <Icon name={n.file ? fileIconName(n.name) : "folder"} size={16} className={styles.fileIcon} />
                <span
                  className={styles.fileName}
                  style={n.file ? { color: KIND_COLOR[effectiveKind(n.file) ?? "modified"] } : undefined}
                >
                  {n.name}
                </span>
                {!n.file && <span className={styles.fileDir}>{fileCount(n.count)}</span>}
                {stat && <LineStats added={stat.added} removed={stat.removed} />}
              </span>
            );
          }}
        />
      )}
    </div>
  );
}

/** Keep jj bookmark identity explicit; Git's slash-prefixed ref parser is not applicable. */
function JjRefs({ commit: c }: { commit: JjHistoryCommit }) {
  const groups = new Map<string, string[]>();
  const remaining = [...c.remoteBookmarks];
  for (const local of c.localBookmarks) {
    const remotes = remaining.filter((ref) => ref.startsWith(`${local}@`));
    groups.set(local, remotes);
    for (const ref of remotes) remaining.splice(remaining.indexOf(ref), 1);
  }
  return (
    <span className={styles.refs}>
      {[...groups].map(([local, remotes]) => (
        <span
          key={`local:${local}`}
          className={`${styles.ref} ${styles.refLocal}`}
          title={`${tx("Local bookmarks")}: ${local}${remotes.length ? `; ${tx("Remote bookmarks")}: ${remotes.join(", ")}` : ""}`}
        >
          {remotes.length ? `${remotes.map((ref) => ref.slice(local.length + 1)).join(", ")} & ${local}` : local}
        </span>
      ))}
      {remaining.map((ref) => (
        <span
          key={`remote:${ref}`}
          className={`${styles.ref} ${styles.refRemote}`}
          title={`${tx("Remote bookmarks")}: ${ref}`}
        >
          {ref}
        </span>
      ))}
      {c.tags.map((tag) => (
        <span key={`tag:${tag}`} className={`${styles.ref} ${styles.refTag}`} title={`${tx("Tags")}: ${tag}`}>
          {tag}
        </span>
      ))}
    </span>
  );
}

function HistoryDetails({ commit: c }: { commit: JjHistoryCommit }) {
  return (
    <div className={jjStyles.details} aria-label="Jujutsu change details">
      <div className={styles.subjectLine}>{c.description.split("\n")[0] || tx("(no description)")}</div>
      {c.description.includes("\n") && (
        <div className={styles.fullMessage}>
          {c.description.slice(c.description.indexOf("\n") + 1).replace(/^\n+/, "")}
        </div>
      )}
      <div className={styles.meta}>
        <button
          type="button"
          className={`${styles.linkButton} ${styles.hash}`}
          aria-label={tx("Copy Change ID")}
          title={`${tx("Copy Change ID")}\nChange ID: ${c.changeId}\nCommit ID: ${c.id}`}
          onClick={() => void navigator.clipboard?.writeText(c.changeId)}
        >
          {c.changeId.slice(0, 8)}
        </button>{" "}
        {c.author} &lt;{c.email}&gt;
        {c.timeMs ? " " + tx`on ${new Date(Number(c.timeMs)).toLocaleString()}` : ""}
        {c.workingCopy && <span title={tx("Current working copy")}> @</span>}
      </div>
      {c.parents.length > 1 && (
        <div className={styles.meta} title={c.parents.join("\n")}>
          {tx`Merge of ${c.parents.map((p) => p.slice(0, 8)).join(", ")}`}
        </div>
      )}
      {(c.localBookmarks.length > 0 || c.remoteBookmarks.length > 0 || c.tags.length > 0) && (
        <div className={styles.meta}>
          <JjRefs commit={c} />
        </div>
      )}
    </div>
  );
}
