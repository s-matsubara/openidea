import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { changeLane } from "@/editor/core/cm/lanes";
import { changeMarkers, editorHunks, setHunksEffect } from "../gutter";
import { closeHunkPopup, installHunkPopup, openHunkPopup } from "../HunkPopup";
import { useVcs } from "../store";
import type { LineHunk } from "@/bindings";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  call: () => new Promise(() => {}),
  commands: { vcsLineHunks: () => undefined },
}));
vi.mock("@/platform/actions", () => ({ executeAction: execute }));
let view: EditorView;
let dispose: () => void;
const hunks: LineHunk[] = [
  { kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "parent\n" },
  { kind: "added", start: 2, lines: 1, oldStart: 2, oldLines: 0, oldText: "" },
  { kind: "deleted", start: 4, lines: 0, oldStart: 3, oldLines: 1, oldText: "deleted parent\n" },
];
function open(jj = true, readOnly = false) {
  useVcs.setState({
    available: true,
    kinds: { "/repo": jj ? "jj" : "git" },
    jjRoots: jj
      ? [
          {
            root: "/repo",
            kind: "jj",
            unavailableReason: null,
            workingCopy: null,
            head: null,
            headCommit: null,
            operation: null,
          },
        ]
      : [],
  });
  dispose = installHunkPopup();
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "unsaved\nkeep\nadded buffer\nkeep\n",
      extensions: [
        history(),
        EditorState.readOnly.of(readOnly),
        changeLane,
        changeMarkers({ path: "/repo/file" } as Parameters<typeof changeMarkers>[0]),
      ],
    }),
  });
  view.dispatch({ effects: setHunksEffect.of(hunks) });
  act(() => {
    view.dom
      .querySelector(".cm-openidea-lane")!
      .dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }),
      );
  });
}
beforeEach(() => {
  execute.mockReset();
});
afterEach(() => {
  act(() => {
    view?.destroy();
    dispose?.();
  });
});
it("opens jj markers with parent and unsaved text, rollback, copy and navigation", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  open();
  expect(await screen.findByText("parent")).toBeTruthy();
  expect(within(screen.getByRole("dialog")).getByText("unsaved")).toBeTruthy();
  expect(screen.getByLabelText("Rollback")).toBeTruthy();
  expect(screen.queryByLabelText("Show Diff")).toBeNull();
  fireEvent.click(screen.getByLabelText("Copy Original Text"));
  expect(copy).toHaveBeenCalledWith("parent\n");
  fireEvent.click(screen.getByLabelText("Next Change"));
  expect(await waitFor(() => within(screen.getByRole("dialog")).getByText("added buffer"))).toBeTruthy();
  expect(screen.getByLabelText("Copy Original Text")).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Next Change"));
  expect(await screen.findByText("deleted parent")).toBeTruthy();
  expect(within(screen.getByRole("dialog")).queryByText("added buffer")).toBeNull();
  fireEvent.click(screen.getByLabelText("Previous Change"));
  expect(await waitFor(() => within(screen.getByRole("dialog")).getByText("added buffer"))).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Close"));
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  expect(execute).not.toHaveBeenCalled();
});
it.each(["edit", "refresh", "root", "unavailable", "destroy", "close"])(
  "invalidates pending navigation on %s",
  async (reason) => {
    open();
    await screen.findByText("parent");
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frame = cb;
      return 1;
    });
    fireEvent.click(screen.getByLabelText("Next Change"));
    act(() => {
      if (reason === "edit") view.dispatch({ changes: { from: 0, insert: "edit" } });
      if (reason === "refresh") useVcs.setState((s) => ({ version: s.version + 1 }));
      if (reason === "root") useVcs.setState({ kinds: {} });
      if (reason === "unavailable") useVcs.setState({ available: false });
      if (reason === "destroy") view.destroy();
      if (reason === "close") closeHunkPopup();
      frame?.(0);
    });
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    raf.mockRestore();
  },
);
it("preserves Git rollback and full diff controls", async () => {
  open(false);
  await screen.findByText("parent");
  expect(screen.getByLabelText("Show Diff")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Rollback"));
  expect(view.state.doc.toString()).toBe("parent\nkeep\nadded buffer\nkeep\n");
});

it.each([0, 1, 2])("rolls back only jj hunk %i in the unsaved document and supports Undo", async (index) => {
  open();
  await screen.findByText("parent");
  const original = view.state.doc.toString();
  act(() => openHunkPopup(view, editorHunks(view.state)[index]!, "/repo/file"));
  await screen.findByRole("dialog", { name: ["Modified lines", "Added lines", "Deleted lines"][index] });
  fireEvent.click(screen.getByLabelText("Rollback"));
  expect(view.state.doc.toString()).toBe(
    [
      "parent\nkeep\nadded buffer\nkeep\n",
      "unsaved\nkeep\nkeep\n",
      "unsaved\nkeep\nadded buffer\nkeep\ndeleted parent\n",
    ][index],
  );
  expect(execute).not.toHaveBeenCalled();
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe(original);
});
it("does not offer rollback for a read-only document", async () => {
  open(true, true);
  await screen.findByText("parent");
  expect(screen.queryByLabelText("Rollback")).toBeNull();
});
it("rejects a popup whose hunk baseline was replaced", async () => {
  open();
  await screen.findByText("parent");
  act(() => view.dispatch({ effects: setHunksEffect.of([{ ...hunks[0]!, oldText: "different\n" }]) }));
  fireEvent.click(screen.getByLabelText("Rollback"));
  expect(view.state.doc.toString()).toBe("unsaved\nkeep\nadded buffer\nkeep\n");
});

it("opens with neutral toolbar focus and retains Tab navigation and Escape", async () => {
  const user = userEvent.setup();
  open();
  const toolbar = await screen.findByRole("toolbar", { name: "Change actions" });
  await waitFor(() => expect(toolbar).toHaveFocus());
  expect(screen.getByLabelText("Rollback")).not.toHaveFocus();
  await user.tab();
  expect(screen.getByLabelText("Previous Change")).toHaveFocus();
  await user.tab();
  expect(screen.getByLabelText("Next Change")).toHaveFocus();
  await user.tab();
  expect(screen.getByLabelText("Rollback")).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
});
