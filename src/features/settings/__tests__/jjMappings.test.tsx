import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings, stagedValue, useSettingsDialog } from "../model/staging";
import { PageContext } from "../components/context";
import { MappingsTable } from "../pages/vcs";

const mocks = vi.hoisted(() => ({ detected: vi.fn(), roots: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    commands: { ...actual.commands, vcsDetectedRoots: mocks.detected, vcsRoots: mocks.roots },
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    project: { root: "/repo", isGit: false } as never,
  });
  mocks.detected.mockResolvedValue({
    status: "ok",
    data: [
      { root: "/repo", kind: "jj" },
      { root: "/repo/git", kind: "git" },
    ],
  });
  mocks.roots.mockResolvedValue({
    status: "ok",
    data: [{ root: "/repo", kind: "jj", unavailableReason: "jj unavailable" }],
  });
  openSettings("vcs.mappings");
});

it("excludes and restores jj without offering to change ownership to Git", async () => {
  render(
    <PageContext.Provider value={{ pageId: "vcs.mappings", scope: "project" }}>
      <MappingsTable />
    </PageContext.Provider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "VCS of <Project>" })).toHaveTextContent("Jujutsu (jj)"),
  );
  expect(screen.getByRole("status")).toHaveTextContent("jj unavailable");
  fireEvent.click(screen.getByRole("button", { name: "VCS of <Project>" }));
  expect(screen.queryByRole("option", { name: "Git" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "<none>" }));
  expect(stagedValue(useSettingsDialog.getState(), "project", "vcs.mappings.excluded")).toEqual(["."]);
  const unregistered = screen.getByRole("row", { name: /<Project>.*Jujutsu/ });
  fireEvent.click(unregistered);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(stagedValue(useSettingsDialog.getState(), "project", "vcs.mappings.excluded")).toEqual([]);
  expect(screen.getByRole("button", { name: "VCS of git" })).toHaveTextContent("Git");
});

it("does not apply a previous project's late detection result", async () => {
  let finish!: (result: unknown) => void;
  mocks.detected.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { unmount } = render(<MappingsTable />);
  await act(async () => {
    useProject.setState({ project: { root: "/other", isGit: true } as never });
  });
  await act(async () => finish({ status: "ok", data: [{ root: "/stale", kind: "jj" }] }));
  expect(screen.queryByText("/stale")).toBeNull();
  unmount();
});
