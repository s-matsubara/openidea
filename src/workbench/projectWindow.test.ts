import { beforeEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { chooseProjectWindow, openPolicy, openRemoteProject } from "./projectWindow";
import { ask } from "./messages";
import { commands } from "@/platform/ipc";
import { isMacHost } from "@/platform/keymap";

vi.mock("./messages", () => ({ ask: vi.fn() }));
vi.mock("@/platform/keymap", () => ({ isMacHost: vi.fn() }));
vi.mock("@/platform/remote", () => ({
  isRemoteWindow: () => false,
  connectRemote: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  commands: {
    settingsSet: vi.fn(async () => ({ general: { openProjectIn: "attach" } })),
    windowOpenRemote: vi.fn(async () => ({ kind: "current" })),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isMacHost).mockReturnValue(false);
  useProject.setState({
    project: { root: "/a", name: "A", settings: {}, trusted: true, isGit: false },
    settings: {},
    lightEdit: false,
  });
});
it("offers Attach for this open without remembering it", async () => {
  vi.mocked(ask).mockResolvedValue({ button: "attach", checked: true });
  expect(await chooseProjectWindow("B")).toBe("attach");
  const prompt = vi.mocked(ask).mock.calls[0]![0];
  expect(prompt.buttons.map((b) => b.id)).toEqual(["cancel", "attach", "new", "same"]);
  expect(prompt.buttons.filter((b) => b.primary).map((b) => b.id)).toEqual(["same"]);
  expect(commands.settingsSet).not.toHaveBeenCalled();
  expect(openPolicy()).toBe("ask");
  expect(await chooseProjectWindow("C")).toBe("attach");
  expect(ask).toHaveBeenCalledTimes(2);
});
it("does not attach without a project or when opening a remote project", async () => {
  useProject.setState({
    settings: { general: { openProjectIn: "attach" } } as never,
  });
  vi.mocked(ask).mockResolvedValue({ button: "cancel", checked: false });
  expect(await chooseProjectWindow("remote", false)).toBeNull();
  expect(vi.mocked(ask).mock.calls[0]![0].buttons.map((b) => b.id)).not.toContain("attach");
  useProject.setState({ project: null });
  expect(await chooseProjectWindow("B")).toBe("same");
});

it("treats a stored attach policy as ask", () => {
  useProject.setState({ settings: { general: { openProjectIn: "attach" } } } as never);
  expect(openPolicy()).toBe("ask");
});
it.each(["new", "same"] as const)("remembers %s", async (mode) => {
  vi.mocked(ask).mockResolvedValue({ button: mode, checked: true });
  await chooseProjectWindow("B");
  expect(commands.settingsSet).toHaveBeenCalledWith("global", "general.openProjectIn", JSON.stringify(mode));
});

it("offers and remembers New Tab on macOS", async () => {
  vi.mocked(isMacHost).mockReturnValue(true);
  vi.mocked(ask).mockResolvedValue({ button: "tab", checked: true });
  expect(await chooseProjectWindow("B")).toBe("tab");
  expect(vi.mocked(ask).mock.calls[0]![0].buttons).toContainEqual({ id: "tab", label: "New Tab" });
  expect(commands.settingsSet).toHaveBeenCalledWith("global", "general.openProjectIn", '"tab"');
});

it("uses a saved tab policy when opening a remote project on macOS", async () => {
  vi.mocked(isMacHost).mockReturnValue(true);
  useProject.setState({ settings: { general: { openProjectIn: "tab" } } } as never);
  const target = { kind: "ssh", config: "dev" } as const;
  expect(await openRemoteProject(target, "/work/project")).toBe(true);
  expect(commands.windowOpenRemote).toHaveBeenNthCalledWith(1, target, "/work/project", "same");
  expect(commands.windowOpenRemote).toHaveBeenNthCalledWith(2, target, "/work/project", "tab");
  expect(ask).not.toHaveBeenCalled();
});

it("asks for another placement when a saved tab policy cannot apply", async () => {
  useProject.setState({ settings: { general: { openProjectIn: "tab" } } } as never);
  expect(openPolicy()).toBe("ask");
  vi.mocked(isMacHost).mockReturnValue(true);
  useProject.setState({ project: null, lightEdit: true });
  vi.mocked(ask).mockResolvedValue({ button: "cancel", checked: false });
  expect(await chooseProjectWindow("B")).toBeNull();
  expect(vi.mocked(ask).mock.calls[0]![0].buttons.map((b) => b.id)).toEqual(["cancel", "new", "same"]);
});
