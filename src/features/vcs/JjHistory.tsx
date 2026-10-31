/** Jujutsu history in the existing log window; Git operation state is never selected. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileStatus, JjHistoryCommit, JjHistoryPage } from "@/bindings";
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
  Tree,
  fileIconName,
  T,
  showContextMenu,
} from "@/ui";
import { computeGraph } from "./graph";
import { GraphCell } from "./GitLog";
import { effectiveKind, fileCount, formatTime, KIND_COLOR } from "./model";
import { refreshNow, repoName, useVcs } from "./store";
import styles from "./GitLog.module.css";
import jjStyles from "./JjHistory.module.css";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import { jjFileDiffData, openDiff } from "./diffInput";
import { useLogOptions } from "./logOptions";
import { jjLogMenu } from "./jjLogActions";
import { tx } from "@/platform/i18n";

export function JjHistory() {
  useEffect(() => {
    setContext("vcsJjHistory", true);
    return () => setContext("vcsJjHistory", false);
  }, []);
  const roots = useVcs((s) => s.jjRoots);
  const project = useVcs((s) => s.root);
  const version = useVcs((s) => s.version);
  const [requestedRoot, setRoot] = useState<string | null>(null);
  const root = roots.find((r) => r.root === requestedRoot) ?? roots[0];
  // Key both workspace and repository; remounting synchronously drops old rows/selection.
  return (
    <div className={jjStyles.root}>
      <div className={styles.detailsBar}>
        <label className={jjStyles.rootLabel}>
          Repository
          <select aria-label="Jujutsu repository" value={root?.root ?? ""} onChange={(e) => setRoot(e.target.value)}>
            {roots.map((r) => (
              <option key={r.root} value={r.root}>
                {repoName(r.root)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {root ? (
        <History
          key={`${project}\0${root.root}\0${version}\0${root.unavailableReason}`}
          root={root.root}
          unavailable={root.unavailableReason}
        />
      ) : (
        <EmptyState>No Jujutsu repositories</EmptyState>
      )}
    </div>
  );
}

function History({ root, unavailable }: { root: string; unavailable: string | null }) {
  const [page, setPage] = useState<JjHistoryPage>({ commits: [], next: null });
  const [selected, select] = useState<string | null>(null);
  const [loading, setLoading] = useState(!unavailable);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
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
  const more = () => {
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
  };
  const graph = useMemo(() => computeGraph(page.commits).rows, [page.commits]);
  const commit = page.commits.find((c) => c.id === selected);
  return (
    <div className={jjStyles.root}>
      <div className={styles.detailsBar}>
        <IconButton
          icon="refresh"
          title="Refresh Jujutsu history"
          size="small"
          onClick={unavailable ? () => void refreshNow() : reload}
        />
        <span>Jujutsu history</span>
        {loading && <Spinner size={12} />}
      </div>
      {(error || unavailable) && (
        <div className={styles.message} role="alert">
          {error ?? unavailable}
        </div>
      )}
      <SplitGroup orientation="horizontal" id="jj-log">
        <SplitPanel id="history" defaultSize="60%" minSize="120px">
          <div className={jjStyles.root}>
            <div
              className={jjStyles.list}
              ref={list}
              role="listbox"
              aria-label="Jujutsu history"
              tabIndex={0}
              aria-activedescendant={selected ? `jj-${selected}` : undefined}
              onKeyDown={(e) => {
                const index = page.commits.findIndex((c) => c.id === selected);
                const next =
                  e.key === "ArrowDown"
                    ? Math.min(index + 1, page.commits.length - 1)
                    : e.key === "ArrowUp"
                      ? Math.max(0, index - 1)
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? page.commits.length - 1
                          : -1;
                const c = page.commits[next];
                if (c) {
                  e.preventDefault();
                  select(c.id);
                  document.getElementById(`jj-${c.id}`)?.scrollIntoView?.({ block: "nearest" });
                }
              }}
            >
              {page.commits.map((c, i) => (
                <div
                  key={c.id}
                  id={`jj-${c.id}`}
                  role="option"
                  aria-selected={c.id === selected}
                  className={`${jjStyles.row} ${c.id === selected ? jjStyles.selected : ""}`}
                  onClick={() => {
                    select(c.id);
                    list.current?.focus();
                  }}
                  onContextMenu={(e) => {
                    select(c.id);
                    const request = generation.current;
                    showContextMenu(
                      e,
                      jjLogMenu(root, c, () => request === generation.current, reload),
                    );
                  }}
                  title={c.description}
                >
                  <GraphCell row={graph[i]!} head={c.workingCopy} />
                  <span className={jjStyles.subject}>
                    {c.workingCopy ? "@ " : ""}
                    {c.description.split("\n")[0] || "(no description)"}
                  </span>
                  <span className={jjStyles.bookmarks}>{[...c.localBookmarks, ...c.remoteBookmarks].join(", ")}</span>
                  <span className={jjStyles.change}>{c.changeId.slice(0, 8)}</span>
                  <span className={styles.muted}>{c.author}</span>
                  <span className={styles.muted}>{formatTime(Number(c.timeMs))}</span>
                </div>
              ))}
              {!loading && !error && !page.commits.length && <EmptyState>No history</EmptyState>}
            </div>
            {page.next && (
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
        <span className={styles.detailsCount}>{files ? fileCount(files.length) : ""}</span>
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
          renderNode={(n) => (
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
            </span>
          )}
        />
      )}
    </div>
  );
}

function HistoryDetails({ commit: c }: { commit: JjHistoryCommit }) {
  return (
    <div className={jjStyles.details} aria-label="Jujutsu change details">
      {c.workingCopy && <strong>@ Current working copy</strong>}
      <dl>
        <dt>Change ID</dt>
        <dd>{c.changeId}</dd>
        <dt>Commit ID</dt>
        <dd>{c.id}</dd>
        <dt>Author</dt>
        <dd>
          {c.author} &lt;{c.email}&gt; · {new Date(Number(c.timeMs)).toLocaleString()}
        </dd>
        <dt>Parents</dt>
        <dd>{c.parents.length ? c.parents.map((p) => <div key={p}>{p}</div>) : "None (root)"}</dd>
        <dt>Local bookmarks</dt>
        <dd>{c.localBookmarks.join(", ") || "None"}</dd>
        <dt>Remote bookmarks</dt>
        <dd>{c.remoteBookmarks.join(", ") || "None"}</dd>
      </dl>
      <pre className={jjStyles.description}>{c.description || "(no description)"}</pre>
    </div>
  );
}
