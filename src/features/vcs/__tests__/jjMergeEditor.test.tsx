import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { ChangeSet } from "@codemirror/state";
import { createMemoryBackend } from "@/editor/core/backend";
import { DocumentManager, useDocMeta } from "@/editor/core/model/document";
import { attachDocument as attachManagedDocument } from "@/editor/core/model/attachment";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { executeAction, registerAction } from "@/platform/actions";
import { _resetLanguages } from "@/editor/core/cm/languages";
let manager: DocumentManager;
let uninstallKeys: () => void;
let unregisterSave: () => void;
import { MergeEditor } from "../MergeEditor";
import { mergeInput } from "../mergeKind";
import { jjConflicts } from "../jjConflicts";
import { registerMergeActions } from "../mergeActions";
let unregisterMerge: () => void;

// The working file uses jj's default diff style; two separated conflicts.
const conflict = (n: number) => `<<<<<<< conflict ${n} of 2
%%%%%%% diff from: base
\\\\\\\\\\\\\\        to: left
-old${n}
+left${n}
+++++++ right
right${n}
>>>>>>> conflict ${n} of 2 ends
`;
let working = "";
let saved = "";
const save = vi.fn(async () => {
  saved = working;
});
const stage = vi.fn();
const write = vi.fn();
const closeInput = vi.fn();
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: {
    ...(await original<typeof import("@/platform/ipc")>()).commands,
    vcsConflictVersions: async () => ({
      status: "ok",
      data: {
        ours: "left",
        theirs: "right",
        base: "base",
        merged: "<<<<<<< ours\nleft\n||||||| base\nbase\n=======\nright\n>>>>>>> theirs\n",
        sides: { reversed: false, operation: null, branch: null, commit: null, otherBranch: null },
      },
    }),
    vcsStage: (...args: unknown[]) => stage(...args),
  },
}));
vi.mock("../cm", async (original) => ({ ...(await original<typeof import("../cm")>()), languageFor: async () => [] }));
vi.mock("../ops", async (original) => ({
  ...(await original<typeof import("../ops")>()),
  readWorkingText: async () => working,
  writeFileText: (...args: unknown[]) => write(...args),
  runOp: async (_title: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../store", async (original) => ({ ...(await original<typeof import("../store")>()), refreshNow: vi.fn() }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ closeInput }),
}));
vi.mock("@/editor/api", async (original) => ({
  ...(await original<typeof import("@/editor/api")>()),
  attachDocument: async (path: string) => {
    const attachment = await attachManagedDocument(manager, path);
    return {
      ...attachment,
      extension: [
        attachment.extension,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) working = u.state.doc.toString();
        }),
      ],
    };
  },
}));
beforeEach(async () => {
  working = "unsaved user edit\n" + conflict(1) + "common\n" + conflict(2);
  _resetLanguages();
  manager = new DocumentManager(
    createMemoryBackend({ "/jj/a.txt": conflict(1) + "common\n" + conflict(2) }),
    { settings: () => ({}), notify: vi.fn() },
    (fn) => {
      queueMicrotask(fn);
    },
  );
  manager.start();
  const model = await manager.acquire("/jj/a.txt");
  model.onLocal(ChangeSet.of({ from: 0, insert: "unsaved user edit\n" }, model.sync.localText.length), {
    applyExternal() {},
  });
  unregisterSave = registerAction({
    id: "file.save",
    title: "Save All",
    run: async () => {
      await manager.saveAll("explicit");
      await save();
    },
  });
  useKeymap.setState({ overrides: { "file.save": ["Meta+S", "Ctrl+S"] } });
  uninstallKeys = installKeyboardDispatcher(window);
  unregisterMerge = registerMergeActions();
  saved = "disk unchanged";
  vi.clearAllMocks();
  stage.mockResolvedValue({ status: "ok", data: null });
});

afterEach(() => {
  uninstallKeys();
  unregisterSave();
  unregisterMerge();
  manager.stop();
  useDocMeta.setState({}, true);
});

it("keeps the unsaved live buffer unchanged on open, then normally saves a partial resolution with raw remaining markers", async () => {
  const original = working;
  render(<MergeEditor input={mergeInput("/jj/a.txt", "jj")} />);
  await screen.findByText("2 conflicts left");
  expect(working).toBe(original);
  expect(saved).toBe("disk unchanged");
  expect(save).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  const pane = screen.getByRole("region", { name: "Result" });
  fireEvent.click(within(pane).getAllByRole("button", { name: "Accept Yours" })[0]!);
  await screen.findByText("1 conflict left");
  expect(working).toBe("unsaved user edit\nleft1\ncommon\n" + conflict(2));
  fireEvent.keyDown(pane, { key: "s", code: "KeyS", metaKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(saved).toBe(working);
  expect(manager.get("/jj/a.txt")?.sync.localText.toString()).toBe(working);
  expect(useDocMeta.getState()["/jj/a.txt"]?.dirty).toBe(false);
  expect(jjConflicts(saved)).toHaveLength(1);
  expect(stage).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(closeInput).not.toHaveBeenCalled();
  fireEvent.click(within(pane).getByRole("button", { name: "Accept Theirs" }));
  await screen.findByText("All conflicts resolved");
  fireEvent.keyDown(pane, { key: "s", code: "KeyS", ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(saved).toBe("unsaved user edit\nleft1\ncommon\nright2\n");
});

it("keeps Git's explicit Apply and staging behavior", async () => {
  render(<MergeEditor input={mergeInput("/git/a.txt")} />);
  await screen.findByText("1 change left, 1 conflict");
  fireEvent.focus(screen.getByRole("region", { name: "Result" }));
  await executeAction("merge.change", { indexes: [0], action: { type: "accept", side: "left", resolve: true } });
  await screen.findByText("All changes processed");
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(stage).toHaveBeenCalledWith(["/git/a.txt"]));
  expect(write).toHaveBeenCalledWith("/git/a.txt", "left", { save: true, exact: true });
  expect(save).not.toHaveBeenCalled();
});

it("keeps jj and Git merge tabs separate because they have different save contracts", () => {
  expect(mergeInput("/p/a").key).toBe("merge:/p/a");
  expect(mergeInput("/p/a", "jj").key).toBe("merge:jj:/p/a");
});
