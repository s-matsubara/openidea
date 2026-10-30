/** Three-pane merge conflict editor: Yours | Result | Theirs. */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import type { MergeSides } from "@/bindings";
import { attachDocument, type DocumentAttachment, embeddedEditorExtensions } from "@/editor/api";
import { setContext } from "@/platform/context";
import { tx, useTxTemplate } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { Button, IconButton, Spinner, T } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { languageFor, viewerBase } from "./cm";
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import { syncMergeScroll } from "./mergeScroll";
import { mergeTitles, resolutionText, type Resolution } from "./conflicts";
import { errorMessage } from "./ops";
import { jjConflicts, type ResultConflict } from "./jjConflicts";
import styles from "./MergeEditor.module.css";

import type { MergeData } from "./mergeKind";

/** Drops the conflict at an index once a resolution replaced its text. */
const resolvedConflict = StateEffect.define<number>();

function resolveConflict(view: EditorView, index: number, how: Resolution) {
  const c = view.state.field(conflictField).conflicts[index];
  if (!c) return;
  view.dispatch({
    changes: { from: c.from, to: c.to, insert: resolutionText(c, how) },
    effects: resolvedConflict.of(index),
    userEvent: "input.resolve",
  });
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly hasBase: boolean,
  ) {
    super();
  }
  eq(o: ActionsWidget) {
    return o.index === this.index && o.hasBase === this.hasBase;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-conflict-actions";
    const add = (label: string, how: Resolution) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      // Keep the caret / focus in the editor; resolve on click (mouse or keyboard).
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = (e) => {
        e.preventDefault();
        resolveConflict(view, this.index, how);
      };
      el.appendChild(b);
    };
    const title = document.createElement("span");
    title.textContent = `Conflict ${this.index + 1}`;
    el.appendChild(title);
    add("Accept Yours", "ours");
    add("Accept Theirs", "theirs");
    add("Accept Both", "both");
    if (this.hasBase) add("Use Base", "base");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const conflictLine = Decoration.line({ class: "cm-conflict-marker" });

function decorate(state: EditorState, conflicts: readonly ResultConflict[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  conflicts.forEach((c, i) => {
    b.add(c.from, c.from, Decoration.widget({ widget: new ActionsWidget(i, c.base !== null), block: true, side: -1 }));
    if (c.to <= c.from) return;
    const endLine = doc.lineAt(c.to - 1).number;
    for (let n = doc.lineAt(c.from).number; n <= endLine; n++) b.add(doc.line(n).from, doc.line(n).from, conflictLine);
  });
  return b.finish();
}

/**
 * The result's unresolved conflicts, tracked as ranges holding the base text (no
 * markers), as IDEA's merge dialog shows them. Typing at a conflict's edges stays in it.
 */
const conflictField = StateField.define<{ conflicts: ResultConflict[]; deco: DecorationSet; markers: boolean }>({
  create: () => ({ conflicts: [], deco: Decoration.none, markers: false }),
  update(v, tr) {
    if (v.markers && tr.docChanged) {
      const conflicts = jjConflicts(tr.newDoc.toString());
      return { conflicts, deco: decorate(tr.state, conflicts), markers: true };
    }
    const done = new Set(tr.effects.filter((e) => e.is(resolvedConflict)).map((e) => e.value as number));
    let conflicts = v.conflicts.filter((_, i) => !done.has(i));
    if (tr.docChanged)
      conflicts = conflicts.map((c) => ({ ...c, from: tr.changes.mapPos(c.from, -1), to: tr.changes.mapPos(c.to, 1) }));
    if (!tr.docChanged && !done.size) return v;
    return { conflicts, deco: decorate(tr.state, conflicts), markers: v.markers };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const resultTheme = EditorView.baseTheme({
  ".cm-conflict-marker": {
    backgroundColor: "color-mix(in srgb, var(--vcs-conflict) 14%, transparent)",
    color: "var(--fg-subtle)",
  },
  ".cm-conflict-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    color: "var(--vcs-conflict)",
    background: "var(--bg-elev)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-conflict-actions button": {
    padding: "0 6px",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-secondary)",
    background: "var(--bg-control)",
    font: "inherit",
    lineHeight: "18px",
  },
  ".cm-conflict-actions button:hover": { color: "var(--fg-strong)", background: "var(--bg-control-hover)" },
});

export function JjMergeEditor({ input }: { input: EditorInput }) {
  const { path } = input.data as MergeData;
  const [attachment, setAttachment] = useState<DocumentAttachment | null>(null);
  const [state, setState] = useState<{
    ours: string;
    theirs: string;
    base: string | null;
    sides: MergeSides;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [left, setLeft] = useState(0);
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultView = useRef<EditorView | null>(null);
  const oursView = useRef<EditorView | null>(null);
  const theirsView = useRef<EditorView | null>(null);
  const txt = useTxTemplate();
  const titles = mergeTitles(state?.sides);

  useEffect(() => {
    let alive = true;
    let attached: DocumentAttachment | null = null;
    void attachDocument(path)
      .then((doc) => {
        attached = doc;
        if (alive) setAttachment(doc);
        else doc.release();
      })
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
      attached?.release();
    };
  }, [path]);

  const load = useCallback(async () => {
    try {
      const v = await call(commands.vcsConflictVersions(path));
      setState({
        ours: v.ours ?? "",
        theirs: v.theirs ?? "",
        base: v.base,
        sides: v.sides,
      });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [path]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => {
    let alive = true;
    void languageFor(path).then((l) => alive && setLang(() => l ?? []));
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (!state || !attachment || lang === null || !oursRef.current || !resultRef.current || !theirsRef.current) return;
    const side = () => [
      viewerBase({ readOnly: true }),
      lang,
      state.base !== null ? unifiedMergeView({ original: state.base, mergeControls: false, gutter: true }) : [],
    ];
    const ours = new EditorView({ doc: state.ours, parent: oursRef.current, extensions: side() });
    const theirs = new EditorView({ doc: state.theirs, parent: theirsRef.current, extensions: side() });
    // Like IDEA, start from the three-way merge (non-conflicting changes applied, conflicts
    // showing the base) rather than the marker-laden working copy.
    const text = attachment.text();
    const start = { text, conflicts: jjConflicts(text) };
    const result = new EditorView({
      doc: start.text,
      parent: resultRef.current,
      extensions: [
        viewerBase({ readOnly: attachment?.readOnly ?? false }),
        attachment.extension,
        history(),
        keymap.of(historyKeymap),
        embeddedEditorExtensions(path),
        lang,
        conflictField.init((s) => ({ conflicts: start.conflicts, deco: decorate(s, start.conflicts), markers: true })),
        resultTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setLeft(u.state.field(conflictField).conflicts.length);
        }),
      ],
    });
    resultView.current = result;
    setLeft(result.state.field(conflictField).conflicts.length);
    oursView.current = ours;
    theirsView.current = theirs;
    // Scroll the three panes together, lined up through their changes.
    const stopSync = syncMergeScroll({ ours, result, theirs });
    return () => {
      stopSync();
      ours.destroy();
      theirs.destroy();
      result.destroy();
      resultView.current = null;
      oursView.current = null;
      theirsView.current = null;
    };
  }, [state, lang, path, attachment]);

  const goto = (dir: 1 | -1) => {
    const v = resultView.current;
    if (!v) return;
    const blocks = v.state.field(conflictField).conflicts;
    if (!blocks.length) return;
    const head = v.state.selection.main.head;
    const target =
      dir === 1
        ? (blocks.find((b) => b.from > head) ?? blocks[0]!)
        : ([...blocks].reverse().find((b) => b.to < head) ?? blocks[blocks.length - 1]!);
    v.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    v.focus();
  };

  const acceptAll = (how: Resolution) => {
    const v = resultView.current;
    if (!v) return;
    const conflicts = v.state.field(conflictField).conflicts;
    v.dispatch({
      changes: conflicts.map((c) => ({ from: c.from, to: c.to, insert: resolutionText(c, how) })),
      effects: conflicts.map((_, i) => resolvedConflict.of(i)),
      userEvent: "input.resolve",
    });
  };

  // Next / Previous Difference (F7 / Shift+F7 by default) jump between conflicts through
  // the keymap, as in the diff viewer.
  // `goto` reads only refs, so the first render's one stays valid.
  const [nav] = useState<DiffNavigator>(() => ({
    next: () => goto(1),
    prev: () => goto(-1),
    jumpToSource: () => void editorService().openFile(path, { focus: true }),
    applyChange: () => false,
    file: () => {},
    showSettings: () => {},
  }));
  useEffect(
    () => () => {
      if (focusedDiffNavigator() === nav) {
        setFocusedDiffNavigator(null);
        setContext("diffEditorFocus", false);
      }
    },
    [nav],
  );

  if (error)
    return (
      <div className={styles.message}>
        {error}
        <Button onClick={() => void load()}>
          <T>Retry</T>
        </Button>
      </div>
    );
  return (
    <div
      className={styles.root}
      onFocusCapture={() => {
        setFocusedDiffNavigator(nav);
        setContext("diffEditorFocus", true);
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && focusedDiffNavigator() === nav) {
          setFocusedDiffNavigator(null);
          setContext("diffEditorFocus", false);
        }
      }}
    >
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Merge")}>
        <IconButton
          icon="arrow-up"
          title="Previous Conflict"
          shortcut={shortcutLabel("diff.prevDifference")}
          size="small"
          onClick={() => goto(-1)}
        />
        <IconButton
          icon="arrow-down"
          title="Next Conflict"
          shortcut={shortcutLabel("diff.nextDifference")}
          size="small"
          onClick={() => goto(1)}
        />
        <span className={styles.sep} />
        <Button size="small" onClick={() => acceptAll("ours")}>
          <T>Accept All Yours</T>
        </Button>
        <Button size="small" onClick={() => acceptAll("theirs")}>
          <T>Accept All Theirs</T>
        </Button>
        <span className={clsx(styles.status, !left && styles.statusDone)}>
          {left === 1 ? tx`${left} conflict left` : left ? tx`${left} conflicts left` : tx("All conflicts resolved")}
        </span>
      </div>
      <div className={styles.labels}>
        <span>{txt(titles.yours)}</span>
        <span>
          <T>Result</T>
        </span>
        <span>{txt(titles.theirs)}</span>
      </div>
      {!state || lang === null ? (
        <div className={styles.message}>
          <Spinner size={14} />
        </div>
      ) : null}
      <div className={styles.panes} hidden={!state || lang === null}>
        <div ref={oursRef} className={styles.pane} aria-label={tx("Your version")} role="region" />
        <div ref={resultRef} className={styles.pane} aria-label={tx("Result")} role="region" />
        <div ref={theirsRef} className={styles.pane} aria-label={tx("Their version")} role="region" />
      </div>
    </div>
  );
}
