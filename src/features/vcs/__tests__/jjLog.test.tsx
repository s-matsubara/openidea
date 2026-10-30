import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FileStatus, JjHistoryCommit, JjHistoryPage, VcsRoot } from "@/bindings";
import { getAction, isActionEnabled } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { registerHistoryActions } from "../historyActions";
import { registerVcsActions } from "../actions";
import { GitTabs } from "../GitLog";
import { JjTabs, JjToolWindow } from "../JjToolWindow";
import { useLogOptions } from "../logOptions";
import { useGitLog } from "../logStore";
import { useVcs } from "../store";

const history = vi.fn();
const historyFiles = vi.fn();
const historyDiff = vi.fn();
const openInput = vi.fn();
const gitLog = vi.fn();
const rootsRequest = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsJjHistoryFiles: (...args: unknown[]) => historyFiles(...args),
      vcsJjHistoryFileDiff: (...args: unknown[]) => historyDiff(...args),
      vcsJjHistory: (...args: unknown[]) => history(...args),
      vcsRoots: () => rootsRequest(),
      vcsLog: (...args: unknown[]) => gitLog(...args),
    },
  };
});
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openInput }),
}));
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
  tags: [],
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
  historyFiles.mockReset().mockResolvedValue({ status: "ok", data: [] });
  historyDiff.mockReset();
  openInput.mockReset();
  useLogOptions.setState({ diffPreview: false });
  rootsRequest.mockReset();
  gitLog.mockReset();
  useVcs.setState({
    available: false,
    root: "/project",
    roots: [],
    jjRoots: [root("/one"), root("/two")],
    version: 0,
    repo: null,
  });
  useGitLog.setState({ tab: "log" });
});

it("exposes Jujutsu in a jj-only dedicated window with compact metadata and keyboard selection, without Git controls", async () => {
  history.mockResolvedValue(
    ok([
      commit("first"),
      commit("second", { workingCopy: false, localBookmarks: [], remoteBookmarks: [], parents: [] }),
    ]),
  );
  render(
    <>
      <JjTabs />
      <JjToolWindow />
    </>,
  );
  expect(screen.getByRole("tab", { name: "Log" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Workspaces" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
  await screen.findByRole("button", { name: "Copy Change ID" });
  const details = screen.getByLabelText("Jujutsu change details");
  expect(within(details).getByRole("button", { name: "Copy Change ID" })).toHaveTextContent("stable-c");
  expect(within(details).getByRole("button", { name: "Copy Change ID" })).toHaveAttribute(
    "title",
    "Copy Change ID\nChange ID: stable-change\nCommit ID: first",
  );
  expect(within(details).getByText("subject first")).toBeInTheDocument();
  expect(within(details).getByText("Merge of parent-a, parent-b")).toBeInTheDocument();
  expect(within(details).getByText("remote@origin")).toBeInTheDocument();
  expect(within(details).getByText("subject first")).toBeInTheDocument();
  expect(within(details).getByText(/日本語 full body/)).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  expect(within(details).getByText("subject second")).toBeInTheDocument();
  expect(within(details).queryByText(/None|Merge of/)).toBeNull();
  expect(within(details).queryByTitle(/bookmarks:|Tags:/)).toBeNull();
  expect(details.querySelector("dl")).toBeNull();
  expect(screen.queryByTitle("Revert Selected Changes")).toBeNull();
  expect(gitLog).not.toHaveBeenCalled();
  expect(useVcs.getState().available).toBe(false);
});

it("rejects stale root and refresh responses and resets pagination and selection synchronously", async () => {
  const old = deferred();
  const current = deferred();
  history.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  render(<JjToolWindow />);
  act(() => useVcs.setState({ repo: "/two" }));
  await act(async () => current.resolve(ok([commit("two")], { root: "/two", operation: "op", seen: ["two"] })));
  await act(async () => old.resolve(ok([commit("stale-one")])));
  expect(screen.queryByText("subject stale-one")).toBeNull();
  expect(within(screen.getByLabelText("Jujutsu change details")).getByText("subject two")).toBeInTheDocument();
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
  expect(screen.getByText("subject fresh")).toBeInTheDocument();
  expect(history).toHaveBeenLastCalledWith("/two", null);
});

it("loads more without conflating divergent commits sharing a change ID, preserves selection, and clears errors on reload", async () => {
  history
    .mockResolvedValueOnce(ok([commit("first")], { root: "/one", operation: "op", seen: ["first"] }))
    .mockResolvedValueOnce(ok([commit("divergent", { workingCopy: false })]));
  render(<JjToolWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() =>
    expect(screen.getAllByRole("option", { selected: false }).some((e) => e.textContent?.includes("divergent"))).toBe(
      true,
    ),
  );
  expect(screen.getByText("subject first")).toBeInTheDocument();
  expect(screen.getAllByRole("option").filter((e) => e.id.startsWith("jj-"))).toHaveLength(2);
  history.mockResolvedValueOnce({ status: "error", error: { message: "missing jj", kind: "unavailable" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("missing jj");
  expect(screen.queryByText("subject first")).toBeNull();
  history.mockResolvedValueOnce(ok([commit("recovered")]));
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  await screen.findByText("subject recovered");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("invalidates rows and pending requests when the CLI becomes unavailable or project changes", async () => {
  history.mockResolvedValueOnce(ok([commit("initial")]));
  render(<JjToolWindow />);
  await screen.findByText("subject initial");
  act(() => useVcs.setState({ jjRoots: [root("/one", "CLI removed")] }));
  expect(await screen.findByRole("alert")).toHaveTextContent("CLI removed");
  expect(screen.queryByText("subject initial")).toBeNull();
  expect(history).toHaveBeenCalledTimes(1);
  const old = deferred();
  history.mockReturnValueOnce(old.promise).mockResolvedValueOnce(ok([commit("new-project")]));
  act(() => useVcs.setState({ jjRoots: [root("/one")] }));
  act(() => useVcs.setState({ root: "/other-project" }));
  await screen.findByText("subject new-project");
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
      <JjTabs />
      <JjToolWindow />
    </>,
  );
  const gitTabs = within(screen.getByRole("tablist", { name: "Git" }));
  expect(gitTabs.getByRole("tab", { name: "Log" })).toHaveAttribute("aria-selected", "true");
  expect(gitTabs.getByRole("tab", { name: "Worktrees" })).toBeInTheDocument();
  expect(gitTabs.queryByRole("tab", { name: "Workspaces" })).toBeNull();
  expect(
    within(screen.getByRole("tablist", { name: "Jujutsu" })).getByRole("tab", { name: "Workspaces" }),
  ).toBeInTheDocument();
  await screen.findByText("subject mixed");
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
  const view = render(<JjToolWindow />);
  await screen.findByText("subject capabilities");
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
  render(<JjToolWindow />);
  expect(screen.getByRole("alert")).toHaveTextContent("missing CLI");
  expect(history).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
  await screen.findByText("subject restored-cli");
  expect(rootsRequest).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

const changed = (path: string, kind: FileStatus["unstaged"] = "modified"): FileStatus => ({
  path: `/one/${path}`,
  relPath: path,
  unstaged: kind,
  staged: null,
  renamedFrom: null,
});
const pair = {
  before: "historical parent",
  after: "historical after",
  beforeLabel: "parent exact",
  afterLabel: "commit exact",
};

it("renders a directory tree above metadata and activates historical read-only diffs by double click and Enter", async () => {
  history.mockResolvedValue(ok([commit("first")]));
  historyFiles.mockResolvedValue({ status: "ok", data: [changed("src/nested/a.ts"), changed("deleted", "deleted")] });
  historyDiff.mockResolvedValue({ status: "ok", data: pair });
  render(<JjToolWindow />);
  const file = await screen.findByText("a.ts");
  expect(screen.getByText("src/nested")).toBeInTheDocument();
  expect(screen.queryByText("unchanged")).toBeNull();
  expect(historyFiles).toHaveBeenCalledWith("/one", "first");
  fireEvent.mouseDown(file);
  expect(openInput).not.toHaveBeenCalled();
  fireEvent.doubleClick(file);
  await waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
  expect(historyDiff).toHaveBeenCalledWith("/one", "/one/src/nested/a.ts", "first");
  expect(openInput.mock.calls[0]![0].data).toEqual({
    path: "/one/src/nested/a.ts",
    left: { type: "text", text: pair.before, label: pair.beforeLabel, jjBlame: null },
    right: { type: "text", text: pair.after, label: pair.afterLabel, jjBlame: null },
  });
  fireEvent.mouseDown(screen.getByText("deleted"));
  fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
  await waitFor(() => expect(openInput).toHaveBeenCalledTimes(2));
  expect(historyDiff).toHaveBeenLastCalledWith("/one", "/one/deleted", "first");
  fireEvent.click(screen.getByRole("button", { name: "Collapse All" }));
  expect(screen.queryByText("a.ts")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
  expect(screen.getByText("a.ts")).toBeInTheDocument();
  expect(screen.queryByTitle("Revert Selected Changes")).toBeNull();
});

it("discards stale changed lists and file-open responses on commit/root/project/refresh transitions", async () => {
  history.mockResolvedValue(ok([commit("first"), commit("second")]));
  const oldFiles = deferred();
  historyFiles.mockReturnValueOnce(oldFiles.promise).mockResolvedValue({ status: "ok", data: [changed("current")] });
  render(<JjToolWindow />);
  await screen.findByText("subject first");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  await screen.findByText("current");
  await act(async () => oldFiles.resolve({ status: "ok", data: [changed("stale")] }));
  expect(screen.queryByText("stale")).toBeNull();
  for (const transition of ["commit", "root", "project", "refresh", "availability"]) {
    const pending = deferred();
    historyDiff.mockReturnValueOnce(pending.promise);
    fireEvent.doubleClick(await screen.findByText("current"));
    if (transition === "commit") fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
    else if (transition === "root") act(() => useVcs.setState({ repo: "/two" }));
    else if (transition === "project") act(() => useVcs.setState({ root: "/other-project" }));
    else if (transition === "availability") act(() => useVcs.setState({ jjRoots: [root("/two", "CLI unavailable")] }));
    else fireEvent.click(screen.getByRole("button", { name: "Refresh Jujutsu history" }));
    await act(async () => pending.resolve({ status: "ok", data: pair }));
    expect(openInput).not.toHaveBeenCalled();
  }
});

it("previews selections with the existing option and cancels deferred previews on change", async () => {
  useLogOptions.setState({ diffPreview: true });
  history.mockResolvedValue(ok([commit("first"), commit("second")]));
  historyFiles.mockResolvedValue({ status: "ok", data: [changed("preview")] });
  historyDiff.mockResolvedValue({ status: "ok", data: pair });
  render(<JjToolWindow />);
  fireEvent.mouseDown(await screen.findByText("preview"));
  await waitFor(() => expect(openInput).toHaveBeenCalledTimes(1));
  expect(openInput.mock.calls[0]![1]).toEqual({ preview: true, focus: false });
  openInput.mockClear();
  fireEvent.mouseDown(screen.getByText("preview"));
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 160)));
  expect(openInput).not.toHaveBeenCalled();
});

it("shows explicit list and content errors, then clears them with a fresh selected change", async () => {
  history.mockResolvedValue(ok([commit("first"), commit("second"), commit("third")]));
  historyFiles
    .mockResolvedValueOnce({ status: "error", error: { kind: "unavailable", message: "expired snapshot" } })
    .mockResolvedValueOnce({ status: "ok", data: [changed("binary")] })
    .mockResolvedValueOnce({ status: "ok", data: [] });
  historyDiff.mockResolvedValue({ status: "error", error: { kind: "unavailable", message: "Binary unsupported" } });
  render(<JjToolWindow />);
  expect(await screen.findByRole("alert")).toHaveTextContent("expired snapshot");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  fireEvent.doubleClick(await screen.findByText("binary"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Binary unsupported");
  expect(openInput).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  await screen.findByText("No changes");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("searches descriptions and full identities across pinned pages and clears without losing history", async () => {
  const later = deferred();
  const cursor = { root: "/one", operation: "op", seen: ["first"] };
  history.mockResolvedValueOnce(ok([commit("first")], cursor)).mockReturnValueOnce(later.promise);
  render(<JjToolWindow />);
  await screen.findByText("subject first");
  fireEvent.change(screen.getByPlaceholderText("Text or hash"), { target: { value: "deep body" } });
  await waitFor(() => expect(history).toHaveBeenLastCalledWith("/one", cursor));
  expect(screen.getByText("Searching history…")).toBeInTheDocument();
  expect(screen.queryByText("No matches")).toBeNull();
  await act(async () =>
    later.resolve(
      ok([
        commit("full-commit-identity", {
          description: "later subject\n\nDeep Body",
          changeId: "full-change-identity",
          workingCopy: false,
          localBookmarks: ["main"],
          remoteBookmarks: ["main@origin"],
          tags: ["v1"],
        }),
      ]),
    ),
  );
  expect(await screen.findByRole("option")).toHaveTextContent("later subject");
  expect(screen.getAllByText("origin & main")).toHaveLength(2);
  expect(screen.getAllByTitle("Tags: v1")).toHaveLength(2);
  for (const value of ["COMMIT-IDENTITY", "CHANGE-IDENTITY"]) {
    fireEvent.change(screen.getByPlaceholderText("Text or hash"), { target: { value } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
  }
  fireEvent.change(screen.getByPlaceholderText("Text or hash"), { target: { value: "absent" } });
  expect(screen.getByText("No matches")).toBeInTheDocument();
  expect(screen.queryByLabelText("Jujutsu change details")).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("Text or hash"), { target: { value: "" } });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(history).toHaveBeenCalledTimes(2);
});

it("copies the full change identity while preserving full descriptions and compact refs", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  try {
    history.mockResolvedValue(
      ok([
        commit("full-commit-identity", {
          changeId: "full-change-identity",
          parents: ["ordinary-parent"],
          tags: ["v1"],
        }),
      ]),
    );
    render(<JjToolWindow />);
    const button = await screen.findByRole("button", { name: "Copy Change ID" });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("full-change-identity");
    expect(button).toHaveTextContent("full-cha");
    expect(button.title).toContain("Commit ID: full-commit-identity");
    const details = screen.getByLabelText("Jujutsu change details");
    expect(within(details).getByText("subject full-commit-identity")).toBeInTheDocument();
    expect(within(details).getByText(/日本語 full body/).textContent).toBe("日本語 full body\n");
    expect(within(details).getByText(/Writer <a@example.com>/)).toBeInTheDocument();
    expect(within(details).getByTitle("Tags: v1")).toBeInTheDocument();
    expect(within(details).getByTitle("Local bookmarks: local")).toBeInTheDocument();
    expect(within(details).queryByText(/ordinary-parent|None|Merge of/)).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
