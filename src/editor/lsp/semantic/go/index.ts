import { registerLanguageSemantics, type LanguageSemantics, type SemanticRange } from "../languages";
import type { SyntaxNode } from "@lezer/common";

const localVariableClass = "cm-sem-go-local-variable";
const packageClass = "cm-sem-go-package";
const receiverClass = "cm-sem-go-method-receiver";

function receiverName(method: SyntaxNode): SyntaxNode | null | undefined {
  return method.getChild("Parameters")?.getChild("Parameter")?.getChild("DefName");
}

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
  symbolKinds(tree, doc) {
    const kinds = new Map<string, string>();
    let receiver: string | undefined;
    let shadowDepth = 0;
    tree.iterate({
      enter({ name, node, from, to }) {
        if (name === "MethodDecl") {
          const definition = receiverName(node);
          if (definition) {
            const text = doc.sliceString(definition.from, definition.to);
            if (text !== "_") {
              receiver = text;
              kinds.set(`${definition.from}:${definition.to}`, "receiver");
            }
          }
        }
        if (receiver && name === "FunctionLiteral") {
          const shadows = node
            .getChild("Parameters")
            ?.getChildren("Parameter")
            .some((parameter) =>
              parameter
                .getChildren("DefName")
                .some((definition) => doc.sliceString(definition.from, definition.to) === receiver),
            );
          if (shadowDepth || shadows) shadowDepth++;
        }
        const parent = node.parent;
        if (name === "VariableName" && receiver && !shadowDepth && doc.sliceString(from, to) === receiver) {
          kinds.set(`${from}:${to}`, "receiver");
        } else if (
          (name === "FieldName" && parent?.name === "SelectorExpr" && parent.parent?.name === "CallExpr") ||
          (name === "VariableName" && parent?.name === "CallExpr")
        )
          kinds.set(`${from}:${to}`, "call");
      },
      leave({ name }) {
        if (name === "FunctionLiteral" && shadowDepth) shadowDepth--;
        if (name === "MethodDecl") receiver = undefined;
      },
    });
    return kinds;
  },
  fallbackRanges(tree, doc, _rainbow, symbols) {
    const ranges: SemanticRange[] = [];
    tree.iterate({
      enter({ name, node, from, to }) {
        const parent = node.parent?.name;
        if (name === "DefName" && symbols.get(`${from}:${to}`) === "receiver")
          ranges.push({ from, to, className: receiverClass, source: "fallback" });
        else if (name === "DefName" && (parent === "PackageClause" || parent === "ImportSpec")) {
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
    if (type === "parameter" && kind === "receiver") classes.push(receiverClass);
    if (type === "namespace" && !text.startsWith("go:")) {
      const index = classes.indexOf("cm-sem-namespace");
      if (index !== -1) classes[index] = packageClass;
    }
    const builtin = modifiers.includes("defaultLibrary");
    if (type === "function" && builtin) classes.push("cm-sem-go-builtin-function");
    if (type === "type") {
      if (builtin) classes.push("cm-sem-go-builtin-type");
      else if (!classes.includes("cm-sem-declaration")) {
        const index = classes.indexOf("cm-sem-type");
        if (index !== -1) classes[index] = "cm-sem-go-type-reference";
      }
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
  isLocal: ({ type, modifiers, kind }) =>
    (type === "parameter" && kind !== "receiver") || (type === "variable" && !modifiers.includes("readonly")),
};

registerLanguageSemantics("go", goSemantics);
