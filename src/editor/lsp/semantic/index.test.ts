import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Prec, Text, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { openideaHighlightStyle } from "../../core/cm/highlight";
import { setSyntaxHighlights, syntaxHighlightField } from "../../core/cm/syntaxHighlight";

// One `property` token over the whole word, as jdtls reports an instance field.
const lspSemanticTokens = vi.fn(async () => ({
  status: "ok" as const,
  data: { data: [0, 0, 13, 0, 0], tokenTypes: ["property"], tokenModifiers: [] },
}));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspSemanticTokens } };
});

const { semanticExtension, semanticRanges } = await import("./index");
const { lspDoc } = await import("../lsp");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** A syntax-highlighter mark at the same precedence CodeMirror's `treeHighlighter` uses. */
const syntaxMark = (cls: string, from = 0, to = 13): Extension =>
  Prec.high(EditorView.decorations.of(Decoration.set([Decoration.mark({ class: cls }).range(from, to)])));

async function editor(extensions: Extension[]) {
  const view = new EditorView({
    state: EditorState.create({
      doc: "nasProperties",
      extensions: [
        lspDoc.of({ doc: 1, path: "/p/A.java", language: "java", uiMode: "Java", readOnly: false }),
        ...extensions,
      ],
    }),
  });
  document.body.append(view.dom);
  views.push(view);
  await vi.advanceTimersByTimeAsync(1000);
  return view;
}

describe("semantic decorations vs the syntax highlighter", () => {
  it("styles Go local declarations and uses separately from package variables, constants, and calls", async () => {
    const go = await languages.find((language) => language.name === "Go")!.load();
    const doc = Text.of([
      "package p",
      "var global = 1",
      "const limit = 2",
      "func f() {",
      "  local := 1; var (grouped = 0); callable := func() {}",
      "  for index := range []int{0} { _ = index }",
      "  _, _ = local, global; _ = limit; callable()",
      "}",
    ]);
    const tree = go.language.parser.parse(doc.toString());
    const line = doc.line(7);
    const tokens = [
      ["local", 0],
      ["global", 1],
      ["limit", 2],
      ["callable", 0],
    ] as const;
    const data = tokens.flatMap(([name, mods]) => [6, line.text.indexOf(name), name.length, 0, mods]);
    const ranges = semanticRanges(
      doc,
      { data, tokenTypes: ["variable"], tokenModifiers: ["static", "readonly"] },
      false,
      "go",
      tree,
    );
    const local = ranges.filter((r) => r.className === "cm-sem-go-local-variable");
    expect(local.map((r) => doc.sliceString(r.from, r.to))).toEqual(["local", "grouped", "callable", "index", "local"]);
    expect(
      ranges.some((r) => r.className.includes("cm-sem-global") && doc.sliceString(r.from, r.to) === "global"),
    ).toBe(true);
    expect(
      ranges.some((r) => r.className.includes("cm-sem-constant") && doc.sliceString(r.from, r.to) === "limit"),
    ).toBe(true);
  });

  it("separates Go field declarations and references without recolouring calls", async () => {
    const go = await languages.find((language) => language.name === "Go")!.load();
    const doc = Text.of([
      "package p",
      "type T struct { Éxported, unexported int; Callback func() }",
      "func f(t T) { _, _ = t.Éxported, t.unexported; t.Callback(); t.Method() }",
    ]);
    const tree = go.language.parser.parse(doc.toString());
    const line = doc.line(3);
    const names = ["Éxported", "unexported", "Callback", "Method"];
    const data = names.flatMap((name, i) => [2, line.text.indexOf(name), name.length, i === 3 ? 1 : 0, 0]);
    const ranges = semanticRanges(
      doc,
      { data, tokenTypes: ["property", "method"], tokenModifiers: [] },
      false,
      "go",
      tree,
    );
    expect(ranges.map(({ from, to, className }) => [doc.sliceString(from, to), className.split(" ").at(-1)])).toEqual([
      ["Éxported", "cm-sem-go-exported-field"],
      ["unexported", "cm-sem-go-unexported-field"],
      ["Callback", "cm-sem-go-exported-field"],
      ["Éxported", "cm-sem-go-exported-field"],
      ["unexported", "cm-sem-go-unexported-field"],
      ["Callback", "cm-sem-function"],
      ["Method", "cm-sem-function"],
    ]);
  });

  it("keeps semantic roles inside supplemental backend syntax marks", async () => {
    vi.useFakeTimers();
    const view = await editor([syntaxHighlightField, syntaxHighlighting(openideaHighlightStyle), semanticExtension()]);
    view.dispatch({ effects: setSyntaxHighlights.of({ kinds: ["variable"], data: [0, 13, 0] }) });
    const sem = view.contentDOM.querySelector(".cm-sem-property")!;
    expect(sem).not.toBeNull();
    expect(sem.children.length).toBe(0);
    expect(sem.parentElement!.textContent).toBe("nasProperties");
  });

  it("puts the semantic mark inside the syntax span, whichever is added last", async () => {
    vi.useFakeTimers();
    for (const extensions of [
      [semanticExtension(), syntaxMark("tok-variableName")],
      [syntaxMark("tok-variableName"), semanticExtension()],
    ]) {
      const view = await editor(extensions);
      const sem = view.contentDOM.querySelector(".cm-sem-property");
      expect(sem).not.toBeNull();
      // Inner nodes win their own colour: the field must not be wrapped by a
      // syntax span that re-sets `color`.
      expect(sem!.children.length).toBe(0);
      expect(lspSemanticTokens).toHaveBeenCalled();
      view.destroy();
    }
  });
});
