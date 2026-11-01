import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JjWorkspacesPanel, NewWorkspaceDialog } from "../jjWorkspaces";
import { useVcs } from "../store";

const list = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const execute = vi.fn();
const confirm = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsJjWorkspaces: (...a: unknown[]) => list(...a),
      vcsJjAddWorkspace: (...a: unknown[]) => add(...a),
      vcsJjRemoveWorkspace: (...a: unknown[]) => remove(...a),
    },
  };
});
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: (...a: unknown[]) => execute(...a),
}));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirmDialog: (...a: unknown[]) => confirm(...a),
}));
const current = { name: "default", path: "/project", changeId: "change-main", commitId: "commit-main", current: true };
const other = { name: "other", path: "/other", changeId: "change-other", commitId: "commit-other", current: false };
const ok = (data: unknown) => ({ status: "ok", data });
beforeEach(() => {
  list.mockReset().mockResolvedValue(ok([current, other]));
  add.mockReset().mockResolvedValue(ok(null));
  remove.mockReset().mockResolvedValue(ok(null));
  execute.mockReset().mockResolvedValue(undefined);
  confirm.mockReset().mockResolvedValue(true);
  useVcs.setState({
    root: "/project",
    jjRoots: [
      {
        root: "/project",
        kind: "jj",
        unavailableReason: null,
        workingCopy: null,
        operation: null,
        head: null,
        headCommit: null,
      },
    ],
  });
});
it("lists actual workspace paths, protects current registration and opens through project lifecycle", async () => {
  render(<JjWorkspacesPanel />);
  fireEvent.click(await screen.findByRole("option", { name: /default/ }));
  expect(screen.getByRole("button", { name: "Remove Workspace" })).toBeDisabled();
  fireEvent.click(screen.getByRole("option", { name: /other/ }));
  fireEvent.click(screen.getByRole("button", { name: "Open Workspace…" }));
  await waitFor(() => expect(execute).toHaveBeenCalledWith("file.openProjectPath", "/other"));
  expect(remove).not.toHaveBeenCalled();
});
it("cancel retains registration; confirm removes the selected identity and refreshes", async () => {
  render(<JjWorkspacesPanel />);
  fireEvent.click(await screen.findByRole("option", { name: /other/ }));
  confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "Remove Workspace" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(remove).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove Workspace" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Remove Workspace" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("/project", other));
  expect(confirm.mock.calls[1]?.[0]?.message).toContain("all contents are deleted");
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});
it("rejects changed rows before opening", async () => {
  render(<JjWorkspacesPanel />);
  fireEvent.click(await screen.findByRole("option", { name: /other/ }));
  list.mockResolvedValueOnce(ok([{ ...other, commitId: "changed" }]));
  fireEvent.click(screen.getByRole("button", { name: "Open Workspace…" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace changed");
  expect(execute).not.toHaveBeenCalled();
});
it("creates from a revision and offers the normal Open Project flow", async () => {
  const close = vi.fn();
  const created = vi.fn();
  render(<NewWorkspaceDialog root="/project" onClose={close} onCreated={created} />);
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "feature" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Base change or revision" }), { target: { value: "abc123" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(add).toHaveBeenCalledWith("/project", "feature", "/project-feature", "abc123"));
  expect(created).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledWith("file.openProjectPath", "/project-feature");
});
it("drops a late list response after changing repository", async () => {
  let done!: (v: unknown) => void;
  list.mockReturnValueOnce(
    new Promise((resolve) => {
      done = resolve;
    }),
  );
  render(<JjWorkspacesPanel />);
  await waitFor(() => expect(list).toHaveBeenCalledWith("/project"));
  act(() =>
    useVcs.setState({
      root: "/new",
      jjRoots: [
        {
          root: "/new",
          kind: "jj",
          unavailableReason: null,
          workingCopy: null,
          operation: null,
          head: null,
          headCommit: null,
        },
      ],
    }),
  );
  await screen.findByRole("option", { name: /other/ });
  await act(async () => done(ok([{ ...other, name: "obsolete" }])));
  expect(screen.queryByRole("option", { name: /obsolete/ })).toBeNull();
});

it("retains unknown paths without enabling open or remove", async () => {
  list.mockResolvedValue(ok([{ ...other, path: null }]));
  render(<JjWorkspacesPanel />);
  fireEvent.click(await screen.findByRole("option", { name: /other/ }));
  expect(screen.getByText(/Workspace path unavailable/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Workspace…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Workspace" })).toBeDisabled();
});
it("cancels creation before invoking jj", () => {
  const close = vi.fn();
  render(<NewWorkspaceDialog root="/project" onClose={close} onCreated={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(add).not.toHaveBeenCalled();
});
