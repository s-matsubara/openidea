import { RangeSet, RangeSetBuilder, type EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { stickyHighlights } from "@/editor/api";
import { syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { openideaHighlightStyle } from "./highlight";
import { bracketClass, DEFAULT_BRACKET_COLORS, type BracketMark } from "./rainbowBrackets";

/** Maximum characters rendered for one preview line. */
export const MAX_PREVIEW_LINE_LENGTH = 400;

/**
 * Renders line `lineNo` highlighted into `target`; `brackets` (ascending, as from the
 * rainbow bracket scanner) are wrapped in their rainbow class, outside the token's span
 * as in the editor.
 */
export function renderLineContent(
  state: EditorState,
  lineNo: number,
  target: HTMLElement,
  brackets: readonly BracketMark[] = [],
  colors = DEFAULT_BRACKET_COLORS,
) {
  const line = state.doc.line(lineNo);
  const end = Math.min(line.to, line.from + MAX_PREVIEW_LINE_LENGTH);
  const tree = syntaxTree(state);
  const syntax = new RangeSetBuilder<Decoration>();
  // Lezer's editor decorations cover the viewport. Highlight the pinned line directly.
  if (tree.length >= end) {
    highlightTree(
      tree,
      openideaHighlightStyle,
      (from, to, cls) => syntax.add(Math.max(from, line.from), Math.min(to, end), Decoration.mark({ class: cls })),
      line.from,
      end,
    );
  }
  const rainbow = Decoration.set(
    brackets.map((b) => Decoration.mark({ class: bracketClass(b.depth, colors) }).range(b.from, b.from + 1)),
    true,
  );
  RangeSet.spans([...state.facet(stickyHighlights), syntax.finish(), rainbow], line.from, end, {
    span(from, to, marks) {
      let parent = target;
      // Match CodeMirror's nesting so higher-precedence marks set the final style.
      for (let i = marks.length - 1; i >= 0; i--) {
        const span = document.createElement("span");
        span.className = marks[i]!.spec.class;
        parent.appendChild(span);
        parent = span;
      }
      parent.appendChild(document.createTextNode(state.doc.sliceString(from, to)));
    },
    point() {},
  });
}
