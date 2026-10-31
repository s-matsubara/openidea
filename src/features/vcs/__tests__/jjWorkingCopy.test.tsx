import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { VcsRoot } from "@/bindings";
import { CommitToolWindow } from "../CommitView";
import { useVcs } from "../store";

const readDiff = vi.fn();
const openInput = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, vcsJjFileDiff: (...args: unknown[]) => readDiff(...args) } };
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
  readDiff.mockReset();
  openInput.mockReset();
  useVcs.setState({ available: false, root: "/jj", roots: [], jjRoots: [root()], error: null, status: [] });
});

it("focuses the single-root file list and keeps metadata collapsed until opened", () => {
  render(<CommitToolWindow />);
  expect(screen.queryByText("jj")).toBeNull();
  const details = screen.getByText("Working-copy details").closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(screen.getByText("Change ID: change-id")).not.toBeVisible();
  fireEvent.click(screen.getByText("Working-copy details"));
  expect(details).toHaveAttribute("open");
  expect(screen.getByText("Change ID: change-id")).toBeVisible();
  expect(screen.getByText("Commit ID: commit-id")).toBeInTheDocument();
  expect(screen.getByText(/subject/).textContent).toBe("subject\n\nbody\n");
  expect(screen.getByText("No working-copy changes")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
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
  const row = path.closest('[role="option"]')!;
  expect(row).toBeInTheDocument();
  expect(path).toHaveAttribute("title", "a.txt");
  expect(path.previousElementSibling?.tagName.toLowerCase()).toBe("svg");
  expect(path.nextElementSibling).toHaveTextContent("Modified");
  expect(row.children).toHaveLength(3);
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
  fireEvent.click(screen.getByText("deleted"));
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
  fireEvent.click(screen.getByText("binary"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Binary/));
  expect(openInput).not.toHaveBeenCalled();
});
