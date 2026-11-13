import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { semanticRanges } from "../index";

const doc = Text.of(["name"]);
describe("Go semantic tokens", () => {
  it("distinguishes a method receiver from parameters, locals, and shadowing closure parameters", async () => {
    const go = await languages.find((language) => language.name === "Go")!.load();
    const lines = [
      "package p",
      "func (t *Time) addSec(d int64) {",
      "  t.n += d",
      "  func(t int) { _ = t }(0)",
      "  { t := 1; _ = t }",
      "  func() { _ = t }()",
      "}",
      "func other(t int) { _ = t }",
    ];
    const doc = Text.of(lines);
    const tree = go.language.parser.parse(doc.toString());
    const data = lines.flatMap((line, index) =>
      [...line.matchAll(/\b[td]\b/g)].flatMap((match) => [index, match.index, 1, index === 4 ? 1 : 0, 0]),
    );
    const tokens = { tokenTypes: ["parameter", "variable"], tokenModifiers: [], data };
    const receiverLines = (ranges: ReturnType<typeof semanticRanges>) =>
      ranges.filter((r) => r.className.includes("cm-sem-go-method-receiver")).map((r) => doc.lineAt(r.from).number);
    const ranges = semanticRanges(doc, tokens, true, "go", tree);
    expect(receiverLines(ranges)).toEqual([2, 3, 6]);
    expect(ranges.filter((r) => doc.sliceString(r.from, r.to) === "d").map((r) => r.className)).toEqual([
      expect.stringMatching(/^cm-sem-parameter cm-sem-rainbow-/),
      expect.stringMatching(/^cm-sem-parameter cm-sem-rainbow-/),
    ]);
    expect(receiverLines(semanticRanges(doc, { ...tokens, data: [] }, false, "go", tree))).toEqual([2]);
  });

  it.each([
    [["readonly"], ["cm-sem-constant"]],
    [["static"], ["cm-sem-global", "cm-sem-static"]],
    [
      ["readonly", "static"],
      ["cm-sem-constant", "cm-sem-static"],
    ],
    [
      ["constant", "static"],
      ["cm-sem-constant", "cm-sem-static"],
    ],
  ])("classifies variable modifiers %j", (modifiers, classes) => {
    const ranges = semanticRanges(
      doc,
      {
        tokenTypes: ["variable"],
        tokenModifiers: modifiers,
        data: [0, 0, 4, 0, (1 << modifiers.length) - 1],
      },
      false,
      "go",
    );
    expect(ranges[0]?.className.split(" ").sort()).toEqual(classes);
  });

  it("keeps local constants out of rainbow coloring and scopes readonly to Go", () => {
    const tokens = { tokenTypes: ["variable"], tokenModifiers: ["readonly"], data: [0, 0, 4, 0, 1] };
    expect(semanticRanges(doc, tokens, true, "go")[0]?.className).toBe("cm-sem-constant");
    expect(semanticRanges(doc, tokens, false, "typescript")).toEqual([]);
    expect(semanticRanges(doc, { ...tokens, data: [0, 0, 4, 0, 0] }, true, "go")[0]?.className).toContain(
      "cm-sem-rainbow-",
    );
    expect(semanticRanges(doc, { ...tokens, tokenTypes: ["parameter"] }, true, "go")[0]?.className).toContain(
      "cm-sem-rainbow-",
    );
  });

  it("retains field and function roles from the common decoder", () => {
    for (const [type, expected] of [
      ["property", "cm-sem-property cm-sem-go-unexported-field"],
      ["function", "cm-sem-function"],
      ["type", "cm-sem-go-type-reference"],
      ["typeParameter", "cm-sem-typeParameter"],
    ]) {
      expect(
        semanticRanges(doc, { tokenTypes: [type!], tokenModifiers: [], data: [0, 0, 4, 0, 0] }, false, "go")[0]
          ?.className,
      ).toBe(expected);
    }
  });

  it.each(["declaration", "definition"])("keeps %s types on the shared type color", (modifier) => {
    const tokens = { tokenTypes: ["type"], tokenModifiers: [modifier], data: [0, 0, 4, 0, 1] };
    expect(semanticRanges(doc, tokens, false, "go")[0]?.className.split(" ")[0]).toBe("cm-sem-type");
  });

  it.each([
    ["function", "cm-sem-go-builtin-function"],
    ["type", "cm-sem-go-builtin-type"],
  ])("separates built-in %s tokens from other Go and non-Go tokens", (type, expected) => {
    const tokens = { tokenTypes: [type], tokenModifiers: ["defaultLibrary"], data: [0, 0, 4, 0, 1] };
    expect(semanticRanges(doc, tokens, false, "go")[0]?.className.split(" ")).toContain(expected);
    expect(semanticRanges(doc, tokens, false, "java")[0]?.className.split(" ")).not.toContain(expected);
  });

  it("highlights Go package declarations, import aliases, and qualified references", async () => {
    const go = await languages.find((language) => language.name === "Go")!.load();
    const doc = Text.of([
      "package main",
      'import ("machine"; "machine/usb/hid/keyboard"; "time"; fmtAlias "fmt"; _ "embed")',
      "var _ machine.Pin",
      "func main() { keyboard.Port(); time.Sleep(0); fmtAlias.Println() }",
      "//go:generate command",
    ]);
    const tree = go.language.parser.parse(doc.toString());
    const tokenTypes = ["namespace", "type", "function"];
    const tokens = [
      [2, "machine", 0],
      [2, "Pin", 1],
      [3, "keyboard", 0],
      [3, "Port", 2],
      [3, "time", 0],
      [3, "Sleep", 2],
      [3, "fmtAlias", 0],
      [3, "Println", 2],
      [4, "go:generate", 0],
    ] as const;
    const data = tokens.flatMap(([line, word, type]) => [
      line,
      doc.line(line + 1).text.indexOf(word),
      word.length,
      type,
      0,
    ]);
    const ranges = semanticRanges(doc, { data, tokenTypes, tokenModifiers: [] }, false, "go", tree);
    expect(ranges.map(({ from, to, className }) => [doc.sliceString(from, to), className])).toEqual([
      ["main", "cm-sem-go-package"],
      ["fmtAlias", "cm-sem-go-package"],
      ["machine", "cm-sem-go-package"],
      ["Pin", "cm-sem-go-type-reference"],
      ["keyboard", "cm-sem-go-package"],
      ["Port", "cm-sem-function"],
      ["time", "cm-sem-go-package"],
      ["Sleep", "cm-sem-function"],
      ["fmtAlias", "cm-sem-go-package"],
      ["Println", "cm-sem-function"],
      ["go:generate", "cm-sem-namespace"],
    ]);
  });

  it("leaves branch labels and missing server tokens to syntax highlighting", () => {
    expect(
      semanticRanges(doc, { tokenTypes: ["label"], tokenModifiers: [], data: [0, 0, 4, 0, 0] }, false, "go"),
    ).toEqual([]);
    expect(semanticRanges(doc, { tokenTypes: [], tokenModifiers: [], data: [] }, true, "go")).toEqual([]);
  });
});
