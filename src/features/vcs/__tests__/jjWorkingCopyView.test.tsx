import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FileStatus, VcsRoot } from "@/bindings";
import { executeAction, registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { registerVcsActions } from "../actions";
import { CommitTabs, CommitToolWindow } from "../CommitView";
import { useVcs } from "../store";
import { rememberMessage, savedDraft, writeDraft, useCommit } from "../commitStore";
import { useProject } from "@/platform/project";
import { maybeJjCommitMessageTarget } from "@/workbench/contributions";
import { ContextMenuHost } from "@/ui";
import { setAllInOneDiff } from "../allInOneDiff";
import { registerCommitCheck } from "../commitCheckRegistry";

const restore = vi.fn();
const commit = vi.fn();
const pendingPatch = vi.fn();
const confirm = vi.fn();
vi.mock("../dialogs", () => ({ confirmDialog: (...args: unknown[]) => confirm(...args) }));
vi.mock("../store", async (original) => ({ ...(await original<typeof import("../store")>()), refreshNow: vi.fn() }));
vi.mock("../DiffEditor", async (original) => ({
  ...(await original<typeof import("../DiffEditor")>()),
  DiffEditor: ({ input }: { input: { path: string } }) => <div data-testid="embedded-diff">{input.path}</div>,
}));
const readDiff = vi.fn();
const readHistoryDiff = vi.fn();
const openInput = vi.fn();
const openFile = vi.fn();
const notify = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsJjCommitFiles: (...args: unknown[]) => commit(...args),
      vcsJjPendingPatch: (...args: unknown[]) => pendingPatch(...args),
      vcsJjRestoreFiles: (...args: unknown[]) => restore(...args),
      vcsJjFileDiff: (...args: unknown[]) => readDiff(...args),
      vcsJjHistoryFileDiff: (...args: unknown[]) => readHistoryDiff(...args),
    },
  };
});
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput, openFile }),
  notifications: () => ({ notify }),
}));

const root = (patch: Partial<VcsRoot> = {}): VcsRoot => ({
  root: "/jj",
  kind: "jj",
  unavailableReason: null,
  operation: null,
  head: null,
  headCommit: null,
  workingCopy: { changeId: "change-id", commitId: "commit-id", description: "subject\n\nbody\n", files: [] },
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  commit.mockReset().mockResolvedValue({ status: "ok", data: null });
  pendingPatch.mockReset().mockResolvedValue({ status: "ok", data: "jj patch\n" });
  restore.mockReset().mockResolvedValue({ status: "ok", data: null });
  confirm.mockReset().mockResolvedValue(true);
  useCommit.setState({ groupByDir: true, commitDiffPreview: false });
  readDiff.mockReset();
  readHistoryDiff.mockReset();
  openInput.mockReset();
  openFile.mockReset();
  notify.mockReset();
  setAllInOneDiff(false);
  useVcs.setState({ available: false, root: "/jj", roots: [], jjRoots: [root()], error: null, status: [] });
});

it("focuses the single-root tree without redundant headings or metadata", () => {
  render(
    <>
      <CommitTabs />
      <CommitToolWindow />
    </>,
  );
  expect(screen.getByRole("tab", { name: "Commit" })).toBeInTheDocument();
  expect(screen.queryByText("jj")).toBeNull();
  expect(screen.queryByText("Working Copy @")).toBeNull();
  expect(screen.queryByText("Working-copy details")).toBeNull();
  expect(screen.queryByText("Change ID: change-id")).toBeNull();
  expect(screen.queryByText("Commit ID: commit-id")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  expect(screen.getByText("No working-copy changes")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveAttribute("placeholder", "Description");
  expect(within(screen.getByRole("group", { name: "Description" })).queryByText("Description")).toBeNull();
  expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  expect(screen.getByRole("separator", { name: "Description" })).toHaveAttribute("aria-orientation", "horizontal");
});

it("shows each root's files or explicit error without calling an unreadable root clean", () => {
  const copy = root().workingCopy!;
  useVcs.setState({
    jjRoots: [
      root({
        workingCopy: {
          ...copy,
          files: [{ path: "/jj/a.txt", relPath: "a.txt", unstaged: "modified", staged: null, renamedFrom: null }],
        },
      }),
      root({ root: "/broken", workingCopy: null, unavailableReason: "jj CLI failed" }),
    ],
  });
  render(<CommitToolWindow />);
  expect(screen.getByText("jj")).toBeInTheDocument();
  expect(screen.getByText("broken")).toBeInTheDocument();
  const path = screen.getByText("a.txt");
  const row = path.closest('[role="treeitem"]')!;
  expect(row).toBeInTheDocument();
  expect(path).toHaveAttribute("title", "Modified");
  expect(path).toHaveAttribute("aria-label", "a.txt: Modified");
  expect(path.previousElementSibling?.tagName.toLowerCase()).toBe("svg");
  expect(path.nextElementSibling).toBeNull();
  expect(within(row as HTMLElement).getByRole("checkbox")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "/broken" })).getByRole("alert")).toHaveTextContent("jj CLI failed");
  expect(screen.queryByText("No working-copy changes")).toBeNull();
  expect(useVcs.getState().available).toBe(false);
});

it("previews the selected file in place and drops an older response", async () => {
  const files = ["a.txt", "b.txt"].map((relPath) => ({
    path: `/jj/${relPath}`,
    relPath,
    unstaged: "modified" as const,
    staged: null,
    renamedFrom: null,
  }));
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files } })] });
  const result = {
    status: "ok",
    data: { before: "parent", after: "disk", beforeLabel: "Parent", afterLabel: "@" },
  };
  let finishFirst!: (value: typeof result) => void;
  readDiff
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    )
    .mockResolvedValueOnce(result);
  const dispose = registerVcsActions();
  setContext("vcsJjAvailable", true);
  try {
    render(<CommitToolWindow />);
    fireEvent.mouseDown(screen.getByText("a.txt"));
    expect(readDiff).not.toHaveBeenCalled();
    const toggle = screen.getByRole("button", { name: "Preview Diff" });
    fireEvent.click(toggle);
    expect(readDiff).toHaveBeenNthCalledWith(1, "/jj/a.txt", "commit-id");
    fireEvent.mouseDown(screen.getByText("b.txt"));
    expect(await screen.findByTestId("embedded-diff")).toHaveTextContent("/jj/b.txt");
    await act(async () => finishFirst(result));
    expect(screen.getByTestId("embedded-diff")).toHaveTextContent("/jj/b.txt");
    expect(openInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Diff" }));
    expect(screen.queryByTestId("embedded-diff")).not.toBeInTheDocument();
  } finally {
    setContext("vcsJjAvailable", false);
    dispose();
  }
});

it("retains the jj root heading alongside a Git root", () => {
  useVcs.setState({ roots: ["/git"] });
  render(<CommitToolWindow />);
  expect(screen.getByText("jj")).toBeInTheDocument();
});

it("opens deleted jj files as immutable diffs using their owning root snapshot", async () => {
  const file = {
    path: "/nested/jj/deleted",
    relPath: "deleted",
    unstaged: "deleted" as const,
    staged: null,
    renamedFrom: null,
  };
  useVcs.setState({
    roots: ["/git"],
    jjRoots: [
      root({ root: "/nested/jj", workingCopy: { ...root().workingCopy!, commitId: "snapshot", files: [file] } }),
    ],
  });
  readDiff.mockResolvedValue({
    status: "ok",
    data: { before: "old", after: "", beforeLabel: "Parent abc (deleted)", afterLabel: "@ (deleted)" },
  });
  render(<CommitToolWindow />);
  fireEvent.doubleClick(screen.getByText("deleted"));
  await waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
  expect(readDiff).toHaveBeenCalledWith(file.path, "snapshot");
  const data = openInput.mock.calls[0]![0].data;
  expect(data).toEqual({
    path: file.path,
    left: { type: "text", text: "old", label: "Parent abc (deleted)", jjBlame: null },
    right: { type: "text", text: "", label: "@ (deleted)", jjBlame: null },
  });
});

it("shows read errors without opening an empty or stale diff", async () => {
  const file = {
    path: "/jj/binary",
    relPath: "binary",
    unstaged: "modified" as const,
    staged: null,
    renamedFrom: null,
  };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  readDiff.mockResolvedValue({
    status: "error",
    error: { message: "Binary files are not supported", kind: "unavailable" },
  });
  render(<CommitToolWindow />);
  fireEvent.doubleClick(screen.getByText("binary"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Binary/));
  expect(openInput).not.toHaveBeenCalled();
});

it("opens existing jj files against the live working document", async () => {
  const file = { path: "/jj/a", relPath: "a", unstaged: "modified" as const, staged: null, renamedFrom: null };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  readDiff.mockResolvedValue({
    status: "ok",
    data: { before: "parent", after: "disk", beforeLabel: "Parent abc", afterLabel: "@ def" },
  });
  render(<CommitToolWindow />);
  fireEvent.doubleClick(screen.getByText("a"));
  await waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
  expect(openInput.mock.calls[0]![0].data.right).toEqual({ type: "worktree", label: "Working copy @", jjBlame: null });
});

it("opens all readable files in the working snapshot and reports unsupported siblings", async () => {
  const files: FileStatus[] = [
    { path: "/jj/deleted", relPath: "deleted", unstaged: "deleted", staged: null, renamedFrom: null },
    { path: "/jj/renamed", relPath: "renamed", unstaged: "renamed", staged: null, renamedFrom: "old" },
    { path: "/jj/binary", relPath: "binary", unstaged: "modified", staged: null, renamedFrom: null },
    { path: "/jj/conflicted", relPath: "conflicted", unstaged: "conflicted", staged: null, renamedFrom: null },
  ];
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files } })] });
  setAllInOneDiff(true);
  const old = { root: "/jj", commit: "parent", path: "/jj/old" };
  readDiff.mockResolvedValue({
    status: "ok",
    data: { before: "old", after: "new", beforeLabel: "Parent (old)", afterLabel: "@", beforeBlame: old },
  });
  readHistoryDiff.mockImplementation((_root: string, path: string) =>
    Promise.resolve(
      path === "/jj/binary"
        ? { status: "error", error: { message: "Binary files are not supported" } }
        : path === "/jj/conflicted"
          ? { status: "ok", data: { before: "base", after: "markers", beforeLabel: "Base", afterLabel: "Conflict" } }
          : {
              status: "ok",
              data: { before: "deleted", after: "", beforeLabel: "Parent", afterLabel: "Deleted", afterAbsent: true },
            },
    ),
  );
  render(<CommitToolWindow />);
  fireEvent.doubleClick(screen.getByText("renamed"));
  await waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
  expect(readDiff).toHaveBeenCalledExactlyOnceWith("/jj/renamed", "commit-id");
  expect(readHistoryDiff.mock.calls).toEqual(
    ["/jj/deleted", "/jj/binary", "/jj/conflicted"].map((path) => ["/jj", path, "commit-id"]),
  );
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "warning", body: expect.stringContaining("binary") }),
  );
  expect(openInput.mock.calls[0]![0]).toMatchObject({
    kind: "combined-diff",
    data: {
      reveal: "/jj/renamed",
      items: [
        { path: "/jj/deleted", right: { type: "text", absent: true } },
        { path: "/jj/renamed", left: { type: "text", jjBlame: old }, right: { type: "worktree" } },
        { path: "/jj/conflicted", left: { type: "text", text: "base" }, right: { type: "worktree" } },
      ],
    },
  });
});
it("does not open an in-flight diff after its working-copy root changes", async () => {
  const file = { path: "/jj/a", relPath: "a", unstaged: "modified" as const, staged: null, renamedFrom: null };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  let resolve!: (value: unknown) => void;
  readDiff.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<CommitToolWindow />);
  fireEvent.doubleClick(screen.getByText("a"));
  useVcs.setState({ jjRoots: [] });
  resolve({ status: "ok", data: { before: "parent", after: "disk", beforeLabel: "Parent abc", afterLabel: "@ def" } });
  await waitFor(() => expect(readDiff).toHaveBeenCalledTimes(1));
  await new Promise((done) => setTimeout(done, 0));
  expect(openInput).not.toHaveBeenCalled();
});

it("propagates group checks independently of focus and rolls back checked files only", async () => {
  const files = ["src/a", "src/b", "other/c"].map((relPath) => ({
    path: `/jj/${relPath}`,
    relPath,
    unstaged: "modified" as const,
    staged: null,
    renamedFrom: null,
  }));
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files } })] });
  render(<CommitToolWindow />);
  const group = screen.getByRole("checkbox", { name: "Select src for commit" });
  fireEvent.mouseDown(group, { button: 0 });
  expect(screen.getByRole("checkbox", { name: "Select a for commit" })).toBeChecked();
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select b for commit" }), { button: 0 });
  expect(group).toBePartiallyChecked();
  fireEvent.click(screen.getByText("c"));
  fireEvent.click(screen.getByRole("button", { name: "Rollback checked files…" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("/jj", "commit-id", ["/jj/src/a"]));
});

it("does not restore after cancellation", async () => {
  confirm.mockResolvedValue(false);
  const file = { path: "/jj/a", relPath: "a", unstaged: "modified" as const, staged: null, renamedFrom: null };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  render(<CommitToolWindow />);
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for commit" }), { button: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Rollback checked files…" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(restore).not.toHaveBeenCalled();
});

it("refuses a root replaced while confirmation is open", async () => {
  const file = { path: "/jj/a", relPath: "a", unstaged: "modified" as const, staged: null, renamedFrom: null };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  confirm.mockImplementation(async () => {
    useVcs.setState({ jjRoots: [] });
    return true;
  });
  render(<CommitToolWindow />);
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for commit" }), { button: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Rollback checked files…" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(restore).not.toHaveBeenCalled();
});

const changesAt = (path: string, names: string[]) =>
  root({
    root: path,
    workingCopy: {
      ...root().workingCopy!,
      commitId: path + "-commit",
      files: names.map((name) => ({
        path: `${path}/${name}`,
        relPath: name,
        unstaged: "modified",
        staged: null,
        renamedFrom: null,
      })),
    },
  });

it("groups attached repositories in one tree with a shared description", () => {
  useVcs.setState({ jjRoots: [changesAt("/vault", ["a"]), changesAt("/obsidian", ["b"])] });
  render(<CommitToolWindow />);
  expect(screen.getAllByRole("tree")).toHaveLength(1);
  const heading = screen.getByText("obsidian").closest('[role="treeitem"]')!;
  expect(heading).toHaveAttribute("aria-expanded", "true");
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select obsidian for commit" }), { button: 0 });
  expect(screen.getByRole("checkbox", { name: "Select b for commit" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Select vault for commit" })).not.toBeChecked();
  expect(screen.getAllByRole("textbox", { name: "Description" })).toHaveLength(1);
});

it("toggles every repository from the Changes row and reflects partial selection", () => {
  useVcs.setState({ jjRoots: [changesAt("/vault", ["a"]), changesAt("/obsidian", ["b"])] });
  render(<CommitToolWindow />);
  expect(within(screen.getByRole("toolbar")).queryByRole("checkbox")).toBeNull();
  const changes = screen.getByText("Changes").closest<HTMLElement>('[role="treeitem"]')!;
  const all = within(changes).getByRole("checkbox", { name: "Select All" });
  const vault = screen.getByRole("checkbox", { name: "Select vault for commit" });
  const obsidian = screen.getByRole("checkbox", { name: "Select obsidian for commit" });
  expect(all).not.toBeChecked();
  fireEvent.mouseDown(vault, { button: 0 });
  expect(all).toBePartiallyChecked();
  fireEvent.mouseDown(all, { button: 0 });
  expect(all).toBeChecked();
  expect(vault).toBeChecked();
  expect(obsidian).toBeChecked();
  fireEvent.mouseDown(all, { button: 0 });
  expect(all).not.toBeChecked();
  expect(vault).not.toBeChecked();
  expect(obsidian).not.toBeChecked();
});

it("shows checked file counts by change kind across attached repositories", () => {
  const vault = changesAt("/vault", ["added.txt", "modified.txt"]);
  vault.workingCopy!.files[0]!.unstaged = "added";
  useVcs.setState({ jjRoots: [vault, changesAt("/obsidian", ["other.txt"])] });
  render(<CommitToolWindow />);
  const header = within(screen.getByRole("group", { name: "Description" }));
  expect(header.queryByText("1 added")).toBeNull();
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select All" }), { button: 0 });
  expect(header.getByText("1 added")).toHaveStyle({ color: "var(--vcs-added)" });
  expect(header.getByText("2 modified")).toHaveStyle({ color: "var(--vcs-modified)" });
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select modified.txt for commit" }), { button: 0 });
  expect(header.getByText("1 modified")).toBeVisible();
});

it("uses the Agent action for the jj draft and protects newer typing", async () => {
  const run = vi.fn();
  const dispose = registerAction({
    id: "agents.generateCommitMessage",
    title: "Generate Commit Message with Agent",
    run,
  });
  try {
    useVcs.setState({ jjRoots: [changesAt("/vault", ["a", "other"]), changesAt("/obsidian", ["b"])] });
    render(<CommitToolWindow />);
    const header = within(screen.getByRole("group", { name: "Description" }));
    const generate = header.getByRole("button", { name: "Generate Commit Message with Agent" });
    expect(generate).toBeDisabled();
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for commit" }), { button: 0 });
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select b for commit" }), { button: 0 });
    fireEvent.click(generate);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: "jj" }));
    const target = maybeJjCommitMessageTarget()!;
    const snapshot = (await target.changes())!;
    expect(snapshot.roots).toEqual(["/vault", "/obsidian"]);
    expect(pendingPatch.mock.calls).toEqual([
      ["/vault", "/vault-commit", ["/vault/a"]],
      ["/obsidian", "/obsidian-commit", ["/obsidian/b"]],
    ]);
    const field = screen.getByRole("textbox", { name: "Description" });
    act(() => expect(target.setMessage(snapshot.revision, "Generated")).toBe(true));
    expect(field).toHaveValue("Generated");
    const beforeEdit = target.revision();
    fireEvent.change(field, { target: { value: "My draft" } });
    expect(target.setMessage(beforeEdit, "Late reply")).toBe(false);
    expect(field).toHaveValue("My draft");
  } finally {
    dispose();
  }
});

it("offers portable checks in the gear and pauses the commit until their result is reviewed", async () => {
  useVcs.setState({ jjRoots: [changesAt("/jj", ["a", "other"])] });
  const analysis = vi.fn().mockReturnValue({ severity: "error", text: "Review this result" });
  const gitCheck = vi.fn();
  const dispose = [
    registerCommitCheck({ id: "vcs.analysis", title: "Code analysis", run: analysis }),
    registerCommitCheck({ id: "vcs.detachedHead", title: "Commit in detached HEAD", run: gitCheck }),
  ];
  try {
    render(<CommitToolWindow />);
    fireEvent.click(screen.getByRole("button", { name: "Commit Options" }));
    const options = within(screen.getByRole("dialog", { name: "Commit Options" }));
    expect(options.getByRole("checkbox", { name: "Analyze code" })).toBeInTheDocument();
    expect(options.getByRole("checkbox", { name: "Check TODO" })).toBeInTheDocument();
    expect(options.getByRole("button", { name: "Configure" })).toBeInTheDocument();
    expect(options.queryByRole("checkbox", { name: "Run Git hooks" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for commit" }), { button: 0 });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review this result");
    expect(analysis).toHaveBeenCalledWith(
      expect.objectContaining({ existing: ["/jj/a"], todoDiff: expect.any(Function) }),
    );
    expect(gitCheck).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Commit Anyway" }));
    await waitFor(() => expect(commit).toHaveBeenCalledWith("/jj", "/jj-commit", ["/jj/a"], "Example"));
    expect(analysis).toHaveBeenCalledOnce();
  } finally {
    dispose.forEach((off) => off());
  }
});

it("commits checked paths per root with a shared description and retries only the failure", async () => {
  useVcs.setState({ jjRoots: [changesAt("/vault", ["a", "b"]), changesAt("/obsidian", ["c", "d"])] });
  commit.mockResolvedValueOnce({ status: "ok", data: null });
  commit.mockResolvedValueOnce({ status: "error", error: { kind: "unavailable", message: "commit failed" } });
  render(<CommitToolWindow />);
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select All" }), { button: 0 });
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select b for commit" }), { button: 0 });
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select d for commit" }), { button: 0 });
  expect(screen.getByRole("button", { name: "Commit to 2 repositories" })).toBeDisabled();
  const field = screen.getByRole("textbox", { name: "Description" });
  const message = "subject\n\nbody";
  fireEvent.change(field, { target: { value: message } });
  const button = screen.getByRole("button", { name: "Commit to 2 repositories" });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("obsidian · commit failed"));
  expect(commit).toHaveBeenCalledTimes(2);
  expect(commit).toHaveBeenNthCalledWith(1, "/vault", "/vault-commit", ["/vault/a"], message);
  expect(commit).toHaveBeenNthCalledWith(2, "/obsidian", "/obsidian-commit", ["/obsidian/c"], message);
  expect(screen.getByText("vault", { selector: "strong" }).parentElement).toHaveTextContent("Committed");
  expect(screen.getByRole("checkbox", { name: "Select a for commit" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Select c for commit" })).toBeChecked();
  expect(field).toHaveValue(message);
  expect(screen.getByRole("button", { name: "Commit Message History" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));
  await waitFor(() => expect(field).toHaveValue(""));
  expect(commit).toHaveBeenCalledTimes(3);
  expect(commit).toHaveBeenLastCalledWith("/obsidian", "/obsidian-commit", ["/obsidian/c"], message);
  fireEvent.click(screen.getByRole("button", { name: "Commit Message History" }));
  const items = within(screen.getByRole("menu", { name: "Recent commit messages" })).getAllByRole("menuitem");
  expect(items).toHaveLength(1);
  fireEvent.click(items[0]!);
  expect(field).toHaveValue(message);
  expect(field).toHaveFocus();
});

it("keeps jj history separate from Git and records only successful commits", async () => {
  rememberMessage("Git message");
  useVcs.setState({ jjRoots: [changesAt("/jj", ["a"])] });
  commit.mockResolvedValueOnce({ status: "error", error: { kind: "unavailable", message: "commit failed" } });
  const view = render(<CommitToolWindow />);
  const history = screen.getByRole("button", { name: "Commit Message History" });
  expect(history).toBeDisabled();
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for commit" }), { button: 0 });
  const field = screen.getByRole("textbox", { name: "Description" });
  fireEvent.change(field, { target: { value: "Failed message" } });
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("commit failed");
  expect(history).toBeDisabled();
  fireEvent.change(field, { target: { value: "Successful message" } });
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));
  await waitFor(() => expect(history).toBeEnabled());
  view.unmount();
  render(<CommitToolWindow />);
  fireEvent.click(screen.getByRole("button", { name: "Commit Message History" }));
  const menu = within(screen.getByRole("menu", { name: "Recent commit messages" }));
  expect(menu.getAllByRole("menuitem")).toHaveLength(1);
  expect(menu.getByRole("menuitem", { name: "Successful message" })).toBeInTheDocument();
});

it("disables description editing and commit in an untrusted project", () => {
  const project = useProject.getState().project;
  useProject.setState({ project: { ...project!, trusted: false } });
  try {
    render(<CommitToolWindow />);
    expect(screen.getByRole("textbox", { name: "Description" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(commit).not.toHaveBeenCalled();
  } finally {
    useProject.setState({ project });
  }
});

it("opens inherited conflicted jj files with the conflict baseline and a live working document", async () => {
  const file = {
    path: "/jj/conflict",
    relPath: "conflict",
    unstaged: "conflicted" as const,
    staged: null,
    renamedFrom: null,
  };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  readDiff.mockResolvedValue({
    status: "ok",
    data: {
      before: "base\n",
      after: "canonical conflict",
      beforeLabel: "Conflict base (common text merged)",
      afterLabel: "@ conflict",
    },
  });
  render(<CommitToolWindow />);
  fireEvent.doubleClick(screen.getByText("conflict"));
  await waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
  expect(readDiff).toHaveBeenCalledWith(file.path, "commit-id");
  expect(openInput.mock.calls[0]![0].data).toMatchObject({
    left: { type: "text", text: "base\n", label: "Conflict base (common text merged)" },
    right: { type: "worktree", label: "Working copy @" },
  });
});

it("opens a jj merge editor from the conflicted file context menu", async () => {
  const file = {
    path: "/jj/conflict",
    relPath: "conflict",
    unstaged: "conflicted" as const,
    staged: null,
    renamedFrom: null,
  };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  fireEvent.contextMenu(screen.getByText("conflict"));
  fireEvent.click(await screen.findByText("Resolve Conflicts…"));
  await waitFor(() =>
    expect(openInput).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "merge:jj:/jj/conflict",
        data: { path: file.path, vcs: "jj" },
      }),
      { focus: true },
    ),
  );
  expect(readDiff).not.toHaveBeenCalled();
});

it.each(["conflicted", "modified"] as const)(
  "orders the %s context menu with separators and copies clicked paths",
  async (kind) => {
    const files = ["a", "b"].map((name) => ({
      path: `/jj/${name}`,
      relPath: name,
      unstaged: kind,
      staged: null,
      renamedFrom: null,
    }));
    useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files } })] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <>
        <CommitToolWindow />
        <ContextMenuHost />
      </>,
    );
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for commit" }), { button: 0 });
    fireEvent.contextMenu(screen.getByText("b"));
    const menu = await screen.findByRole("menu");
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((item) =>
      item.getAttribute("role") === "separator" ? "separator" : item.textContent,
    );
    expect(rows).toEqual(
      kind === "conflicted"
        ? ["Show Diff", "separator", "Resolve Conflicts…", "separator", "Copy Path", "Copy File Name"]
        : ["Show Diff", "separator", "Copy Path", "Copy File Name"],
    );
    expect(screen.queryByText("Rollback…")).toBeNull();
    fireEvent.click(within(menu).getByText("Copy Path"));
    expect(writeText).toHaveBeenCalledWith("/jj/b");
    expect(restore).not.toHaveBeenCalled();
  },
);

it("routes contextual Show Diff through the jj snapshot and ignores a stale response", async () => {
  const file = { path: "/jj/a", relPath: "a", unstaged: "conflicted" as const, staged: null, renamedFrom: null };
  const r = root({ workingCopy: { ...root().workingCopy!, files: [file] } });
  useVcs.setState({ jjRoots: [r] });
  let finish!: (value: unknown) => void;
  readDiff.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  fireEvent.contextMenu(screen.getByText("a"));
  fireEvent.click(await screen.findByText("Show Diff"));
  expect(readDiff).toHaveBeenCalledWith("/jj/a", "commit-id");
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...r.workingCopy!, commitId: "new" } })] });
  finish({ status: "ok", data: { before: "base", after: "conflict", beforeLabel: "Parent", afterLabel: "@" } });
  await waitFor(() => expect(screen.getByText("a")).toBeInTheDocument());
  expect(openInput).not.toHaveBeenCalled();
});

it("does not resolve from a context menu after its root is replaced", async () => {
  const file = { path: "/jj/a", relPath: "a", unstaged: "conflicted" as const, staged: null, renamedFrom: null };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  fireEvent.contextMenu(screen.getByText("a"));
  const resolve = await screen.findByText("Resolve Conflicts…");
  useVcs.setState({ jjRoots: [] });
  fireEvent.click(resolve);
  expect(openInput).not.toHaveBeenCalled();
});

it("copies the selected files when opening a selected row's menu", async () => {
  const files = ["a", "b"].map((name) => ({
    path: `/jj/${name}`,
    relPath: name,
    unstaged: "modified" as const,
    staged: null,
    renamedFrom: null,
  }));
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files } })] });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  fireEvent.mouseDown(screen.getByText("a"), { button: 0 });
  fireEvent.mouseDown(screen.getByText("b"), { button: 0, metaKey: true });
  fireEvent.contextMenu(screen.getByText("a"));
  fireEvent.click(await screen.findByText("Copy Path"));
  expect(writeText).toHaveBeenCalledWith("/jj/a\n/jj/b");
});

it("reports contextual diff editor-open failures", async () => {
  const file = { path: "/jj/a", relPath: "a", unstaged: "modified" as const, staged: null, renamedFrom: null };
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files: [file] } })] });
  readDiff.mockResolvedValue({
    status: "ok",
    data: { before: "base", after: "changed", beforeLabel: "Parent", afterLabel: "@" },
  });
  openInput.mockRejectedValueOnce(new Error("editor failed"));
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  fireEvent.contextMenu(screen.getByText("a"));
  fireEvent.click(await screen.findByText("Show Diff"));
  expect(await screen.findByRole("alert")).toHaveTextContent("a: Error: editor failed");
});

it("copies jj file names and paths from the keyboard and directory menu", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  useVcs.setState({
    jjRoots: [
      root({
        workingCopy: {
          ...root().workingCopy!,
          files: ["a.txt", "b.txt"].map((name) => ({
            path: `/jj/src/${name}`,
            relPath: `src/${name}`,
            unstaged: "modified",
            staged: null,
            renamedFrom: null,
          })),
        },
      }),
    ],
  });
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  const row = (await screen.findByText("a.txt")).closest('[role="treeitem"]')!;
  act(() => fireEvent.mouseDown(row));
  act(() => fireEvent.keyDown(row, { key: "c", code: "KeyC", metaKey: true }));
  expect(writeText).toHaveBeenLastCalledWith("a.txt");
  act(() => fireEvent.keyDown(row, { key: "C", code: "KeyC", metaKey: true, shiftKey: true }));
  expect(writeText).toHaveBeenLastCalledWith("/jj/src/a.txt");
  const directory = screen.getByText("src").closest('[role="treeitem"]')!;
  act(() => fireEvent.contextMenu(directory));
  fireEvent.click(await screen.findByText("Copy File Name"));
  expect(writeText).toHaveBeenLastCalledWith("a.txt\nb.txt");
  act(() => fireEvent.contextMenu(directory));
  fireEvent.click(await screen.findByText("Copy Path"));
  expect(writeText).toHaveBeenLastCalledWith("/jj/src/a.txt\n/jj/src/b.txt");
  expect(restore).not.toHaveBeenCalled();
});

it("opens the selected jj source on F4 and leaves deleted files closed", async () => {
  const files = ["source", "deleted"].map((relPath) => ({
    path: `/jj/${relPath}`,
    relPath,
    unstaged: relPath === "deleted" ? ("deleted" as const) : ("modified" as const),
    staged: null,
    renamedFrom: null,
  }));
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, files } })] });
  render(<CommitToolWindow />);
  fireEvent.mouseDown(screen.getByText("source"));
  fireEvent.keyDown(screen.getByRole("tree"), { key: "F4" });
  expect(openFile).toHaveBeenCalledWith("/jj/source", { focus: true });
  openFile.mockClear();
  fireEvent.mouseDown(screen.getByText("deleted"));
  fireEvent.keyDown(screen.getByRole("tree"), { key: "F4" });
  expect(openFile).not.toHaveBeenCalled();
  expect(readDiff).not.toHaveBeenCalled();
});

it("opens the explicit jj diff from the new-window action in a jj-only project", async () => {
  const dispose = registerVcsActions();
  setContext("vcsAvailable", false);
  setContext("vcsJjAvailable", true);
  const target = { root: "/jj", path: "/jj/a", commit: "immutable" };
  const data = {
    path: "/jj/a",
    left: { type: "text" as const, text: "", label: "Parent", absent: true },
    right: { type: "text" as const, text: "snapshot", label: "@", jjBlame: target },
  };
  try {
    await executeAction("vcs.showDiffInNewWindow", data);
    await waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
    expect(openInput.mock.calls[0]![0].data).toEqual(data);
    expect(readDiff).not.toHaveBeenCalled();
  } finally {
    dispose();
    setContext("vcsJjAvailable", false);
  }
});

it("keeps the jj draft across remounts without sharing the Git draft", () => {
  writeDraft("/jj", "Git draft");
  const first = render(<CommitToolWindow />);
  fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "jj draft" } });
  first.unmount();
  expect(savedDraft("/jj", "jj")).toBe("jj draft");
  expect(savedDraft("/jj")).toBe("Git draft");
  render(<CommitToolWindow />);
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("jj draft");
});
it("keeps jj drafts isolated when projects switch", () => {
  render(<CommitToolWindow />);
  fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "first" } });
  act(() => useVcs.setState({ root: "/other", jjRoots: [root({ root: "/other" })] }));
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "second" } });
  act(() => useVcs.setState({ root: "/jj", jjRoots: [root()] }));
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("first");
  expect(savedDraft("/other", "jj")).toBe("second");
});

it("honors the shared option hiding the agent message button", () => {
  const settings = useProject.getState().settings;
  useProject.setState({ settings: { ...settings, vcs: { commit: { agentButton: false } } } } as never);
  const view = render(<CommitToolWindow />);
  expect(screen.queryByRole("button", { name: "Generate Commit Message with Agent" })).toBeNull();
  view.unmount();
  useProject.setState({ settings });
});
