/** Read-only history in the existing log window; Git operation state is never selected. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JjHistoryCommit, JjHistoryPage } from "@/bindings";
import { setContext } from "@/platform/context";
import { call, commands } from "@/platform/ipc";
import { EmptyState, IconButton, SplitGroup, SplitHandle, SplitPanel, Spinner } from "@/ui";
import { computeGraph } from "./graph";
import { GraphCell } from "./GitLog";
import { formatTime } from "./model";
import { refreshNow, repoName, useVcs } from "./store";
import styles from "./GitLog.module.css";
import jjStyles from "./JjHistory.module.css";

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
        <span>Jujutsu history · read-only</span>
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
          {commit ? <HistoryDetails commit={commit} /> : <EmptyState>Select a change to view details</EmptyState>}
        </SplitPanel>
      </SplitGroup>
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
