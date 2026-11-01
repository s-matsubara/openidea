import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JjPushDialog } from "../jjPush";
import { showPushDialog } from "../remoteUi";
import { setContext } from "@/platform/context";
import { useVcs } from "../store";
const dialogs = vi.fn();
vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  openDialog: (...args: unknown[]) => dialogs(...args),
}));
const options = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsJjPushOptions: (...a: unknown[]) => options(...a),
      vcsJjPush: (...a: unknown[]) => push(...a),
      vcsRemotes: () => Promise.resolve(ok([{ name: "origin" }])),
      vcsLog: () =>
        Promise.resolve(
          ok([{ id: "git-id", shortId: "git-id", summary: "Git outgoing subject", author: "Git Author", timeMs: 0 }]),
        ),
    },
  };
});
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  refreshNow: () => refresh(),
}));
// Keep selector interaction independent of the custom popup's keyboard implementation.
vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  Select: ({
    options,
    onChange,
    value,
    ...props
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    value: string;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <select {...props} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" />
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
const ok = (data: unknown) => ({ status: "ok", data });
const root = (path: string) => ({
  root: path,
  kind: "jj" as const,
  unavailableReason: null,
  workingCopy: null,
  operation: null,
  head: null,
  headCommit: null,
});

const preview = (token = "review-token", summary = "reviewed outgoing refs") => ({
  summary,
  token,
  commits: [{ id: "abcdef123456", description: "Relevant subject", author: "Author", timeMs: "0" }],
});
beforeEach(() => {
  options
    .mockReset()
    .mockResolvedValue(ok({ bookmarks: ["feature", "other"], tags: ["v1", "v2"], remotes: ["origin", "other"] }));
  push.mockReset().mockImplementation(() => Promise.resolve(ok(preview())));
  refresh.mockReset().mockResolvedValue(undefined);
  useVcs.setState({ root: "/project", repo: null, remoteBusy: null, jjRoots: [root("/jj")] });
});
async function chooseBookmark(name = "feature") {
  await screen.findByRole("option", { name: "feature" });
  fireEvent.change(screen.getByLabelText("Bookmark to push"), { target: { value: name } });
}
it("auto-loads preview on the Git Push layout with no single-root selector or Review button", async () => {
  const close = vi.fn();
  render(<JjPushDialog onClose={close} />);
  expect(screen.queryByLabelText("Jujutsu repository")).toBeNull();
  expect(screen.queryByRole("button", { name: "Review Push" })).toBeNull();
  expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
  await chooseBookmark();
  await screen.findByLabelText("Outgoing references");
  expect(screen.getByText("Relevant subject")).toBeInTheDocument();
  expect(screen.getByText(/Selected reference history \(up to 100 commits\)/)).toBeInTheDocument();
  expect(push).toHaveBeenLastCalledWith("/jj", {
    bookmarks: ["feature"],
    tags: [],
    allTags: false,
    remote: "origin",
    review: null,
  });
  act(() => useVcs.setState({ repo: "/elsewhere" }));
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(push).toHaveBeenLastCalledWith("/jj", {
    bookmarks: ["feature"],
    tags: [],
    allTags: false,
    remote: "origin",
    review: "review-token",
  });
});
it("supports tag-only and combined selections independently", async () => {
  render(<JjPushDialog onClose={vi.fn()} />);
  await screen.findByRole("option", { name: "v1" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Push tags:" }));
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith("/jj", {
      bookmarks: [],
      tags: [],
      allTags: true,
      remote: "origin",
      review: null,
    }),
  );
  fireEvent.change(screen.getByLabelText("Tags to push"), { target: { value: "tag:v1" } });
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith("/jj", {
      bookmarks: [],
      tags: ["v1"],
      allTags: false,
      remote: "origin",
      review: null,
    }),
  );
  await screen.findByLabelText("Outgoing references");
  await chooseBookmark();
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith("/jj", {
      bookmarks: ["feature"],
      tags: ["v1"],
      allTags: false,
      remote: "origin",
      review: null,
    }),
  );
  await screen.findByLabelText("Outgoing references");
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith("/jj", {
      bookmarks: ["feature"],
      tags: ["v1"],
      allTags: false,
      remote: "origin",
      review: "review-token",
    }),
  );
});
it.each(["bookmark", "remote", "tag"])("discards stale asynchronous preview when %s changes", async (kind) => {
  let finish!: (value: unknown) => void;
  push.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<JjPushDialog onClose={vi.fn()} />);
  await chooseBookmark();
  await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  if (kind === "bookmark") fireEvent.change(screen.getByLabelText("Bookmark to push"), { target: { value: "other" } });
  if (kind === "remote") fireEvent.change(screen.getByLabelText("Remote"), { target: { value: "other" } });
  if (kind === "tag") {
    fireEvent.click(screen.getByRole("checkbox", { name: "Push tags:" }));
    fireEvent.change(screen.getByLabelText("Tags to push"), { target: { value: "tag:v2" } });
  }
  await screen.findByLabelText("Outgoing references");
  await act(async () => finish(ok(preview("stale-token", "obsolete preview"))));
  expect(screen.queryByText("obsolete preview")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  await waitFor(() => expect(push.mock.calls.at(-1)?.[1].review).toBe("review-token"));
});
it.each(["root", "project"])("drops stale preview on %s change", async (kind) => {
  let finish!: (value: unknown) => void;
  push.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  useVcs.setState({ jjRoots: [root("/jj"), root("/second")] });
  render(<JjPushDialog onClose={vi.fn()} />);
  await chooseBookmark();
  await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
  if (kind === "root") fireEvent.change(screen.getByLabelText("Jujutsu repository"), { target: { value: "/second" } });
  else act(() => useVcs.setState({ root: "/new", jjRoots: [root("/new")] }));
  await act(async () => finish(ok(preview("stale-token", "obsolete preview"))));
  expect(screen.queryByLabelText("Outgoing references")).toBeNull();
  expect(screen.queryByText("obsolete preview")).toBeNull();
  expect(push).toHaveBeenCalledOnce();
});
it("reloads stale preview after execution error without retrying Push", async () => {
  render(<JjPushDialog onClose={vi.fn()} />);
  await chooseBookmark();
  await screen.findByLabelText("Outgoing references");
  push.mockRejectedValueOnce(new Error("Push changed; refresh and review again"));
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Push changed");
  await waitFor(() => expect(push).toHaveBeenCalledTimes(3));
  expect(push.mock.calls[2]![1].review).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Push" })).not.toBeDisabled());
  expect(screen.getByRole("alert")).toHaveTextContent("Push changed");
});
it("routes jj generic Push and retains explicit Git targets, header, commit rows and footer", async () => {
  dialogs.mockReset();
  useVcs.setState({
    available: true,
    roots: ["/git"],
    repo: "/git",
    branch: { head: "main", headCommit: null, upstream: "origin/main", ahead: 1, behind: 0, operation: null },
    branches: [],
  });
  setContext("vcsJjPath", true);
  await showPushDialog();
  expect(dialogs.mock.calls.at(-1)![0](() => {}).type).toBe(JjPushDialog);
  await showPushDialog({ branch: "main" });
  const git = dialogs.mock.calls.at(-1)![0](() => {});
  expect(git.type.name).toBe("PushDialog");
  render(git);
  expect(await screen.findByText("Git outgoing subject")).toBeInTheDocument();
  expect(screen.getByLabelText("Target branch")).toHaveValue("main");
  expect(screen.getByRole("checkbox", { name: "Force (with lease)" })).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Push tags:" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Push" })).not.toBeDisabled();
  setContext("vcsJjPath", false);
  await showPushDialog();
  expect(dialogs.mock.calls.at(-1)![0](() => {}).type.name).toBe("PushDialog");
  useVcs.setState({ available: false, roots: [] });
  await showPushDialog();
  expect(dialogs.mock.calls.at(-1)![0](() => {}).type).toBe(JjPushDialog);
});

it("defaults tags to All while off, and keeps a literal all tag distinct", async () => {
  options.mockResolvedValueOnce(ok({ bookmarks: ["feature"], tags: ["all", "v1"], remotes: ["origin"] }));
  render(<JjPushDialog onClose={vi.fn()} />);
  await screen.findByRole("option", { name: "feature" });
  expect(screen.getByRole("checkbox", { name: "Push tags:" })).not.toBeChecked();
  expect(screen.getByLabelText("Tags to push")).toHaveValue("all");
  expect(screen.queryByLabelText("Remote")).toBeNull();
  expect(push).not.toHaveBeenCalled();
  await chooseBookmark();
  await screen.findByLabelText("Outgoing references");
  fireEvent.click(screen.getByRole("checkbox", { name: "Push tags:" }));
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith("/jj", {
      bookmarks: ["feature"],
      tags: [],
      allTags: true,
      remote: "origin",
      review: null,
    }),
  );
  fireEvent.change(screen.getByLabelText("Tags to push"), { target: { value: "tag:all" } });
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith("/jj", {
      bookmarks: ["feature"],
      tags: ["all"],
      allTags: false,
      remote: "origin",
      review: null,
    }),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Push tags:" }));
  await waitFor(() =>
    expect(push).toHaveBeenLastCalledWith("/jj", {
      bookmarks: ["feature"],
      tags: [],
      allTags: false,
      remote: "origin",
      review: null,
    }),
  );
});

it("does not reactivate cached A preview during A to B to A selection", async () => {
  render(<JjPushDialog onClose={vi.fn()} />);
  await chooseBookmark();
  await screen.findByLabelText("Outgoing references");
  let finish!: (value: unknown) => void;
  push.mockReturnValueOnce(new Promise(() => {}));
  push.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await chooseBookmark("other");
  await chooseBookmark("feature");
  expect(screen.queryByLabelText("Outgoing references")).toBeNull();
  expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
  await act(async () => finish(ok(preview("fresh-token"))));
  await waitFor(() => expect(screen.getByRole("button", { name: "Push" })).not.toBeDisabled());
});

it("allows selected reference updates with no missing commit history", async () => {
  push.mockResolvedValueOnce(ok({ ...preview(), commits: [] }));
  render(<JjPushDialog onClose={vi.fn()} />);
  await chooseBookmark();
  await screen.findByLabelText("Outgoing references");
  expect(screen.getByText("No commits")).toBeInTheDocument();
  expect(screen.queryByText("Select a bookmark or tag to push")).toBeNull();
  expect(screen.getByRole("button", { name: "Push" })).not.toBeDisabled();
});
