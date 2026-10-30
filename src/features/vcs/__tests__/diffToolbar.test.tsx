import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EditorInput } from "@/workbench/contributions";
import { Chunk, getChunks } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ContextMenuHost, iconMarkup } from "@/ui";

const probe = vi.fn();
const jjAnnotate = vi.fn();
const openFile = vi.fn();
const openInput = vi.fn();
const texts: Record<string, string> = { HEAD: "a\n", abc123: "a\n" };
let working = "a\n";
let readOnly = false;

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsJjAnnotate: (...args: unknown[]) => jjAnnotate(...args),
      fsProbe: (path: string) => probe(path),
      vcsFileAt: (_path: string, rev: string) => Promise.resolve({ status: "ok", data: texts[rev] }),
      fsReadText: () => Promise.resolve({ status: "ok", data: working }),
    },
  };
});

vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openFile, openInput }),
}));

vi.mock("@/editor/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/editor/api")>()),
  attachDocument: (path: string) =>
    Promise.resolve({
      path,
      text: () => working,
      readOnly,
      extension: [],
      save: () => Promise.resolve(),
      release: () => {},
    }),
}));

import { DiffEditor, mapLine } from "../DiffEditor";
import { DiffEditorTab } from "../diff-editor-tab";
import { diffInput, withChain, type DiffData } from "../diffInput";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";

/** Git Log opens a commit's file: both sides are revisions. */
const input = {
  kind: "diff",
  key: "diff:test",
  data: {
    path: "/p/a.ts",
    left: { type: "rev", rev: "HEAD" },
    right: { type: "rev", rev: "abc123" },
  },
} as unknown as EditorInput;

/** `d` attributes of an SVG, which is what tells two icons apart. */
const paths = (html: string) => [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  readOnly = false;
  probe.mockReset();
  jjAnnotate.mockReset();
  openFile.mockReset();
  openInput.mockReset();
  texts.HEAD = texts.abc123 = working = "a\n";
  probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: false, tooLarge: false } });
});

describe("Diff toolbar", () => {
  it("can start an embedded comparison side by side without overwriting saved viewer preferences", async () => {
    localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "unified" }));
    const mounted = render(<DiffEditor input={{ ...input, data: { ...(input.data as object), mode: "split" } }} />);
    await waitFor(() => expect(mounted.container.querySelectorAll(".cm-editor")).toHaveLength(2));
    expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!).mode).toBe("unified");
    mounted.unmount();
    localStorage.removeItem("openidea.vcs.diffOptions");
  });
  it("shows a binary notice for disk comparisons instead of identical empty text", async () => {
    probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: true, tooLarge: false } });
    const binaryInput = {
      ...input,
      data: { path: "/p/right.bin", left: { type: "file", path: "/p/left.bin" }, right: { type: "worktree" } },
    } as EditorInput;
    render(<DiffEditor input={binaryInput} />);
    expect(await screen.findByText("Binary files cannot be shown as text")).toBeInTheDocument();
    expect(screen.queryByText("Contents are identical")).toBeNull();
    expect(screen.queryByRole("region", { name: /left.bin/ })).toBeNull();
    probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: false, tooLarge: false } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Binary files cannot be shown as text")).toBeNull());
  });

  it("puts Jump to Source right after Next Difference, in the navigation group", async () => {
    render(<DiffEditor input={input} />);
    await screen.findByRole("button", { name: "Jump to Source" });
    const toolbar = screen.getByRole("toolbar", { name: "Diff" });
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.slice(0, 3).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Previous Difference",
      "Next Difference",
      "Jump to Source",
    ]);
    // One group: no separator between the three, one after them.
    expect(buttons[1]!.nextElementSibling).toBe(buttons[2]);
    expect(buttons[2]!.nextElementSibling).not.toBe(buttons[3]);
  });

  it("shows a pencil for Jump to Source", async () => {
    render(<DiffEditor input={input} />);
    const button = await screen.findByRole("button", { name: "Jump to Source" });
    expect(paths(button.querySelector("svg")!.innerHTML)).toEqual(paths(iconMarkup("edit", 14)!));
  });

  it("jumps to the working copy of a file shown at a revision", async () => {
    render(<DiffEditor input={input} />);
    await screen.findByRole("button", { name: "Jump to Source" });
    expect(probe).toHaveBeenCalledWith("/p/a.ts");
  });

  it("turns on aligned changes from the settings menu (off by default)", async () => {
    localStorage.clear();
    texts.HEAD = "a\nb\n";
    texts.abc123 = "a\nnew\nb\n";
    render(
      <>
        <DiffEditor input={input} />
        <ContextMenuHost />
      </>,
    );
    await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
    // Unpadded panes joined by the divider.
    await waitFor(() => expect(document.querySelector(".cm-diffDivider")).not.toBeNull());
    expect(document.querySelector(".cm-changeGutter")).toBeNull();
    expect(document.querySelector(".cm-merge-b .cm-lineNumbers .cm-diffGutter-inserted")?.textContent).toBe("2");
    // The lock turns scrolling together off without rebuilding the panes.
    const divider = document.querySelector(".cm-diffDivider");
    (await screen.findByRole("button", { name: "Synchronize Scrolling" })).click();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!).syncScroll).toBe(false));
    expect(document.querySelector(".cm-diffDivider")).toBe(divider);
    (await screen.findByRole("button", { name: "Settings" })).click();
    const item = await screen.findByRole("menuitemcheckbox", { name: "Align Changes" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    item.click();
    // Padded panes, the changed lines' gutters still tinted as in IDEA.
    await waitFor(() => expect(document.querySelector(".cm-diffDivider")).toBeNull());
    expect(document.querySelector(".cm-merge-b .cm-lineNumbers .cm-diffGutter-inserted")?.textContent).toBe("2");
    expect(JSON.parse(localStorage.getItem("openidea.vcs.diffOptions")!)).toMatchObject({
      alignChanges: true,
      syncScroll: false,
    });
    localStorage.clear();
  });

  it("has no Jump to Source when the file is gone from the working tree", async () => {
    probe.mockRejectedValue(new Error("no such file"));
    render(<DiffEditor input={input} />);
    await waitFor(() => expect(probe).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Jump to Source" })).toBeNull());
  });
});

it.each([null, "bottom"] as const)(
  "maximizes a diff tab and restores the %s layout without rebuilding its editor",
  async (maximized) => {
    const layout = useToolWindowLayout.getState();
    const visible = { ...layout.visible, left: "project", bottom: "git" };
    useToolWindowLayout.setState({ visible, stashed: null, maximized });
    const mounted = render(<DiffEditorTab input={input} />);
    try {
      await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
      const dom = document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[1]!;
      const view = EditorView.findFromDOM(dom)!;
      view.dispatch({ selection: { anchor: 1 } });
      fireEvent.click(screen.getByRole("button", { name: "Maximize Editor" }));
      expect(Object.values(useToolWindowLayout.getState().visible).every((id) => id === null)).toBe(true);
      expect(screen.getByRole("button", { name: "Restore Size" })).toHaveAttribute("aria-pressed", "true");
      expect(EditorView.findFromDOM(dom)).toBe(view);
      expect(view.state.selection.main.head).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Restore Size" }));
      expect(useToolWindowLayout.getState().visible).toEqual(visible);
      expect(useToolWindowLayout.getState().maximized).toBe(maximized);
      expect(EditorView.findFromDOM(dom)).toBe(view);
      expect(view.state.selection.main.head).toBe(1);
    } finally {
      mounted.unmount();
      useToolWindowLayout.setState(layout);
    }
  },
);

it("does not offer editor maximization in an embedded diff", async () => {
  render(<DiffEditor input={input} />);
  await screen.findByRole("button", { name: "Jump to Source" });
  expect(screen.queryByRole("button", { name: "Maximize Editor" })).toBeNull();
});

it("restores the shared layout after the diff tab is remounted", async () => {
  const layout = useToolWindowLayout.getState();
  const visible = { ...layout.visible, left: "project", bottom: "git" };
  useToolWindowLayout.setState({ visible, stashed: null, maximized: "bottom" });
  const first = render(<DiffEditorTab input={input} />);
  fireEvent.click(screen.getByRole("button", { name: "Maximize Editor" }));
  first.unmount();
  const second = render(<DiffEditorTab input={input} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Restore Size" }));
    expect(useToolWindowLayout.getState()).toMatchObject({ visible, maximized: "bottom" });
  } finally {
    second.unmount();
    useToolWindowLayout.setState(layout);
  }
});

it.each([
  {
    index: 0,
    dir: 1 as const,
    button: "Next Difference",
    hint: "Press again to go to the next file",
    path: "/p/b.ts",
    reveal: "first",
  },
  {
    index: 1,
    dir: -1 as const,
    button: "Previous Difference",
    hint: "Press again to go to the previous file",
    path: "/p/a.ts",
    reveal: "last",
  },
])("moves across files after the $button boundary hint", async ({ index, dir, button, hint, path, reveal }) => {
  texts.HEAD = "same\nold\n";
  texts.abc123 = "same\nnew\n";
  const items: DiffData[] = ["/p/a.ts", "/p/b.ts"].map((path) => ({
    path,
    left: { type: "rev", rev: "HEAD" },
    right: { type: "rev", rev: "abc123" },
  }));
  render(<DiffEditor input={diffInput(withChain(items, index))} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
  const view = EditorView.findFromDOM(document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[1]!)!;
  const chunks = getChunks(view.state)!.chunks;
  const chunk = dir === 1 ? chunks[chunks.length - 1]! : chunks[0]!;
  view.dispatch({ selection: { anchor: chunk.fromB } });
  fireEvent.click(screen.getByRole("button", { name: button }));
  expect(await screen.findByText(hint)).toBeInTheDocument();
  expect(openInput).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: button }));
  await waitFor(() => expect(openInput).toHaveBeenCalledOnce());
  expect(openInput.mock.calls[0]![0].data).toMatchObject({ path, reveal });
});

it("renders jj snapshot sides read-only without hunk mutation controls", async () => {
  const { diffInput } = await import("../diffInput");
  const { jjFileDiffData } = await import("../jjDiffInput");
  const input = diffInput(
    jjFileDiffData("/p/a.ts", {
      before: "old\n",
      after: "new\n",
      beforeLabel: "Parent 1234",
      afterLabel: "@ 5678",
    }),
  );
  render(<DiffEditor input={input} />);
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
  for (const content of document.querySelectorAll(".cm-content"))
    expect(content).toHaveAttribute("contenteditable", "false");
  expect(screen.queryByRole("button", { name: /Revert|Stage|Unstage|Apply/ })).toBeNull();
  expect(document.querySelector(".cm-changeGutter")).toBeNull();
});

it("annotates the two jj diff sides at their own revisions and rename paths", async () => {
  const { jjFileDiffData } = await import("../jjDiffInput");
  const root = "/p";
  const beforeBlame = { root, path: "/p/old.ts", commit: "1".repeat(40) };
  const afterBlame = { root, path: "/p/new.ts", commit: "2".repeat(40) };
  jjAnnotate.mockResolvedValue({
    status: "ok",
    data: [{ author: "Author", commit: beforeBlame.commit, timeMs: 0, summary: "Change" }],
  });
  render(
    <>
      <DiffEditor
        input={diffInput(
          jjFileDiffData(afterBlame.path, {
            before: "old",
            after: "new",
            beforeLabel: "Parent",
            afterLabel: "Commit",
            beforeBlame,
            afterBlame,
          }),
        )}
      />
      <ContextMenuHost />
    </>,
  );
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
  const panes = document.querySelectorAll(".cm-mergeViewEditor .cm-editor");
  for (const [index, target, content] of [
    [0, beforeBlame, "old"],
    [1, afterBlame, "new"],
  ] as const) {
    fireEvent.contextMenu(panes[index]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Annotate with Jujutsu Blame" }));
    expect(jjAnnotate).toHaveBeenNthCalledWith(index + 1, target.root, target.path, target.commit, content);
    await waitFor(() => expect(panes[index]!.querySelector(".cm-vcs-blame")).not.toBeNull());
  }
});

it.each([false, true])("uses the live jj working document and respects read-only=%s", async (locked) => {
  const { diffInput } = await import("../diffInput");
  const { jjWorkingDiffData } = await import("../jjDiffInput");
  readOnly = locked;
  working = "unsaved\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nother unsaved\n";
  render(
    <DiffEditor
      input={diffInput(
        jjWorkingDiffData("/p/a.ts", {
          before: "parent\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nother parent\n",
          after: "disk\n",
          beforeLabel: "Parent 1234",
          afterLabel: "@ 5678",
        }),
      )}
    />,
  );
  await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor")).toHaveLength(2));
  const panes = [...document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")].map((dom) =>
    EditorView.findFromDOM(dom)!,
  );
  expect(panes[0]!.state.doc.toString()).toBe("parent\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nother parent\n");
  expect(panes[1]!.state.doc.toString()).toBe(working);
  expect(panes[0]!.state.readOnly).toBe(true);
  expect(panes[1]!.state.readOnly).toBe(locked);
  if (!locked) {
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert Change" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert Change" }));
    expect(panes[1]!.state.doc.toString()).toBe("parent\nkeep1\nkeep2\nkeep3\nkeep4\nkeep5\nother unsaved\n");
  } else expect(screen.queryByRole("button", { name: "Revert Change" })).toBeNull();
});

const doc = (s: string) => Text.of(s.split("\n"));

describe("mapLine", () => {
  const from = doc("a\nb\nc\nd\ne\nf\ng\n");
  const to = doc("a\nX\nY\nb\nc\ne\nF1\nF2\ng\n");
  const map = (line: number) => mapLine(Chunk.build(from, to), line, from, to);

  it("shifts lines past an insertion and keeps lines before it", () => {
    expect(map(0)).toBe(0);
    expect(map(1)).toBe(3);
    expect(map(2)).toBe(4);
  });

  it("lands on the line after a removed block", () => {
    expect(map(3)).toBe(5);
    expect(map(4)).toBe(5);
  });

  it("keeps the offset inside a changed block and shifts past it", () => {
    expect(map(5)).toBe(6);
    expect(map(6)).toBe(8);
  });
});

describe("Jump to Source of a revision diff", () => {
  /** Parent, commit and working copy each add a line above the previous. */
  const setUp = () => {
    texts.HEAD = "a\nb\nc\nd\n";
    texts.abc123 = "a\nX\nY\nb\nc\nd\n";
    working = "new\na\nX\nY\nb\nc\nd\n";
  };
  const pane = async (index: number) => {
    await waitFor(() => expect(document.querySelectorAll(".cm-mergeViewEditor .cm-editor").length).toBe(2));
    return EditorView.findFromDOM(document.querySelectorAll<HTMLElement>(".cm-mergeViewEditor .cm-editor")[index]!)!;
  };
  const jumpFrom = async (index: number, line: number) => {
    const v = await pane(index);
    v.dispatch({ selection: { anchor: v.state.doc.line(line + 1).from + 1 } });
    v.contentDOM.dispatchEvent(new FocusEvent("focus"));
    (await screen.findByRole("button", { name: "Jump to Source" })).click();
    await waitFor(() => expect(openFile).toHaveBeenCalled());
    return openFile.mock.calls[0];
  };

  it("maps a line of the commit to the working copy", async () => {
    setUp();
    render(<DiffEditor input={input} />);
    expect(await jumpFrom(1, 2)).toEqual(["/p/a.ts", { selection: { line: 3, col: 1 }, focus: true }]);
  });

  it("maps a line of the parent through the diff to the working copy", async () => {
    setUp();
    render(<DiffEditor input={input} />);
    expect(await jumpFrom(0, 2)).toEqual(["/p/a.ts", { selection: { line: 5, col: 1 }, focus: true }]);
  });
});

describe("Unified Revert", () => {
  for (const control of ["toolbar", "chunk"] as const) {
    it.each([
      ["a\nb", "a"],
      ["same", "same\n"],
      ["same\n", "same"],
      ["", "added"],
      ["deleted", ""],
    ])(`${control} restores %j from %j`, async (original, changed) => {
      localStorage.setItem("openidea.vcs.diffOptions", JSON.stringify({ mode: "unified", collapse: false }));
      texts.HEAD = original;
      working = changed;
      const mounted = render(
        <DiffEditor
          input={
            {
              ...input,
              data: {
                path: "/p/a.ts",
                left: { type: "rev", rev: "HEAD" },
                right: { type: "worktree" },
              },
            } as EditorInput
          }
        />,
      );
      try {
        await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(1));
        const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
        if (control === "toolbar") {
          const button = await screen.findByRole("button", { name: "Revert Change" });
          await waitFor(() => expect(button).not.toBeDisabled());
          fireEvent.click(button);
        } else {
          fireEvent.mouseDown(await screen.findByRole("button", { name: /^Revert$/ }));
        }
        await waitFor(() => expect(view.state.doc.toString()).toBe(original));
      } finally {
        mounted.unmount();
        localStorage.clear();
      }
    });
  }
});
