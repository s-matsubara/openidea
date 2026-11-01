/** Exercise project policy against the real editor close-session state machine. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorController, useTabs } from "@/editor/core/controller";
import { createMemoryBackend } from "@/editor/core/backend";
import { initialTabsState } from "@/editor/core/model/tabs";
import { useDocMeta } from "@/editor/core/model/document";
import { provideLeaveProjectGuard, useProject } from "@/platform/project";
import { provideProjectTrustPrompt } from "@/platform/projectTrust";
import { provideEditorService, provideNotificationService, registerEditorKind } from "@/workbench/contributions";
import { registerActions } from "@/platform/actions";
import { confirmLeave } from "../closeGuard";
import { openProjectWithPolicy } from "../windows";

const attach = vi.fn();
const open = vi.fn();
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      windowOpenProject: async () => ({ status: "ok", data: { kind: "current" } }),
      workspaceAttach: (...a: unknown[]) => attach(...a),
      openProject: (...a: unknown[]) => open(...a),
    },
  };
});
let ctrl: EditorController;
let dispose: Array<() => void>;
let text: string;
let saved: string;
let frozen: boolean;
const save = vi.fn();
const ask = vi.fn();
const trust = vi.fn();
const failure = vi.fn();
const notified = vi.fn();
const project = (root: string) => ({
  root,
  name: root,
  trusted: true,
  isGit: false,
  settings: { files: { autoSave: false }, general: { openProjectIn: "attach" } },
});
const policy = (mode: "same" | "attach") =>
  useProject.setState({ settings: { files: { autoSave: false }, general: { openProjectIn: mode } } as never });

beforeEach(async () => {
  localStorage.clear();
  useTabs.setState(initialTabsState(), true);
  useProject.setState({
    project: project("/project"),
    settings: project("/project").settings,
    lightEdit: false,
    opening: false,
  } as never);
  text = "edited";
  saved = "original";
  frozen = false;
  save.mockReset().mockImplementation(async () => {
    saved = text;
  });
  ask.mockReset().mockResolvedValue({ button: "save", checked: false });
  trust.mockReset().mockResolvedValue(true);
  failure.mockReset();
  notified.mockReset();
  attach.mockReset().mockResolvedValue({ status: "ok", data: "/workspace" });
  open.mockReset().mockImplementation(async (path: string) => ({ status: "ok", data: project(path) }));
  dispose = [
    registerEditorKind({
      kind: "project-close-test",
      component: () => null,
      title: () => "Test document",
      document: {
        isDirty: () => text !== saved,
        flush: async () => {},
        save,
        prepareClose: async () => {
          frozen = true;
        },
        cancelClose: () => {
          frozen = false;
        },
        discard: async () => {
          text = saved;
        },
        close: async () => {},
      },
    }),
    provideProjectTrustPrompt(trust),
    registerActions([{ id: "project.reveal", title: "Reveal", run: () => {} }]),
  ];
  ctrl = new EditorController(createMemoryBackend());
  ctrl.start();
  provideEditorService({
    openFile: (p, o) => ctrl.openFile(p, o),
    openInput: (i, o) => ctrl.openInput(i, o),
    activePath: () => ctrl.activePath(),
    activeCursor: () => ctrl.activeCursor(),
    saveAll: () => ctrl.saveAll(),
    prepareClose: () => ctrl.prepareClose(),
    cancelClose: () => ctrl.cancelClose(),
  });
  provideNotificationService({ notify: notified });
  dispose.push(
    provideLeaveProjectGuard(() =>
      confirmLeave({
        ask,
        saveAll: () => ctrl.saveAll(),
        prepareClose: () => ctrl.prepareClose(),
        disableConfirmExit: async () => {},
        onSaveFailed: failure,
      }),
    ),
  );
  await ctrl.openInput({ kind: "project-close-test", key: "document", path: "/project/test" }, { focus: false });
});
afterEach(() => {
  ctrl.stop();
  dispose.reverse().forEach((off) => off());
  useTabs.setState(initialTabsState(), true);
  useDocMeta.setState({}, true);
  useProject.setState({ project: null, settings: null, opening: false });
  localStorage.clear();
});

it("releases the close decision when same-window trust is cancelled, allowing an Attach retry", async () => {
  policy("same");
  trust.mockResolvedValueOnce(false);
  await openProjectWithPolicy("/other");
  expect(useProject.getState().project?.root).toBe("/project");
  expect(saved).toBe("edited");
  const frozenAfterCancellation = frozen;
  policy("attach");
  await openProjectWithPolicy("/other");
  expect(failure).not.toHaveBeenCalled();
  expect(frozenAfterCancellation).toBe(false);
  expect(attach).toHaveBeenCalledWith("/other");
  expect(useProject.getState().project?.root).toBe("/workspace");
});

it.each(["attach", "trust", "open"])("releases a failed %s transition and permits a safe retry", async (stage) => {
  if (stage === "attach") attach.mockRejectedValueOnce(new Error("attach failed"));
  if (stage === "trust") trust.mockResolvedValueOnce(false);
  if (stage === "open") open.mockRejectedValueOnce(new Error("open failed"));
  await openProjectWithPolicy("/other");
  expect(useProject.getState().project?.root).toBe("/project");
  expect(text).toBe("edited");
  expect(saved).toBe("edited");
  expect(frozen).toBe(false);
  await openProjectWithPolicy("/other");
  expect(useProject.getState().project?.root).toBe("/workspace");
  expect(failure).not.toHaveBeenCalled();
});

it("keeps dirty content when the unsaved-changes decision cancels Attach", async () => {
  ask.mockResolvedValueOnce({ button: "cancel", checked: false });
  await openProjectWithPolicy("/other");
  expect(attach).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(text).toBe("edited");
  expect(saved).toBe("original");
  expect(frozen).toBe(false);
  await openProjectWithPolicy("/other");
  expect(save).toHaveBeenCalledOnce();
  expect(saved).toBe("edited");
  expect(useProject.getState().project?.root).toBe("/workspace");
});
