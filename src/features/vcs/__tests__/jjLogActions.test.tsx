import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JjHistoryCommit } from "@/bindings";
import type { MenuItem } from "@/ui";
import { useProject } from "@/platform/project";
import { useVcs } from "../store";
import { JjLog } from "../JjLog";
import { jjLogMenu, validateJjName } from "../jjLogActions";

const mocks = vi.hoisted(() => ({
  action: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
  reload: vi.fn(),
  copy: vi.fn(),
  confirm: vi.fn(),
  prompt: vi.fn(),
  menu: vi.fn(),
  notify: vi.fn(),
  history: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      vcsJjLogAction: mocks.action,
      vcsJjHistory: mocks.history,
      vcsJjHistoryFiles: vi.fn(async () => ({ status: "ok", data: [] })),
    },
  };
});
vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  copyText: mocks.copy,
  showContextMenu: mocks.menu,
}));
vi.mock("../dialogs", () => ({ confirmDialog: mocks.confirm, promptText: mocks.prompt }));
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  refreshNow: mocks.refresh,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ saveAll: mocks.save }),
  notifications: () => ({ notify: mocks.notify }),
}));
const row: JjHistoryCommit = {
  id: "a".repeat(40),
  changeId: "z".repeat(32),
  description: "subject\n\nfull body\n",
  parents: [],
  localBookmarks: [],
  remoteBookmarks: [],
  tags: [],
  author: "A",
  email: "a@b",
  timeMs: "0",
  workingCopy: false,
};
const run = (items: MenuItem[], label: string) => {
  const item = items.find((i) => "label" in i && i.label === label);
  if (item && "run" in item) item.run?.();
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.history.mockResolvedValue({
    status: "ok",
    data: {
      commits: [row, { ...row, id: "b".repeat(40), changeId: "y".repeat(32), description: "second" }],
      next: null,
    },
  });
  mocks.action.mockResolvedValue({ status: "ok", data: null });
  mocks.save.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.prompt.mockResolvedValue({ value: "new-ref", checked: false });
  useProject.setState({ project: { root: "/project", name: "project", trusted: true, isGit: false, settings: {} } });
});
it("groups actions with separators, copies full metadata, and dispatches independent jj identities", async () => {
  const menu = jjLogMenu("/two", row, () => true, mocks.reload);
  expect(menu.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
    "Copy Change ID",
    "Copy Description",
    "separator",
    "New Change",
    "Edit Change",
    "separator",
    "Abandon Change…",
    "separator",
    "Move Bookmark…",
    "New Bookmark…",
    "New Tag…",
  ]);
  run(menu, "Copy Change ID");
  run(menu, "Copy Description");
  expect(mocks.copy.mock.calls).toEqual([[row.changeId], [row.description]]);
  for (const [label, action] of [
    ["New Change", { kind: "new" }],
    ["Edit Change", { kind: "edit" }],
    ["Abandon Change…", { kind: "abandon" }],
    ["Move Bookmark…", { kind: "moveBookmark", name: "new-ref" }],
    ["New Bookmark…", { kind: "bookmark", name: "new-ref" }],
    ["New Tag…", { kind: "tag", name: "new-ref" }],
  ] as const) {
    run(menu, label);
    await waitFor(() => expect(mocks.action).toHaveBeenLastCalledWith("/two", row.id, row.changeId, action));
  }
  await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(6));
  expect(mocks.refresh).toHaveBeenCalledTimes(6);
  expect(mocks.save).toHaveBeenCalledTimes(3);
  expect(mocks.confirm.mock.calls[0]![0].message).toContain("Descendants will be rebased");
});
it("cancels dialogs and refuses a stale menu or a failed save", async () => {
  const menu = jjLogMenu("/two", row, () => true, mocks.reload);
  mocks.confirm.mockResolvedValue(false);
  mocks.prompt.mockResolvedValue(null);
  run(menu, "Abandon Change…");
  run(menu, "New Bookmark…");
  run(menu, "Move Bookmark…");
  run(menu, "New Tag…");
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.action).not.toHaveBeenCalled();
  mocks.save.mockRejectedValue(new Error("save failed"));
  run(menu, "Edit Change");
  await waitFor(() => expect(mocks.notify).toHaveBeenCalled());
  expect(mocks.action).not.toHaveBeenCalled();
  expect(mocks.reload).not.toHaveBeenCalled();
  let current = true;
  const stale = jjLogMenu("/two", row, () => current, mocks.reload);
  current = false;
  run(stale, "New Change");
  expect(mocks.action).not.toHaveBeenCalled();
});
it("checks context after dialogs and saves and disables writes in Restricted Mode", async () => {
  let current = true;
  const menu = jjLogMenu("/two", row, () => current, mocks.reload);
  mocks.prompt.mockImplementation(async () => {
    current = false;
    return { value: "late" };
  });
  run(menu, "New Tag…");
  await Promise.resolve();
  expect(mocks.action).not.toHaveBeenCalled();
  current = true;
  mocks.save.mockImplementation(async () => {
    current = false;
  });
  run(menu, "New Change");
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.action).not.toHaveBeenCalled();
  useProject.setState({ project: { ...useProject.getState().project!, trusted: false } });
  const restricted = jjLogMenu("/two", row, () => true, mocks.reload);
  expect(restricted.slice(2).every((i) => i.kind === "separator" || ("disabled" in i && i.disabled))).toBe(true);
  run(restricted, "New Change");
  expect(mocks.action).not.toHaveBeenCalled();
});
it("uses the right-clicked row rather than the previous selection and invalidates after refresh", async () => {
  useVcs.setState({
    root: "/project",
    jjRoots: [
      {
        root: "/two",
        kind: "jj",
        unavailableReason: null,
        workingCopy: null,
        head: null,
        headCommit: null,
        operation: null,
      },
    ],
    version: 0,
  });
  render(<JjLog />);
  const second = await screen.findByText("second");
  fireEvent.contextMenu(second);
  const menu = mocks.menu.mock.calls[0]![1];
  run(menu, "New Bookmark…");
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith("/two", "b".repeat(40), "y".repeat(32), {
      kind: "bookmark",
      name: "new-ref",
    }),
  );
  mocks.action.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  run(menu, "New Change");
  expect(mocks.action).not.toHaveBeenCalled();
});
it("validates empty, option-looking and whitespace names before submitting", () => {
  for (const name of ["", "--allow-move", "bad name", "a\nb"]) expect(validateJjName(name)).not.toBeNull();
  expect(validateJjName("release/topic")).toBeNull();
});

it("refreshes failed command results and reloads a remounted history on success", async () => {
  mocks.action.mockResolvedValueOnce({ status: "error", error: { kind: "unavailable", message: "jj failed" } });
  run(
    jjLogMenu("/two", row, () => true, mocks.reload),
    "New Change",
  );
  await waitFor(() => expect(mocks.notify).toHaveBeenCalled());
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.reload).toHaveBeenCalledTimes(1);
  useVcs.setState({
    root: "/project",
    jjRoots: [
      {
        root: "/two",
        kind: "jj",
        unavailableReason: null,
        workingCopy: null,
        head: null,
        headCommit: null,
        operation: null,
      },
    ],
    version: 0,
  });
  render(<JjLog />);
  fireEvent.contextMenu(await screen.findByText("second"));
  mocks.refresh.mockImplementationOnce(async () => {
    act(() => useVcs.setState({ version: 1 }));
  });
  run(mocks.menu.mock.calls[0]![1], "New Tag…");
  await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));
});

it("prompts for an existing bookmark and rejects a stale move dialog", async () => {
  let current = true;
  mocks.prompt.mockResolvedValueOnce({ value: "main", checked: false });
  const menu = jjLogMenu("/two", row, () => current, mocks.reload);
  run(menu, "Move Bookmark…");
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith("/two", row.id, row.changeId, { kind: "moveBookmark", name: "main" }),
  );
  expect(mocks.prompt).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Move Bookmark",
      label: "Existing bookmark",
      okLabel: "Move",
      validate: validateJjName,
    }),
  );
  expect(mocks.save).not.toHaveBeenCalled();
  mocks.action.mockClear();
  mocks.prompt.mockImplementationOnce(async () => {
    current = false;
    return { value: "main" };
  });
  run(menu, "Move Bookmark…");
  await Promise.resolve();
  expect(mocks.action).not.toHaveBeenCalled();
});
