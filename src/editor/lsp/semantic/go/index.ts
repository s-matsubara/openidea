import { registerLanguageSemantics, type LanguageSemantics, type SemanticRange } from "../languages";
import type { SyntaxNode } from "@lezer/common";

const localVariableClass = "cm-sem-go-local-variable";
const packageClass = "cm-sem-go-package";

function fieldClass(name: string): string {
  return /^\p{Lu}/u.test(name) ? "cm-sem-go-exported-field" : "cm-sem-go-unexported-field";
}

function isLocalDeclaration(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.name === "RangeClause") return true;
  let declaration = parent;
  if (parent?.name === "VarSpec") {
    declaration = parent.parent;
    if (declaration?.name === "SpecList") declaration = declaration.parent;
  }
  return declaration?.name === "VarDecl" && declaration.parent?.name !== "SourceFile";
}

const goSemantics: LanguageSemantics = {
  symbolKinds(tree) {
    const kinds = new Map<string, string>();
    tree.iterate({
      enter({ name, node, from, to }) {
        const parent = node.parent;
        if (
          (name === "FieldName" && parent?.name === "SelectorExpr" && parent.parent?.name === "CallExpr") ||
          (name === "VariableName" && parent?.name === "CallExpr")
        )
          kinds.set(`${from}:${to}`, "call");
      },
    });
    return kinds;
  },
  fallbackRanges(tree, doc) {
    const ranges: SemanticRange[] = [];
    tree.iterate({
      enter({ name, node, from, to }) {
        const parent = node.parent?.name;
        if (name === "DefName" && (parent === "PackageClause" || parent === "ImportSpec")) {
          if (doc.sliceString(from, to) !== "_") ranges.push({ from, to, className: packageClass, source: "fallback" });
        } else if (name === "FieldName" && parent === "FieldDecl")
          ranges.push({ from, to, className: fieldClass(doc.sliceString(from, to)), source: "fallback" });
        else if (name === "DefName" && isLocalDeclaration(node) && doc.sliceString(from, to) !== "_")
          ranges.push({ from, to, className: localVariableClass, source: "fallback" });
      },
    });
    return ranges;
  },
  tokenClasses({ type, text, modifiers, kind, classes }) {
    if (type === "namespace" && !text.startsWith("go:")) {
      const index = classes.indexOf("cm-sem-namespace");
      if (index !== -1) classes[index] = packageClass;
    }
    if (type === "property") {
      if (kind === "call") {
        const index = classes.indexOf("cm-sem-property");
        if (index !== -1) classes[index] = "cm-sem-function";
      } else {
        classes.push(fieldClass(text));
      }
    }
    if (type === "variable" && !classes.includes("cm-sem-constant")) {
      if (modifiers.includes("readonly")) classes.push("cm-sem-constant");
      else if (modifiers.includes("static")) classes.push("cm-sem-global");
      else if (kind !== "call" && text !== "_") classes.push(localVariableClass);
    }
  },
  isLocal: ({ type, modifiers }) => type === "parameter" || (type === "variable" && !modifiers.includes("readonly")),
};

registerLanguageSemantics("go", goSemantics);
