/** Jujutsu registrations use workspace names/revisions, never Git branches. */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { JjWorkspace } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { Button, Dialog, IconButton, Input, Select, showContextMenu, T } from "@/ui";
import { confirmDialog, openDialog } from "./dialogs";
import { errorMessage } from "./ops";
import { refreshNow, repoName, useVcs } from "./store";
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
  const [recovery, setRecovery] = useState<JjWorkspace | null>(null);
  const operation = useRef(false);
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
        setRecovery(null);
        setSelected((name) => (list.some((w) => w.name === name) ? name : null));
      }
    } catch (e) {
      if (live.current && request === generation.current) {
        setError(errorMessage(e));
        setRecovery(null);
      }
    }
  }, [root]);
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [reload]);
  const current = rows.find((w) => w.name === selected);
  const open = async (row: JjWorkspace) => {
    if (!live.current || operation.current || !row.path) return;
    operation.current = true;
    setBusy(true);
    try {
      const latest = await call(commands.vcsJjWorkspaces(root));
      if (!live.current) return;
      const target = latest.find((w) => w.name === row.name);
      if (!target || target.path !== row.path || target.commitId !== row.commitId)
        throw new Error(tx("Workspace changed; refresh the list"));
      await executeAction("file.openProjectPath", row.path);
    } catch (e) {
      fail(e, row);
    } finally {
      if (live.current) setBusy(false);
      operation.current = false;
    }
  };
  const fail = (e: unknown, row?: JjWorkspace) => {
    if (!live.current) return;
    const message = errorMessage(e);
    setError(message);
    setRecovery(
      row?.path &&
        /(?:working copy[^\n]*stale|stale working copy)/i.test(message) &&
        /workspace update-stale/.test(message)
        ? row
        : null,
    );
  };
  const update = async (row: JjWorkspace) => {
    if (!live.current || operation.current || !row.path) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setRecovery(null);
    try {
      // Include text changes not yet acknowledged by the backend.
      const dirty = await Promise.all(
        (maybeEditorService()?.dirtyDocumentIds?.() ?? []).map((doc) => call(commands.docSnapshot(doc))),
      );
      if (!live.current) return;
      if (dirty.some((doc) => doc.path === row.path || doc.path.startsWith(`${row.path}/`)))
        throw new Error(tx("Save unsaved documents before updating the workspace"));
      await call(commands.vcsJjUpdateWorkspace(root, row));
      if (live.current) await reload();
    } catch (e) {
      fail(e, row);
    } finally {
      try {
        if (live.current) await refreshNow();
      } catch (e) {
        fail(e);
      } finally {
        if (live.current) setBusy(false);
        operation.current = false;
      }
    }
  };
  const remove = async () => {
    if (!live.current || !current || current.current || !current.path || operation.current) return;
    operation.current = true;
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
      fail(e, current);
    } finally {
      if (live.current) setBusy(false);
      operation.current = false;
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
            onContextMenu={(e) => {
              setSelected(w.name);
              showContextMenu(e, [
                {
                  label: "Update Workspace",
                  disabled: busy || !w.path,
                  run: () => {
                    if (live.current) void update(w);
                  },
                },
              ]);
            }}
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
          {recovery && (
            <Button disabled={busy} onClick={() => void update(recovery)}>
              <T>Update Workspace</T>
            </Button>
          )}
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
