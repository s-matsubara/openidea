import { useEffect, useRef, useState, type ReactNode } from "react";
import type { JjPullOptions, JjRebaseOptions, JjRebaseRevision } from "@/bindings";
import { activeEditor } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { maybeEditorService } from "@/workbench/contributions";
import { Checkbox, Dialog, Input, Select, T, type SelectOption } from "@/ui";
import { tx } from "@/platform/i18n";
import { PullFrame } from "./pullFrame";
import { errorMessage, logConsole, runOp } from "./ops";
import { repoName, useVcs } from "./store";
import styles from "./common.module.css";

type RemoteOperation = "fetch" | "pull" | "rebase";

export function showJjRemoteDialog(kind: RemoteOperation, open: (render: (close: () => void) => ReactNode) => void) {
  open((close) => <RepositoryDialog kind={kind} close={close} />);
}

function RepositoryDialog({ kind, close }: { kind: RemoteOperation; close: () => void }) {
  const roots = useVcs((s) => s.jjRoots);
  const project = useVcs((s) => s.root);
  const [root, setRoot] = useState(() => {
    const path = activeEditor()?.ctx.path;
    return (
      [...roots]
        .sort((a, b) => b.root.length - a.root.length)
        .find(({ root }) => path === root || path?.startsWith(`${root}/`))?.root ??
      roots[0]?.root ??
      ""
    );
  });
  const selector = roots.length > 1 && (
    <Select
      aria-label="Repository"
      value={root}
      onChange={setRoot}
      options={roots.map(({ root }) => ({ value: root, label: repoName(root), detail: root }))}
    />
  );
  if (!roots.some((repo) => repo.root === root)) {
    return (
      <Dialog
        open
        title={kind === "fetch" ? "Fetch" : kind === "pull" ? "Pull" : "Rebase"}
        onClose={close}
        buttons={[{ label: "Cancel", role: "cancel" }]}
      >
        {selector}
        <T>The selected repository is no longer available</T>
      </Dialog>
    );
  }
  if (kind === "pull") {
    return <JjPullDialog key={`${project}\0${root}`} root={root} onClose={close} repositorySelector={selector} />;
  }
  return kind === "fetch" ? (
    <FetchDialog key={`${project}\0${root}`} root={root} close={close} selector={selector} />
  ) : (
    <RebaseDialog key={`${project}\0${root}`} root={root} close={close} selector={selector} />
  );
}

function JjPullDialog({
  root,
  onClose,
  repositorySelector,
}: {
  root: string;
  onClose: () => void;
  repositorySelector: ReactNode;
}) {
  const [options, setOptions] = useState<JjPullOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [bookmark, setBookmark] = useState<string | null>(null);
  const busy = useVcs((state) => state.remoteBusy);
  useEffect(() => {
    let alive = true;
    void call(commands.vcsJjPullOptions(root))
      .then((result) => {
        if (!alive) return;
        setOptions(result);
        setRemote(result.preferred?.remote ?? result.remotes[0] ?? null);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [root]);
  const destinations = options?.bookmarks.filter((b) => b.remote === remote) ?? [];
  const preferred = options?.preferred;
  const target = bookmark ?? (preferred && preferred.remote === remote ? preferred.name : null);
  const run = () => {
    if (!remote || !target || useVcs.getState().remoteBusy) return;
    onClose();
    void runJjPull(root, remote, target);
  };

  return (
    <PullFrame title={tx("Pull Jujutsu Changes")} onClose={onClose} disabled={!remote || !target || !!busy} run={run}>
      {repositorySelector}
      {error && (
        <div role="alert" className={styles.hint}>
          {error}
        </div>
      )}
      {options && !options.remotes.length && (
        <div className={styles.hint}>
          <T>No remotes are configured.</T>
        </div>
      )}
      {options && remote && (
        <div className={styles.fieldRow}>
          {options.remotes.length > 1 && (
            <Select
              aria-label="Remote"
              value={remote}
              options={options.remotes.map((name) => ({ value: name, label: name }))}
              onChange={(value) => {
                setRemote(value);
                setBookmark(null);
              }}
            />
          )}
          <Select
            aria-label="Rebase destination"
            className={styles.grow}
            value={target}
            placeholder="Rebase destination"
            options={destinations.map((b) => ({ value: b.name, label: `${b.name}@${b.remote}`, icon: "branch" }))}
            onChange={setBookmark}
          />
        </div>
      )}
      {remote && destinations.length === 0 && (
        <div className={styles.hint}>
          <T>No remote bookmarks are available. Fetch first.</T>
        </div>
      )}
      <div className={styles.hint}>
        <T>Fetch the selected remote, then rebase the current working-copy branch and its descendants.</T>
      </div>
    </PullFrame>
  );
}

export async function runJjPull(root: string, remote: string, bookmark: string) {
  const { root: project, remoteBusy } = useVcs.getState();
  if (remoteBusy) return;
  useVcs.setState({ remoteBusy: tx("Pulling") });
  try {
    await runOp(
      "Jujutsu Pull",
      async () => {
        await maybeEditorService()?.saveAll();
        const state = useVcs.getState();
        if (state.root !== project || !state.jjRoots.some((repo) => repo.root === root)) {
          throw new Error(tx("The selected repository is no longer available"));
        }
        const output = await call(commands.vcsJjPull(root, remote, bookmark));
        if (output) logConsole("out", output);
      },
      { success: tx("Pull successful") },
    );
  } finally {
    useVcs.setState({ remoteBusy: null });
  }
}

function useOptions<T>(root: string, load: (root: string) => Promise<T>) {
  const [options, setOptions] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void load(root)
      .then((result) => {
        if (live) setOptions(result);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [root, load]);
  return { options, error };
}

async function run(root: string, title: string, execute: () => Promise<string>) {
  const { root: project, remoteBusy } = useVcs.getState();
  if (remoteBusy) return;
  useVcs.setState({ remoteBusy: title });
  try {
    await runOp(
      title,
      async () => {
        await maybeEditorService()?.saveAll();
        const state = useVcs.getState();
        if (state.root !== project || !state.jjRoots.some((repo) => repo.root === root)) {
          throw new Error(tx("The selected repository is no longer available"));
        }
        const output = await execute();
        if (output) logConsole("out", output);
      },
      { success: tx("Operation completed") },
    );
  } finally {
    useVcs.setState({ remoteBusy: null });
  }
}

type FormProps = { root: string; close: () => void; selector: ReactNode };
const loadFetch = (root: string) => call(commands.vcsJjFetchOptions(root));
function FetchDialog({ root, close, selector }: FormProps) {
  const { options, error } = useOptions(root, loadFetch);
  const [chosenRemote, setRemote] = useState<string | null>(null);
  const [tagOnly, setTagOnly] = useState(false);
  const [tag, setTag] = useState("*");
  const [tagName, setTagName] = useState("");
  const busy = useVcs((s) => s.remoteBusy);
  const remote = chosenRemote ?? options?.remotes.find((r) => r === "origin") ?? options?.remotes[0] ?? null;
  const selectedTag = tag === "name:" ? tagName.trim() : tag === "*" ? "*" : tag.slice(4);
  return (
    <Dialog
      open
      title={tx("Fetch")}
      onClose={close}
      width={460}
      buttons={[
        {
          label: "Fetch",
          role: "default",
          disabled: !remote || (tagOnly && !selectedTag) || !!busy,
          onClick: () => {
            if (!remote || (tagOnly && !selectedTag) || useVcs.getState().remoteBusy) return;
            close();
            void run(root, tx("Jujutsu Fetch"), () =>
              call(commands.vcsJjFetchSelected(root, remote, tagOnly ? selectedTag : null)),
            );
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        {selector}
        {error && <div role="alert">{error}</div>}
        <div className={styles.fieldLabel}>
          <T>Remote</T>
        </div>
        <Select
          aria-label="Remote"
          value={remote}
          options={(options?.remotes ?? []).map((value) => ({ value, label: value }))}
          onChange={(value) => {
            setRemote(value);
            setTag("*");
            setTagName("");
          }}
        />
        <div className={styles.fieldRow}>
          <Checkbox label={tx("Tags only")} checked={tagOnly} onChange={setTagOnly} />
          <Select
            aria-label="Tag"
            className={styles.grow}
            value={tag}
            disabled={!tagOnly || !remote}
            searchable
            options={[
              { value: "*", label: "*" },
              ...(options?.tags.filter((ref) => ref.remote === remote) ?? []).map((ref) => ({
                value: `tag:${ref.name}`,
                label: ref.name,
              })),
              { value: "name:", label: "Enter tag name…" },
            ]}
            onChange={setTag}
          />
        </div>
        {tagOnly && tag === "name:" && (
          <Input aria-label="Tag name" value={tagName} onChange={(e) => setTagName(e.target.value)} />
        )}
        {options && !remote && <T>No remotes are configured.</T>}
      </div>
    </Dialog>
  );
}

const loadRebase = (root: string) => call(commands.vcsJjRebaseOptions(root));
function grouped(refs: JjRebaseRevision[]): SelectOption[] {
  return (["bookmark", "tag"] as const).flatMap((kind) => {
    const options = refs.flatMap((ref, index) =>
      ref.kind === kind ? [{ value: String(index), label: ref.label, detail: ref.remote ?? tx("Local") }] : [],
    );
    return options.length
      ? [{ value: kind, label: kind === "tag" ? "Tags" : "Bookmarks", section: true }, ...options]
      : [];
  });
}

function RebaseDialog({ root, close, selector }: FormProps) {
  const { options, error } = useOptions<JjRebaseOptions>(root, loadRebase);
  const [source, setSource] = useState("current");
  const [destination, setDestination] = useState("trunk");
  const [skipEmptied, setSkipEmptied] = useState(true);
  const [ignoreImmutable, setIgnoreImmutable] = useState(false);
  const busy = useVcs((s) => s.remoteBusy);
  const refs = options?.destinations ?? [];
  const choices = grouped(refs);
  const sourceRef = refs[Number(source)];
  const destinationRef = refs[Number(destination)];
  const target = destination === "trunk" ? options?.preferred : destinationRef?.commitId;
  const from = source === "current" ? null : sourceRef?.commitId;
  const submitted = useRef(false);
  const trunkLabel = options?.trunkLabel;
  return (
    <Dialog
      open
      title={tx("Rebase")}
      onClose={close}
      width={510}
      buttons={[
        {
          label: "Rebase",
          role: "default",
          disabled: !target || from === undefined || from === target || !!busy,
          onClick: () => {
            if (!target || from === undefined || from === target || submitted.current || useVcs.getState().remoteBusy)
              return;
            submitted.current = true;
            close();
            void run(root, tx("Jujutsu Rebase"), async () => {
              const latest = await loadRebase(root);
              const unchanged = (ref: JjRebaseRevision | undefined) =>
                !!ref &&
                latest.destinations.some(
                  (candidate) =>
                    candidate.kind === ref.kind &&
                    candidate.label === ref.label &&
                    candidate.remote === ref.remote &&
                    candidate.commitId === ref.commitId,
                );
              if (
                (source !== "current" && !unchanged(sourceRef)) ||
                (destination === "trunk" ? latest.preferred !== target : !unchanged(destinationRef))
              ) {
                throw new Error(tx("Rebase target changed. Reopen Rebase and check your selections."));
              }
              return call(commands.vcsJjRebase(root, from, target, skipEmptied, ignoreImmutable));
            });
          },
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        {selector}
        {error && <div role="alert">{error}</div>}
        <div className={styles.fieldLabel}>
          <T>Rebase source</T>
        </div>
        <Select
          aria-label="Rebase source"
          value={source}
          onChange={setSource}
          searchable
          options={[{ value: "current", label: "Current working-copy branch (@)" }, ...choices]}
        />
        {source !== "current" && <T>Move the selected change and its descendants.</T>}
        <div className={styles.fieldLabel}>
          <T>Rebase destination</T>
        </div>
        <Select
          aria-label="Rebase destination"
          value={destination}
          onChange={setDestination}
          searchable
          options={[
            {
              value: "trunk",
              label: trunkLabel ? tx`trunk() → ${trunkLabel}` : "trunk()",
              disabled: !options?.preferred,
            },
            ...choices,
          ]}
        />
        <Checkbox label={tx("Skip changes emptied by rebase")} checked={skipEmptied} onChange={setSkipEmptied} />
        <Checkbox
          label={tx("Ignore immutable protection for this rebase")}
          checked={ignoreImmutable}
          onChange={setIgnoreImmutable}
        />
      </div>
    </Dialog>
  );
}
