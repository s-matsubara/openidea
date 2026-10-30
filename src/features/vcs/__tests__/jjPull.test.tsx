import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { runJjPull, showJjRemoteDialog } from "../jjMenuDialogs";
import { allRepos, runRemote } from "../ops";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({
  dialog: vi.fn(),
  options: vi.fn(),
  pull: vi.fn(),
  fetch: vi.fn(),
  git: vi.fn(),
  cancel: vi.fn(),
  save: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {},
}));
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  openDialog: mocks.dialog,
}));
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  refreshNow: mocks.refresh,
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ saveAll: mocks.save }),
  notifications: () => ({ notify: mocks.notify }),
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      vcsJjPullOptions: mocks.options,
      vcsJjPull: mocks.pull,
      vcsJjFetch: mocks.fetch,
      vcsRemote: mocks.git,
      cancelRequest: mocks.cancel,
    },
  };
});

const ok = (data: unknown) => ({ status: "ok", data });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.options.mockResolvedValue(
    ok({
      remotes: ["origin"],
      bookmarks: [{ name: "main", remote: "origin" }],
      preferred: { name: "main", remote: "origin" },
    }),
  );
  mocks.pull.mockResolvedValue(ok(""));
  mocks.fetch.mockResolvedValue(ok(""));
  mocks.git.mockResolvedValue(ok(null));
  mocks.save.mockResolvedValue(undefined);
  useVcs.setState({
    root: "/project",
    available: false,
    repo: null,
    roots: [],
    remoteBusy: null,
    jjRoots: [
      {
        root: "/project/jj",
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

it("shows the concrete trunk target in the Pull dialog and saves before submitting it", async () => {
  showJjRemoteDialog("pull", mocks.dialog);
  const close = vi.fn();
  render(mocks.dialog.mock.calls[0]![0](close));
  expect(await screen.findByText("main@origin")).toBeInTheDocument();
  expect(screen.queryByLabelText("Repository")).toBeNull();
  expect(screen.queryByLabelText("Remote")).toBeNull();
  expect(screen.queryByText("--rebase")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pull" }));
  await waitFor(() => expect(mocks.pull).toHaveBeenCalledWith("/project/jj", "origin", "main"));
  expect(mocks.save).toHaveBeenCalledBefore(mocks.pull);
  expect(close).toHaveBeenCalledOnce();
});

it("requires a destination when trunk cannot be resolved", async () => {
  mocks.options.mockResolvedValue(
    ok({
      remotes: ["origin"],
      bookmarks: [{ name: "main", remote: "origin" }],
      preferred: null,
    }),
  );
  showJjRemoteDialog("pull", mocks.dialog);
  render(mocks.dialog.mock.calls[0]![0](vi.fn()));
  await screen.findByLabelText("Rebase destination");
  expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
});

it("stops after a save failure and suppresses a simultaneous Pull", async () => {
  let rejectSave!: (reason: Error) => void;
  mocks.save.mockReturnValue(
    new Promise((_, reject) => {
      rejectSave = reject;
    }),
  );
  const pull = runJjPull("/project/jj", "origin", "main");
  await runJjPull("/project/jj", "origin", "main");
  rejectSave(new Error("Could not save"));
  await pull;
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.pull).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Could not save" }));
  expect(useVcs.getState().remoteBusy).toBeNull();
});

it("fetches Git repositories without fetching Jujutsu", async () => {
  useVcs.setState({ available: true, roots: ["/project/git"] });
  expect(await runRemote({ op: "fetch" }, undefined, allRepos())).toBe(true);
  expect(mocks.git).toHaveBeenCalledExactlyOnceWith(
    "/project/git",
    expect.any(Number),
    { op: "fetch" },
    expect.anything(),
  );
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("reports a rebase failure after a successful fetch and refreshes without retrying", async () => {
  const message = "Jujutsu Fetch completed, but rebase did not complete: bookmark disappeared";
  mocks.pull.mockRejectedValue(new Error(message));
  await runJjPull("/project/jj", "origin", "main");
  expect(mocks.pull).toHaveBeenCalledOnce();
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: message }));
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("cancels Git fetch without triggering Jujutsu fetch", async () => {
  useVcs.setState({ available: true, roots: ["/project/git"] });
  let completeGit!: (result: ReturnType<typeof ok>) => void;
  mocks.git.mockReturnValue(
    new Promise((resolve) => {
      completeGit = resolve;
    }),
  );
  const fetch = runRemote({ op: "fetch" }, undefined, allRepos());
  await waitFor(() => expect(mocks.git).toHaveBeenCalledOnce());
  const progress = mocks.notify.mock.calls.find(([notice]) => notice.sticky)?.[0];
  progress.actions[0].run();
  completeGit(ok(null));
  expect(await fetch).toBe(false);
  expect(mocks.cancel).toHaveBeenCalledOnce();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
