/** Jujutsu source selection on the shared Git Push screen. */
import { activeEditor } from "@/editor/api";
import { useEffect, useRef, useState } from "react";
import type { JjPushOptions, JjPushPreview } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Select, T } from "@/ui";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { errorMessage } from "./ops";
import { PushCommitDetails } from "./PushChanges";
import { PushCommitList, PushDialogFrame } from "./pushDialog";
import { refreshNow, repoName, useVcs } from "./store";
import styles from "./common.module.css";

export function JjPushDialog({ onClose }: { onClose: () => void }) {
  const roots = useVcs((s) => s.jjRoots);
  const project = useVcs((s) => s.root);
  const [root, setRoot] = useState(() => {
    const path = activeEditor()?.ctx.path;
    return (
      roots
        .filter((r) => path && (path === r.root || path.startsWith(`${r.root}/`)))
        .sort((a, b) => b.root.length - a.root.length)[0]?.root ??
      roots[0]?.root ??
      ""
    );
  });
  if (!roots.some((r) => r.root === root))
    return (
      <PushDialogFrame
        open
        title="Push"
        onClose={onClose}
        header={<T>Repository unavailable. Reopen Push.</T>}
        buttons={[{ label: "Cancel", role: "cancel" }]}
      />
    );
  return (
    <PushForm
      key={`${project}\0${root}`}
      root={root}
      onClose={onClose}
      repositorySelector={
        roots.length > 1 ? (
          <Select
            aria-label={tx("Jujutsu repository")}
            value={root}
            options={roots.map((r) => ({ value: r.root, label: repoName(r.root) }))}
            onChange={setRoot}
          />
        ) : null
      }
    />
  );
}

function PushForm({
  root,
  onClose,
  repositorySelector,
}: {
  root: string;
  onClose: () => void;
  repositorySelector: React.ReactNode;
}) {
  const [options, setOptions] = useState<JjPushOptions | null>(null);
  const [bookmark, setBookmark] = useState("");
  const [pushTags, setPushTags] = useState(false);
  const [tag, setTag] = useState("all");
  const [remote, setRemote] = useState("");
  const [preview, setPreview] = useState<{ selection: string; value: JjPushPreview } | null>(null);
  const [error, setError] = useState<{ selection: string | null; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<{ review: JjPushPreview; index: number } | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  const live = useRef(true);
  const allTags = pushTags && tag === "all";
  const tags = pushTags && tag.startsWith("tag:") ? [tag.slice(4)] : [];
  const bookmarks = bookmark ? [bookmark] : [];
  const selection = JSON.stringify({ bookmarks, tags, allTags, remote });
  const selected = !!remote && (bookmarks.length > 0 || tags.length > 0 || allTags) && (!pushTags || !!tag);
  const review = preview?.selection === selection ? preview.value : null;
  useEffect(() => {
    live.current = true;
    const counter = generation;
    call(commands.vcsJjPushOptions(root))
      .then((result) => {
        if (!live.current) return;
        setOptions(result);
        setRemote(result.remotes.includes("origin") ? "origin" : (result.remotes[0] ?? ""));
      })
      .catch((e) => {
        if (live.current) setError({ selection: null, message: errorMessage(e) });
      });
    return () => {
      live.current = false;
      counter.current++;
    };
  }, [root]);
  useEffect(() => {
    const request = ++generation.current;
    if (!selected) return;
    let alive = true;
    const { bookmarks, tags, allTags, remote } = JSON.parse(selection) as {
      bookmarks: string[];
      tags: string[];
      allTags: boolean;
      remote: string;
    };
    call(commands.vcsJjPush(root, { bookmarks, tags, allTags, remote, review: null }))
      .then((value) => {
        if (alive && live.current && request === generation.current) {
          setPreview({ selection, value });
        }
      })
      .catch((e) => {
        if (alive && live.current && request === generation.current) setError({ selection, message: errorMessage(e) });
      });
    return () => {
      alive = false;
    };
  }, [root, selection, selected, previewVersion]);
  const run = async () => {
    if (!live.current || lock.current || !review || !selected) return;
    if (useVcs.getState().remoteBusy) {
      setError({ selection, message: tx("Another remote operation is in progress") });
      return;
    }
    lock.current = true;
    setBusy(true);
    useVcs.setState({ remoteBusy: "Push" });
    try {
      const result = await call(commands.vcsJjPush(root, { bookmarks, tags, allTags, remote, review: review.token }));
      if (!live.current) return;
      notifications().notify({
        group: "vcs",
        level: "info",
        title: "Push",
        body: result.summary.trim() || tx("Push completed"),
      });
      onClose();
      await refreshNow();
    } catch (e) {
      if (live.current) {
        setError({ selection, message: errorMessage(e) });
        setPreview(null);
        setPreviewVersion((v) => v + 1);
      }
    } finally {
      lock.current = false;
      useVcs.setState({ remoteBusy: null });
      if (live.current) setBusy(false);
    }
  };
  const commits =
    review?.commits.map((c) => ({
      id: c.id,
      shortId: c.id.slice(0, 8),
      summary: c.description.split("\n")[0] ?? "",
      message: c.description,
      author: c.author,
      email: c.email,
      timeMs: Number(c.timeMs),
    })) ?? null;
  const activeIndex = active && active.review === review ? active.index : 0;
  const activeCommit = commits?.[activeIndex];
  return (
    <PushDialogFrame
      open
      maxHeight={720}
      className={styles.pushDialog}
      title="Push"
      onClose={onClose}
      header={
        <>
          {repositorySelector}
          <Select
            aria-label={tx("Bookmark to push")}
            value={bookmark}
            disabled={busy}
            options={[
              { value: "", label: tx("No bookmark") },
              ...(options?.bookmarks ?? []).map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => {
              setPreview(null);
              setBookmark(value);
            }}
          />
          <span> → </span>
          {options?.remotes.length === 1 ? (
            <span>{remote}</span>
          ) : (
            <Select
              aria-label={tx("Remote")}
              value={remote}
              disabled={busy}
              options={(options?.remotes ?? []).map((value) => ({ value, label: value }))}
              onChange={(value) => {
                setPreview(null);
                setRemote(value);
              }}
            />
          )}
        </>
      }
      footerStart={
        <>
          <Checkbox
            checked={pushTags}
            disabled={busy}
            onChange={(value) => {
              setPreview(null);
              setPushTags(value);
            }}
            label="Push tags:"
          />
          <Select
            aria-label={tx("Tags to push")}
            value={tag}
            disabled={busy || !pushTags}
            options={[
              { value: "all", label: tx("All") },
              ...(options?.tags ?? []).map((value) => ({ value: `tag:${value}`, label: value })),
            ]}
            onChange={(value) => {
              setPreview(null);
              setTag(value);
            }}
          />
        </>
      }
      buttons={[
        {
          label: "Push",
          role: "default",
          autoFocus: true,
          disabled: busy || !review || !selected,
          onClick: () => void run(),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      {review && (
        <div className={styles.section}>
          <pre className={styles.pushRefSummary} aria-label={tx("Outgoing references")}>
            {review.summary}
          </pre>
        </div>
      )}
      <div className={styles.section}>
        <span className={styles.hint}>
          <T>Selected reference history (up to 100 commits)</T>
        </span>
      </div>
      <PushCommitList
        commits={!selected ? [] : commits}
        error={error && (error.selection === null || error.selection === selection) ? error.message : null}
        emptyText={selected ? tx("No commits") : tx("Select a bookmark or tag to push")}
        label="Selected reference history"
        activeIndex={activeIndex}
        onActiveChange={(index) => review && setActive({ review, index })}
      />
      {activeCommit && <PushCommitDetails commit={activeCommit} />}
    </PushDialogFrame>
  );
}
