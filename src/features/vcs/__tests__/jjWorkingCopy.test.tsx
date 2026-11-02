import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { VcsRoot } from "@/bindings";
import { CommitToolWindow } from "../CommitView";
import { useVcs } from "../store";
import { useCommit } from "../commitStore";
import { useProject } from "@/platform/project";

const restore = vi.fn();
const describe = vi.fn();
const confirm = vi.fn();
vi.mock("../dialogs", () => ({ confirmDialog: (...args: unknown[]) => confirm(...args) }));
vi.mock("../store", async (original) => ({ ...(await original<typeof import("../store")>()), refreshNow: vi.fn() }));
const readDiff = vi.fn();
const openInput = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsJjDescribe: (...args: unknown[]) => describe(...args),
      vcsJjRestoreFiles: (...args: unknown[]) => restore(...args),
      vcsJjFileDiff: (...args: unknown[]) => readDiff(...args),
    },
  };
});
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput }),
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
  describe.mockReset().mockResolvedValue({ status: "ok", data: null });
  restore.mockReset().mockResolvedValue({ status: "ok", data: null });
  confirm.mockReset().mockResolvedValue(true);
  useCommit.setState({ groupByDir: true });
  readDiff.mockReset();
  openInput.mockReset();
  useVcs.setState({ available: false, root: "/jj", roots: [], jjRoots: [root()], error: null, status: [] });
});

it("focuses the single-root tree without redundant headings or metadata", () => {
  render(<CommitToolWindow />);
  expect(screen.queryByText("jj")).toBeNull();
  expect(screen.queryByText("Working Copy @")).toBeNull();
  expect(screen.queryByText("Working-copy details")).toBeNull();
  expect(screen.queryByText("Change ID: change-id")).toBeNull();
  expect(screen.queryByText("Commit ID: commit-id")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  expect(screen.getByText("No working-copy changes")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("subject\n\nbody\n");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("separator", { name: "Description" })).toHaveAttribute("aria-orientation", "horizontal");
  expect(screen.queryByRole("button", { name: /^Commit/ })).toBeNull();
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
    left: { type: "text", text: "old", label: "Parent abc (deleted)" },
    right: { type: "text", text: "", label: "@ (deleted)" },
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
  expect(openInput.mock.calls[0]![0].data.right).toEqual({ type: "worktree", label: "Working copy @" });
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
  const group = screen.getByRole("checkbox", { name: "Select src for rollback" });
  fireEvent.mouseDown(group, { button: 0 });
  expect(screen.getByRole("checkbox", { name: "Select a for rollback" })).toBeChecked();
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select b for rollback" }), { button: 0 });
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
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for rollback" }), { button: 0 });
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
  fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Select a for rollback" }), { button: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Rollback checked files…" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(restore).not.toHaveBeenCalled();
});

it("keeps multiline drafts across file snapshots and retries failed saves", async () => {
  render(<CommitToolWindow />);
  const field = screen.getByRole("textbox", { name: "Description" });
  fireEvent.change(field, { target: { value: "new subject\n\nfull body\n" } });
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...root().workingCopy!, commitId: "snapshot-2" } })] });
  expect(field).toHaveValue("new subject\n\nfull body\n");
  describe.mockResolvedValueOnce({ status: "error", error: { kind: "unavailable", message: "save failed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("save failed"));
  expect(field).toHaveValue("new subject\n\nfull body\n");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(describe).toHaveBeenCalledTimes(2));
  expect(describe).toHaveBeenLastCalledWith("/jj", {
    commit: "commit-id",
    change: "change-id",
    original: "subject\n\nbody\n",
    description: "new subject\n\nfull body\n",
  });
});

it("retains separate drafts through change switches and blocks external description conflicts", async () => {
  render(<CommitToolWindow />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "my draft" } });
  const copy = root().workingCopy!;
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...copy, changeId: "another", description: "other\n" } })] });
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("other\n"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "other draft" } });
  useVcs.setState({ jjRoots: [root()] });
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("my draft"));
  useVcs.setState({ jjRoots: [root({ workingCopy: { ...copy, description: "external edit\n" } })] });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("changed externally"));
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("textbox")).toHaveValue("my draft");
  fireEvent.click(screen.getByRole("button", { name: "Reload description" }));
  expect(screen.getByRole("textbox")).toHaveValue("external edit\n");
  expect(describe).not.toHaveBeenCalled();
});

it("clears a description in only the chosen root and prevents duplicate busy saves", async () => {
  useVcs.setState({ jjRoots: [root(), root({ root: "/other" })] });
  let resolve!: (value: unknown) => void;
  describe.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<CommitToolWindow />);
  const region = within(screen.getByRole("region", { name: "/other" }));
  fireEvent.change(region.getByRole("textbox"), { target: { value: "" } });
  fireEvent.click(region.getByRole("button", { name: "Save" }));
  expect(region.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(describe).toHaveBeenCalledTimes(1);
  expect(describe).toHaveBeenCalledWith("/other", expect.objectContaining({ description: "" }));
  expect(within(screen.getByRole("region", { name: "/jj" })).getByRole("textbox")).toHaveValue("subject\n\nbody\n");
  resolve({ status: "ok", data: null });
  await waitFor(() => expect(region.getByRole("textbox")).not.toBeDisabled());
});

it("disables description editing and save in an untrusted project", () => {
  const project = useProject.getState().project;
  useProject.setState({ project: { ...project!, trusted: false } });
  try {
    render(<CommitToolWindow />);
    expect(screen.getByRole("textbox", { name: "Description" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(describe).not.toHaveBeenCalled();
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
