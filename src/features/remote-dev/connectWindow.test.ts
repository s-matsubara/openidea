import { beforeEach, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { installConnectHandoff } from "./connectWindow";

const mock = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: { payload: unknown }) => void),
  open: vi.fn(),
  join: vi.fn(),
  emit: vi.fn(),
  off: vi.fn(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setFocus: async () => {},
    listen: async (_: string, handler: typeof mock.receive) => {
      mock.receive = handler;
      return mock.off;
    },
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mock.emit }));
vi.mock("@tauri-apps/api/window", () => ({ Window: { getByLabel: async () => ({}) } }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: { windowOpenRemote: mock.open, windowGroupJoin: mock.join },
}));
vi.mock("@/platform/remote", async (original) => ({
  ...(await original<typeof import("@/platform/remote")>()),
  isRemoteWindow: () => false,
}));
beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({
    project: { root: "/local" } as never,
    lightEdit: false,
    settings: { general: { openProjectIn: "tab" } } as never,
  });
  mock.open
    .mockResolvedValueOnce({ status: "ok", data: { kind: "current" } })
    .mockResolvedValueOnce({ status: "ok", data: { kind: "opened", label: "remote-1" } });
  mock.join.mockResolvedValue({ status: "ok", data: null });
  mock.emit.mockResolvedValue(undefined);
});
it.each([false, true])(
  "routes the separated Remote Development window through the parent's SSH tab policy (existing %s)",
  async (existing) => {
    if (existing)
      mock.open.mockReset().mockResolvedValue({ status: "ok", data: { kind: "focused", label: "existing" } });
    const off = installConnectHandoff();
    await waitFor(() => expect(mock.receive).toBeDefined());
    act(() =>
      mock.receive!({
        payload: { id: 1, from: "connect-main", target: { kind: "ssh", config: "dev" }, path: "/work/app" },
      }),
    );
    await waitFor(() =>
      expect(mock.emit).toHaveBeenCalledWith("connect-main", "openidea://connect/result", { id: 1, opened: true }),
    );
    if (existing) {
      expect(mock.open).toHaveBeenCalledTimes(1);
      expect(mock.join).not.toHaveBeenCalled();
    } else expect(mock.join).toHaveBeenCalledExactlyOnceWith("remote-1");
    off();
  },
);
