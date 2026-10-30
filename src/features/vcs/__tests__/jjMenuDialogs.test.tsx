import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { showJjRemoteDialog } from "../jjMenuDialogs";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({
  fetchOptions: vi.fn(),
  fetch: vi.fn(),
  rebaseOptions: vi.fn(),
  rebase: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ saveAll: mocks.save }),
  notifications: () => ({ notify: vi.fn() }),
}));
vi.mock("../store", async (original) => ({
  ...(await original<typeof import("../store")>()),
  refreshNow: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      vcsJjFetchOptions: mocks.fetchOptions,
      vcsJjFetchSelected: mocks.fetch,
      vcsJjRebaseOptions: mocks.rebaseOptions,
      vcsJjRebase: mocks.rebase,
    },
  };
});

const ok = (data: unknown) => ({ status: "ok", data });
const source = { commitId: "source", label: "fork-start", kind: "bookmark", remote: null };
const tag = { commitId: "tag", label: "v0.1.33@upstream", kind: "tag", remote: "upstream" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetchOptions.mockResolvedValue(
    ok({ remotes: ["origin", "upstream"], tags: [{ name: "v0.1.33", remote: "upstream" }] }),
  );
  mocks.rebaseOptions.mockResolvedValue(
    ok({ source, destinations: [source, tag], preferred: "trunk", trunkLabel: "main@origin" }),
  );
  mocks.fetch.mockResolvedValue(ok(""));
  mocks.rebase.mockResolvedValue(ok(""));
  useVcs.setState({
    available: false,
    root: "/project",
    remoteBusy: null,
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

function open(kind: "fetch" | "rebase") {
  showJjRemoteDialog(kind, (show) => render(show(vi.fn())));
}

it("fetches the selected remote with Tag off and excludes Git repositories", async () => {
  useVcs.setState({ available: true, roots: ["/git"], repo: "/git" });
  open("fetch");
  await screen.findByText("origin");
  expect(screen.queryByLabelText("Repository")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Tag")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith("/project", "origin", null));
});

it("submits an explicit upstream tag without requesting bookmarks", async () => {
  open("fetch");
  await screen.findByText("origin");
  fireEvent.click(screen.getByLabelText("Remote"));
  fireEvent.click(await screen.findByRole("option", { name: "upstream" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Tags only" }));
  fireEvent.click(screen.getByLabelText("Tag"));
  fireEvent.click(await screen.findByRole("option", { name: "v0.1.33" }));
  fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith("/project", "upstream", "v0.1.33"));
});

it("defaults to the working-copy series, trunk and skipping emptied changes", async () => {
  open("rebase");
  await screen.findByText("trunk() → main@origin");
  fireEvent.click(screen.getByRole("button", { name: "Rebase" }));
  await waitFor(() => expect(mocks.rebase).toHaveBeenCalledWith("/project", null, "trunk", true, false));
});

it("submits a specific source and remote tag with explicit immutable override", async () => {
  open("rebase");
  await screen.findByText("trunk() → main@origin");
  fireEvent.click(screen.getByLabelText("Rebase source"));
  fireEvent.click(await screen.findByRole("option", { name: /fork-start/ }));
  fireEvent.click(screen.getByLabelText("Rebase destination"));
  fireEvent.click(await screen.findByRole("option", { name: /v0.1.33@upstream/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Skip changes emptied by rebase" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Ignore immutable protection for this rebase" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rebase" })));
  expect(mocks.rebase).toHaveBeenCalledWith("/project", "source", "tag", false, true);
});

it("uses the wildcard when Tags only is checked without choosing a specific tag", async () => {
  open("fetch");
  await screen.findByText("origin");
  fireEvent.click(screen.getByRole("checkbox", { name: "Tags only" }));
  fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith("/project", "origin", "*"));
});

it("stops rebase if trunk moves after the dialog opens", async () => {
  open("rebase");
  await screen.findByText("trunk() → main@origin");
  mocks.rebaseOptions.mockResolvedValue(
    ok({
      source,
      destinations: [source, tag],
      preferred: "moved",
      trunkLabel: "main@origin",
    }),
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rebase" })));
  expect(mocks.rebase).not.toHaveBeenCalled();
  expect(useVcs.getState().remoteBusy).toBeNull();
});
