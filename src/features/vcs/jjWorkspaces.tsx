/** Jujutsu registrations use workspace names/revisions, never Git branches. */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { JjWorkspace } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { notifications } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { Dialog, IconButton, Input, Select, T } from "@/ui";
import { confirmDialog, openDialog } from "./dialogs";
import { errorMessage } from "./ops";
import { repoName, useVcs } from "./store";
import { defaultWorktreePath } from "./gitMenuDialogs";
import styles from "./common.module.css";

export function JjWorkspacesPanel({ className, listClassName }: { className?: string; listClassName?: string }) {
  const roots = useVcs((s) => s.jjRoots);
  const project = useVcs((s) => s.root);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const root = roots.find((r) => r.root === selectedRoot) ?? roots[0];
  return (
    <div className={className}>
      {roots.length > 1 && (
        <Select
          aria-label="Jujutsu repository"
          value={root?.root ?? null}
          options={roots.map((r) => ({ value: r.root, label: repoName(r.root) }))}
          onChange={setSelectedRoot}
        />
      )}
      {root && <WorkspaceList key={`${project}\0${root.root}`} root={root.root} listClassName={listClassName} />}
    </div>
  );
}

function WorkspaceList({ root, listClassName }: { root: string; listClassName?: string }) {
  const [rows, setRows] = useState<JjWorkspace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const counter = generation;
    return () => {
      live.current = false;
      counter.current++;
    };
  }, []);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const list = await call(commands.vcsJjWorkspaces(root));
      if (live.current && request === generation.current) {
        setRows(list);
        setError(null);
        setSelected((name) => (list.some((w) => w.name === name) ? name : null));
      }
    } catch (e) {
      if (live.current && request === generation.current) setError(errorMessage(e));
    }
  }, [root]);
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [reload]);
  const current = rows.find((w) => w.name === selected);
  const open = async (row: JjWorkspace) => {
    if (busy || !row.path) return;
    setBusy(true);
    try {
      const latest = await call(commands.vcsJjWorkspaces(root));
      if (!live.current) return;
      const target = latest.find((w) => w.name === row.name);
      if (!target || target.path !== row.path || target.commitId !== row.commitId)
        throw new Error(tx("Workspace changed; refresh the list"));
      await executeAction("file.openProjectPath", row.path);
    } catch (e) {
      if (live.current) setError(errorMessage(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (!current || current.current || !current.path || busy) return;
    setBusy(true);
    try {
      const ok = await confirmDialog({
        title: "Remove Workspace",
        message: tx`Remove workspace ${current.name} at ${current.path}? Its folder and all contents are deleted. Jujutsu snapshots the working copy before removal.`,
        okLabel: "Remove",
        danger: true,
      });
      if (!ok || !live.current) return;
      await call(commands.vcsJjRemoveWorkspace(root, current));
      if (live.current) await reload();
    } catch (e) {
      if (live.current) setError(errorMessage(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <>
      <div className={styles.manageBar} role="toolbar" aria-label={tx("Workspaces")}>
        <IconButton icon="refresh" title="Refresh" size="small" disabled={busy} onClick={() => void reload()} />
        <IconButton
          icon="plus"
          title="New Workspace…"
          size="small"
          disabled={busy}
          onClick={() =>
            openDialog((close) => (
              <NewWorkspaceDialog
                root={root}
                onClose={close}
                onCreated={() => {
                  if (live.current) void reload();
                }}
              />
            ))
          }
        />
        <IconButton
          icon="minus"
          title="Remove Workspace"
          size="small"
          disabled={busy || !current || current.current || !current.path}
          onClick={() => void remove()}
        />
        <IconButton
          icon="folder"
          title="Open Workspace…"
          size="small"
          disabled={busy || !current?.path}
          onClick={() => current && void open(current)}
        />
      </div>
      <div className={listClassName ?? styles.choiceList} role="listbox" aria-label={tx("Workspaces")}>
        {rows.map((w) => (
          <button
            key={w.name}
            type="button"
            role="option"
            aria-selected={w.name === selected}
            className={clsx(styles.manageRow, w.name === selected && styles.manageRowSelected)}
            onClick={() => setSelected(w.name)}
            onDoubleClick={() => void open(w)}
          >
            <span className={styles.fileName}>
              {w.name}
              {w.current ? tx(" (current)") : ""}
            </span>
            <span className={clsx(styles.fileDir, styles.mono)}>
              {w.changeId.slice(0, 8)} · {w.path ?? tx("Workspace path unavailable")}
            </span>
          </button>
        ))}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </>
  );
}

export function NewWorkspaceDialog({
  root,
  onClose,
  onCreated,
}: {
  root: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [revision, setRevision] = useState("@");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const suffix = name || "workspace";
  const path = folder ?? (/^\/[^/]+$/.test(root) ? `${root}-${suffix}` : defaultWorktreePath(root, suffix));
  const invalid = !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(name) || !path.trim() || !revision.trim();
  const create = async () => {
    if (busy || invalid) return;
    setBusy(true);
    try {
      await call(commands.vcsJjAddWorkspace(root, name, path.trim(), revision.trim()));
      if (!live.current) return;
      onCreated();
      onClose();
      await executeAction("file.openProjectPath", path.trim()).catch((e: unknown) => {
        notifications().notify({ group: "vcs", level: "error", title: errorMessage(e) });
      });
    } catch (e) {
      if (live.current) setError(errorMessage(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="New Workspace"
      width={520}
      onClose={() => {
        if (!busy) onClose();
      }}
      buttons={[
        { label: "Create", role: "default", disabled: busy || invalid, onClick: () => void create() },
        { label: "Cancel", role: "cancel", disabled: busy },
      ]}
    >
      <div className={styles.form}>
        <T>Workspace name:</T>
        <Input aria-label="Workspace name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        <T>Folder:</T>
        <Input aria-label="Folder" value={path} disabled={busy} onChange={(e) => setFolder(e.target.value)} />
        <T>Base change or revision:</T>
        <Input
          aria-label="Base change or revision"
          value={revision}
          disabled={busy}
          onChange={(e) => setRevision(e.target.value)}
        />
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
