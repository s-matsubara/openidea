import { beforeEach, expect, it, vi } from "vitest";
import { confirmLeaveProject, useProject } from "@/platform/project";
import { chooseProjectWindow, openPolicy, openRemoteProject } from "./projectWindow";
import { ask } from "./messages";
import { commands } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";

vi.mock("@/platform/project", async (original) => ({
  ...(await original<typeof import("@/platform/project")>()),
  confirmLeaveProject: vi.fn(async () => true),
}));
vi.mock("./messages", () => ({ ask: vi.fn() }));
vi.mock("@/platform/remote", () => ({
  isRemoteWindow: vi.fn(() => false),
  connectRemote: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  commands: {
    windowOpenRemote: vi.fn(async () => ({ kind: "current", label: "" })),
    windowGroupJoin: vi.fn(async () => undefined),
    settingsSet: vi.fn(async () => ({ general: { openProjectIn: "attach" } })),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isRemoteWindow).mockReturnValue(false);
  vi.mocked(commands.windowOpenRemote)
    .mockReset()
    .mockResolvedValue({ kind: "current" } as never);
  useProject.setState({
    project: { root: "/a", name: "A", settings: {}, trusted: true, isGit: false },
    settings: {},
    lightEdit: false,
  });
});
it("offers attach for this open without remembering it", async () => {
  const button = "attach";
  vi.mocked(ask).mockResolvedValue({ button, checked: true });
  expect(await chooseProjectWindow("B")).toBe(button);
  const prompt = vi.mocked(ask).mock.calls[0]![0];
  expect(prompt.buttons.map((b) => b.id)).toEqual(["cancel", "attach", "tab", "new", "same"]);
  expect(prompt.buttons.filter((b) => b.primary).map((b) => b.id)).toEqual(["same"]);
  expect(commands.settingsSet).not.toHaveBeenCalled();
  expect(openPolicy()).toBe("ask");
  expect(await chooseProjectWindow("C")).toBe(button);
  expect(ask).toHaveBeenCalledTimes(2);
});
it("does not attach without a project or when opening a remote project", async () => {
  useProject.setState({
    settings: { general: { openProjectIn: "attach" } } as never,
  });
  vi.mocked(ask).mockResolvedValue({ button: "cancel", checked: false });
  expect(await chooseProjectWindow("remote", false)).toBeNull();
  expect(vi.mocked(ask).mock.calls[0]![0].buttons.map((b) => b.id)).toEqual(["cancel", "new", "same"]);
  useProject.setState({ project: null });
  expect(await chooseProjectWindow("B")).toBe("same");
});

it("treats a stored attach policy as ask", () => {
  useProject.setState({ settings: { general: { openProjectIn: "attach" } } } as never);
  expect(openPolicy()).toBe("ask");
});
it.each(["new", "same", "tab"] as const)("remembers %s", async (mode) => {
  vi.mocked(ask).mockResolvedValue({ button: mode, checked: true });
  await chooseProjectWindow("B");
  expect(commands.settingsSet).toHaveBeenCalledWith("global", "general.openProjectIn", JSON.stringify(mode));
});

it("opens a project tab by policy, or a new window when this one can't take one", async () => {
  useProject.setState({ settings: { general: { openProjectIn: "tab" } } } as never);
  expect(openPolicy()).toBe("tab");
  expect(await chooseProjectWindow("B")).toBe("tab");
  expect(await chooseProjectWindow("remote", false)).toBe("new");
  useProject.setState({ project: null, lightEdit: true });
  expect(await chooseProjectWindow("B")).toBe("new");
  expect(ask).not.toHaveBeenCalled();
});

const ssh = { kind: "ssh", config: "dev" } as const;
it.each([false, true])("joins only a newly opened SSH project (saved policy: %s)", async (saved) => {
  if (saved) useProject.setState({ settings: { general: { openProjectIn: "tab" } } } as never);
  else vi.mocked(ask).mockResolvedValue({ button: "tab", checked: true });
  vi.mocked(commands.windowOpenRemote)
    .mockResolvedValueOnce({ kind: "current" } as never)
    .mockResolvedValueOnce({ kind: "opened", label: "ssh-1" } as never);
  expect(await openRemoteProject(ssh, "/work/project")).toBe(true);
  expect(commands.windowOpenRemote).toHaveBeenNthCalledWith(1, ssh, "/work/project", false);
  expect(commands.windowOpenRemote).toHaveBeenNthCalledWith(2, ssh, "/work/project", true);
  expect(commands.windowGroupJoin).toHaveBeenCalledExactlyOnceWith("ssh-1");
  if (saved) expect(ask).not.toHaveBeenCalled();
  else {
    expect(vi.mocked(ask).mock.calls[0]![0].buttons.map((b) => b.id)).toEqual(["cancel", "tab", "new", "same"]);
    expect(commands.settingsSet).toHaveBeenCalledWith("global", "general.openProjectIn", '"tab"');
  }
});
it("focuses existing SSH without creating or regrouping it", async () => {
  vi.mocked(commands.windowOpenRemote).mockResolvedValue({ kind: "focused", label: "existing" } as never);
  expect(await openRemoteProject(ssh, "/work/project")).toBe(true);
  expect(commands.windowOpenRemote).toHaveBeenCalledTimes(1);
  expect(commands.windowGroupJoin).not.toHaveBeenCalled();
  expect(ask).not.toHaveBeenCalled();
});
it("does not regroup SSH opened by another request while the dialog was open", async () => {
  vi.mocked(ask).mockResolvedValue({ button: "tab", checked: false });
  vi.mocked(commands.windowOpenRemote)
    .mockResolvedValueOnce({ kind: "current" } as never)
    .mockResolvedValueOnce({ kind: "focused", label: "existing" } as never);
  expect(await openRemoteProject(ssh, "/work/project")).toBe(true);
  expect(commands.windowGroupJoin).not.toHaveBeenCalled();
});
it.each(["light", "remote", "wsl", "new"])("preserves the new-window route for %s", async (kind) => {
  useProject.setState({ settings: { general: { openProjectIn: kind === "new" ? "new" : "tab" } } } as never);
  if (kind === "light") useProject.setState({ project: null, lightEdit: true });
  if (kind === "remote") vi.mocked(isRemoteWindow).mockReturnValue(true);
  const target = kind === "wsl" ? ({ kind: "wsl", distro: "Ubuntu" } as const) : ssh;
  vi.mocked(commands.windowOpenRemote)
    .mockResolvedValueOnce({ kind: "current" } as never)
    .mockResolvedValueOnce({ kind: "opened", label: "new" } as never);
  expect(await openRemoteProject(target, "/work/project")).toBe(true);
  expect(commands.windowOpenRemote).toHaveBeenNthCalledWith(2, target, "/work/project", true);
  expect(commands.windowGroupJoin).not.toHaveBeenCalled();
});
it("keeps an empty window eligible for opening here with a saved tab policy", async () => {
  useProject.setState({ project: null, lightEdit: false, settings: { general: { openProjectIn: "tab" } } } as never);
  expect(await chooseProjectWindow("SSH", false, true)).toBe("same");
  expect(ask).not.toHaveBeenCalled();
});
it("propagates SSH group-join failure without creating a second window", async () => {
  vi.mocked(ask).mockResolvedValue({ button: "tab", checked: false });
  vi.mocked(commands.windowOpenRemote)
    .mockResolvedValueOnce({ kind: "current" } as never)
    .mockResolvedValueOnce({ kind: "opened", label: "ssh-1" } as never);
  vi.mocked(commands.windowGroupJoin).mockRejectedValueOnce(new Error("Window closed"));
  await expect(openRemoteProject(ssh, "/work/project")).rejects.toThrow("Window closed");
  expect(commands.windowOpenRemote).toHaveBeenCalledTimes(2);
});

it("opens a new SSH connection in the empty window without creating a tab", async () => {
  useProject.setState({ project: null, lightEdit: false, settings: { general: { openProjectIn: "tab" } } } as never);
  const here = vi.fn();
  expect(await openRemoteProject(ssh, "/work/project", here)).toBe(true);
  expect(here).toHaveBeenCalledOnce();
  expect(confirmLeaveProject).toHaveBeenCalledWith(false);
  expect(commands.windowOpenRemote).toHaveBeenCalledTimes(1);
  expect(commands.windowGroupJoin).not.toHaveBeenCalled();
});
it("cancels the SSH placement dialog without opening a window", async () => {
  vi.mocked(ask).mockResolvedValue({ button: "cancel", checked: false });
  expect(await openRemoteProject(ssh, "/work/project")).toBe(false);
  expect(commands.windowOpenRemote).toHaveBeenCalledTimes(1);
  expect(commands.windowGroupJoin).not.toHaveBeenCalled();
});
