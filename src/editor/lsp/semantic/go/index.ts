import { registerLanguageSemantics, type LanguageSemantics, type SemanticRange } from "../languages";

function fieldClass(name: string): string {
  return /^\p{Lu}/u.test(name) ? "cm-sem-go-exported-field" : "cm-sem-go-unexported-field";
}

const goSemantics: LanguageSemantics = {
  symbolKinds(tree) {
    const kinds = new Map<string, string>();
    tree.iterate({
      enter({ name, node, from, to }) {
        const parent = node.parent;
        if (name === "FieldName" && parent?.name === "SelectorExpr" && parent.parent?.name === "CallExpr")
          kinds.set(`${from}:${to}`, "fieldCall");
      },
    });
    return kinds;
  },
  fallbackRanges(tree, doc) {
    const ranges: SemanticRange[] = [];
    tree.iterate({
      enter({ name, node, from, to }) {
        if (name === "FieldName" && node.parent?.name === "FieldDecl")
          ranges.push({ from, to, className: fieldClass(doc.sliceString(from, to)), source: "fallback" });
      },
    });
    return ranges;
  },
  tokenClasses({ type, text, modifiers, kind, classes }) {
    if (type === "property") {
      if (kind === "fieldCall") {
        const index = classes.indexOf("cm-sem-property");
        if (index !== -1) classes[index] = "cm-sem-function";
      } else {
        classes.push(fieldClass(text));
      }
    }
    if (type === "variable") {
      if (modifiers.includes("readonly") && !classes.includes("cm-sem-constant")) classes.push("cm-sem-constant");
      else if (modifiers.includes("static") && !classes.includes("cm-sem-constant")) classes.push("cm-sem-global");
    }
  },
  isLocal: ({ type, modifiers }) => type === "parameter" || (type === "variable" && !modifiers.includes("readonly")),
};

registerLanguageSemantics("go", goSemantics);
