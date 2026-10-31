import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JjHistoryCommit, JjHistoryPage, VcsRoot } from "@/bindings";
import { getAction, isActionEnabled } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { registerHistoryActions } from "../historyActions";
import { registerVcsActions } from "../actions";
import { GitTabs, GitToolWindow } from "../GitLog";
import { useGitLog } from "../logStore";
import { useVcs } from "../store";

const history = vi.fn();
const gitLog = vi.fn();
const rootsRequest = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsJjHistory: (...args: unknown[]) => history(...args),
      vcsRoots: () => rootsRequest(),
      vcsLog: (...args: unknown[]) => gitLog(...args),
    },
  };
});
const root = (name: string, unavailableReason: string | null = null): VcsRoot => ({
  root: name,
  kind: "jj",
  unavailableReason,
  workingCopy: null,
  head: null,
  headCommit: null,
  operation: null,
});
const commit = (id: string, patch: Partial<JjHistoryCommit> = {}): JjHistoryCommit => ({
  id,
  changeId: "stable-change",
  description: `subject ${id}\n\n日本語 full body\n`,
  parents: ["parent-a", "parent-b"],
  localBookmarks: ["local"],
  remoteBookmarks: ["remote@origin"],
  author: "Writer",
  email: "a@example.com",
  timeMs: "1700000000000",
  workingCopy: true,
  ...patch,
});
const ok = (commits: JjHistoryCommit[], next: JjHistoryPage["next"] = null) => ({
  status: "ok",
  data: { commits, next },
});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { resolve, promise };
};

beforeEach(() => {
  history.mockReset();
  rootsRequest.mockReset();
  gitLog.mockReset();
  useVcs.setState({ available: false, root: "/project", roots: [], jjRoots: [root("/one"), root("/two")], version: 0 });
  useGitLog.setState({ tab: "log" });
});

it("exposes Jujutsu in a jj-only existing window with full metadata and keyboard selection, without Git controls", async () => {
  history.mockResolvedValue(
    ok([
      commit("first"),
      commit("second", { workingCopy: false, localBookmarks: [], remoteBookmarks: [], parents: [] }),
    ]),
  );
  render(
    <>
      <GitTabs />
      <GitToolWindow />
    </>,
  );
  expect(screen.getByRole("tab", { name: "Jujutsu" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("tab", { name: "Log" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
  await screen.findByText("Commit ID");
  const details = screen.getByLabelText("Jujutsu change details");
  expect(within(details).getByText("stable-change")).toBeInTheDocument();
  expect(within(details).getByText("first")).toBeInTheDocument();
  expect(within(details).getByText("parent-a")).toBeInTheDocument();
  expect(within(details).getByText("parent-b")).toBeInTheDocument();
  expect(within(details).getByText("remote@origin")).toBeInTheDocument();
  expect(within(details).getByText(/日本語 full body/)).toHaveTextContent("subject first");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  expect(within(details).getByText("second")).toBeInTheDocument();
  expect(within(details).getByText("None (root)")).toBeInTheDocument();
  expect(screen.queryByTitle("Revert Selected Changes")).toBeNull();
  expect(gitLog).not.toHaveBeenCalled();
  expect(useVcs.getState().available).toBe(false);
});

it("rejects stale root and refresh responses and resets pagination and selection synchronously", async () => {
  const old = deferred();
  const current = deferred();
  history.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  render(<GitToolWindow />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "/two" } });
  await act(async () => current.resolve(ok([commit("two")], { root: "/two", operation: "op", seen: ["two"] })));
  await act(async () => old.resolve(ok([commit("stale-one")])));
  expect(screen.queryByText("subject stale-one")).toBeNull();
  expect(within(screen.getByLabelText("Jujutsu change details")).getByText("two")).toBeInTheDocument();
  const staleMore = deferred();
  const fresh = deferred();
  history.mockReturnValueOnce(staleMore.promise).mockReturnValueOnce(fresh.promise);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(history).toHaveBeenLastCalledWith("/two", { root: "/two", operation: "op", seen: ["two"] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  expect(screen.queryByLabelText("Jujutsu change details")).toBeNull();
  await act(async () => fresh.resolve(ok([commit("fresh")])));
  await act(async () => staleMore.resolve(ok([commit("stale-page")])));
  expect(screen.queryByText("subject stale-page")).toBeNull();
  expect(screen.getByText("fresh")).toBeInTheDocument();
  expect(history).toHaveBeenLastCalledWith("/two", null);
});

it("loads more without conflating divergent commits sharing a change ID, preserves selection, and clears errors on reload", async () => {
  history
    .mockResolvedValueOnce(ok([commit("first")], { root: "/one", operation: "op", seen: ["first"] }))
    .mockResolvedValueOnce(ok([commit("divergent", { workingCopy: false })]));
  render(<GitToolWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() =>
    expect(screen.getAllByRole("option", { selected: false }).some((e) => e.textContent?.includes("divergent"))).toBe(
      true,
    ),
  );
  expect(screen.getByText("first")).toBeInTheDocument();
  expect(screen.getAllByRole("option").filter((e) => e.id.startsWith("jj-"))).toHaveLength(2);
  history.mockResolvedValueOnce({ status: "error", error: { message: "missing jj", kind: "unavailable" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("missing jj");
  expect(screen.queryByText("first")).toBeNull();
  history.mockResolvedValueOnce(ok([commit("recovered")]));
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  await screen.findByText("recovered");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("invalidates rows and pending requests when the CLI becomes unavailable or project changes", async () => {
  history.mockResolvedValueOnce(ok([commit("initial")]));
  render(<GitToolWindow />);
  await screen.findByText("initial");
  act(() => useVcs.setState({ jjRoots: [root("/one", "CLI removed")] }));
  expect(await screen.findByRole("alert")).toHaveTextContent("CLI removed");
  expect(screen.queryByText("initial")).toBeNull();
  expect(history).toHaveBeenCalledTimes(1);
  const old = deferred();
  history.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok([commit("new-project")]));
  act(() => useVcs.setState({ jjRoots: [root("/one")] }));
  act(() => useVcs.setState({ root: "/other-project" }));
  await screen.findByText("new-project");
  await act(async () => old.resolve(ok([commit("old-project")])));
  expect(screen.queryByText("subject old-project")).toBeNull();
});

it("retains Git tabs in a mixed project while Jujutsu remains read-only", async () => {
  history.mockResolvedValue(ok([commit("mixed")]));
  useVcs.setState({ available: true, roots: ["/git"] });
  useGitLog.setState({ tab: "jj" });
  render(
    <>
      <GitTabs />
      <GitToolWindow />
    </>,
  );
  expect(screen.getByRole("tab", { name: "Log" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Worktrees" })).toBeInTheDocument();
  await screen.findByText("mixed");
  expect(gitLog).not.toHaveBeenCalled();
});

it("enables the explicit Jujutsu entry without Git and gates stale Git selection actions while its tab is active", async () => {
  const offHistory = registerHistoryActions();
  const offVcs = registerVcsActions();
  setContext("vcsAvailable", false);
  setContext("vcsJjAvailable", true);
  expect(isActionEnabled(getAction("vcs.showJjHistory")!)).toBe(true);
  expect(isActionEnabled(getAction("vcs.showLog")!)).toBe(false);
  history.mockResolvedValue(ok([commit("capabilities")]));
  useVcs.setState({ available: true, roots: ["/git"] });
  setContext("vcsAvailable", true);
  useGitLog.setState({ tab: "jj" });
  const view = render(<GitToolWindow />);
  await screen.findByText("capabilities");
  expect(isActionEnabled(getAction("vcs.log.cherryPick")!)).toBe(false);
  expect(isActionEnabled(getAction("vcs.log.resetToHere")!)).toBe(false);
  view.unmount();
  expect(isActionEnabled(getAction("vcs.log.cherryPick")!)).toBe(true);
  offHistory();
  offVcs();
});

it("rechecks root availability on refresh so an installed or restored CLI can recover", async () => {
  useVcs.setState({ jjRoots: [root("/one", "missing CLI")] });
  rootsRequest.mockResolvedValue({ status: "ok", data: [root("/one")] });
  history.mockResolvedValue(ok([commit("restored-cli")]));
  render(<GitToolWindow />);
  expect(screen.getByRole("alert")).toHaveTextContent("missing CLI");
  expect(history).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  await screen.findByText("restored-cli");
  expect(rootsRequest).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});
