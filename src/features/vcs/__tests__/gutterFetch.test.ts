import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LineHunk, VcsRoot } from "@/bindings";
import { changeMarkers, editorHunks, setHunkPopupHooks, showHunkPopup } from "../gutter";
import { useVcs } from "../store";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  call: (promise: Promise<unknown>) => promise,
  commands: { vcsLineHunks: (path: string) => read(path) },
}));
const hunk: LineHunk = { kind: "modified", start: 0, lines: 1, oldStart: 0, oldLines: 1, oldText: "parent\n" };
const jjRoot: VcsRoot = {
  root: "/git/jj",
  kind: "jj",
  unavailableReason: null,
  workingCopy: null,
  head: null,
  headCommit: null,
  operation: null,
};
let views: EditorView[];
const editor = (path = "/git/jj/file") => {
  const view = new EditorView({
    state: EditorState.create({
      doc: "buffer\n",
      extensions: changeMarkers({ path } as Parameters<typeof changeMarkers>[0]),
    }),
  });
  views.push(view);
  return view;
};
beforeEach(() => {
  vi.useFakeTimers();
  read.mockReset().mockResolvedValue([hunk]);
  views = [];
  useVcs.setState({ available: false, kinds: { "/git/jj": "jj" }, jjRoots: [jjRoot] });
});
afterEach(() => {
  for (const view of views) view.destroy();
  setHunkPopupHooks(null);
  vi.useRealTimers();
});
it("fetches in jj-only projects, refreshes after edits and VCS updates, and clears unsupported results", async () => {
  const view = editor();
  await vi.advanceTimersByTimeAsync(40);
  expect(read).toHaveBeenCalledWith("/git/jj/file");
  expect(editorHunks(view.state)).toHaveLength(1);
  view.dispatch({ changes: { from: 0, to: 6, insert: "edited" } });
  await vi.advanceTimersByTimeAsync(310);
  expect(read).toHaveBeenCalledTimes(2);
  read.mockRejectedValueOnce(new Error("unsupported merge baseline"));
  useVcs.setState((s) => ({ version: s.version + 1 }));
  await vi.advanceTimersByTimeAsync(70);
  expect(editorHunks(view.state)).toEqual([]);
});
it("discards in-flight results when a buffer or root changes", async () => {
  let finish!: (value: LineHunk[]) => void;
  read.mockImplementationOnce(
    () =>
      new Promise<LineHunk[]>((resolve) => {
        finish = resolve;
      }),
  );
  const view = editor();
  await vi.advanceTimersByTimeAsync(40);
  view.dispatch({ changes: { from: 0, insert: "new" } });
  finish([hunk]);
  await Promise.resolve();
  expect(editorHunks(view.state)).toEqual([]);
  await vi.advanceTimersByTimeAsync(310);
  expect(editorHunks(view.state)).toHaveLength(1);
  read.mockImplementationOnce(
    () =>
      new Promise<LineHunk[]>((resolve) => {
        finish = resolve;
      }),
  );
  useVcs.setState((s) => ({ version: s.version + 1 }));
  await vi.advanceTimersByTimeAsync(70);
  useVcs.setState({ jjRoots: [{ ...jjRoot, unavailableReason: "missing CLI" }] });
  finish([hunk]);
  await vi.advanceTimersByTimeAsync(70);
  expect(editorHunks(view.state)).toEqual([]);
});
it("keeps Git fetches and popup hooks with jj read-only popup hooks in mixed roots", async () => {
  useVcs.setState({ available: true, kinds: { "/git": "git", "/git/jj": "jj" } });
  const git = editor("/git/file");
  const jj = editor();
  await vi.advanceTimersByTimeAsync(40);
  expect(editorHunks(git.state)).toHaveLength(1);
  expect(editorHunks(jj.state)).toHaveLength(1);
  const open = vi.fn();
  setHunkPopupHooks({ open, docChanged: vi.fn() });
  showHunkPopup(jj, editorHunks(jj.state)[0]!, "/git/jj/file");
  expect(open).toHaveBeenCalledOnce();
  showHunkPopup(git, editorHunks(git.state)[0]!, "/git/file");
  expect(open).toHaveBeenCalledTimes(2);
});
