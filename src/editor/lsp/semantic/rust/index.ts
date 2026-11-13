import type { SyntaxNode } from "@lezer/common";
import type { RustColorRole } from "@/platform/rustColors";
import {
  registerLanguageSemantics,
  type LanguageSemantics,
  type SemanticRange,
  type SemanticToken,
} from "../languages";

const primitive = /^(?:[iu](?:8|16|32|64|128|size)|f(?:16|32|64|128)|bool|char|str)$/;
const lexical = new Map<string, RustColorRole>([
  ["Lifetime", "lifetime"],
  ["String", "string"],
  ["RawString", "string"],
  ["Char", "character"],
  ["Integer", "number"],
  ["Float", "number"],
  ["LineComment", "line-comment"],
  ["BlockComment", "block-comment"],
  ["ArithOp", "operator"],
  ["BitOp", "operator"],
  ["LogicOp", "operator"],
  ["UpdateOp", "operator"],
  ["CompareOp", "operator"],
  ["DerefOp", "operator"],
  ["=", "operator"],
  ["&", "operator"],
]);

// Rust-analyzer distinguishes the semantic roles that cannot be inferred from spelling alone.
const server = new Map<string, RustColorRole>([
  ["struct", "struct"],
  ["union", "union"],
  ["enum", "enum"],
  ["interface", "trait"],
  ["typeAlias", "type-alias"],
  ["typeParameter", "type-parameter"],
  ["lifetime", "lifetime"],
  ["builtinType", "primitive-type"],
  ["parameter", "parameter"],
  ["property", "field"],
  ["const", "constant"],
  ["macro", "macro"],
  ["procMacro", "macro"],
  ["keyword", "keyword"],
  ["number", "number"],
  ["string", "string"],
  ["character", "character"],
]);

function functionRole(method: boolean, associated: boolean, trait: boolean, declaration: boolean): RustColorRole {
  if (method) {
    if (trait) return declaration ? "trait-method" : "trait-method-call";
    return declaration ? "method" : "method-call";
  }
  if (associated) {
    if (trait) return declaration ? "associated-trait-function" : "associated-trait-function-call";
    return declaration ? "associated-function" : "associated-function-call";
  }
  return declaration ? "function" : "function-call";
}

function tokenRole({ type, text, modifiers, classes }: SemanticToken): RustColorRole | undefined {
  if (type === "function" || type === "method")
    return functionRole(
      type === "method",
      modifiers.includes("associated"),
      modifiers.includes("trait"),
      classes.includes("cm-sem-declaration"),
    );
  if (type === "variable") {
    if (classes.includes("cm-sem-constant")) return "constant";
    if (!modifiers.includes("static") && text !== "_") return "variable";
    return;
  }
  if (type === "namespace") return modifiers.includes("crateRoot") ? "crate" : "module";
  if (type === "selfKeyword") return modifiers.includes("declaration") ? "self-parameter" : "self-expression";
  if (type === "selfParameter") return "self-parameter";
  if (type === "selfTypeKeyword" || type === "boolean") return "keyword";
  if (type === "comment" && !modifiers.includes("documentation"))
    return text.startsWith("/*") ? "block-comment" : "line-comment";
  if (type === "operator" && /^(?:[+*/%=<>!&|^~?-]+|\.(?:\.=?)?)$/.test(text) && text !== ".") return "operator";
  if (type === "string" && /^(?:b)?'/.test(text)) return "character";
  // The bang has its own RustRover key, separate from the macro name.
  if (type === "macro" && text === "!") return;
  return server.get(type);
}

function syntaxRole(node: SyntaxNode, text: string): RustColorRole | undefined {
  const parent = node.parent;
  const context = parent?.name;
  const qualified = context === "ScopedIdentifier" || context === "ScopedTypeIdentifier" ? parent : null;
  if (node.name === "TypeIdentifier" || node.name === "Identifier") {
    if (
      context === "MacroInvocation" ||
      context === "MacroDefinition" ||
      context === "DeclarativeMacroItem" ||
      qualified?.parent?.name === "MacroInvocation"
    )
      return "macro";
  }
  if (node.name === "TypeIdentifier") {
    if (parent?.getChild("TypeIdentifier")?.from === node.from) {
      if (context === "StructItem") return "struct";
      if (context === "UnionItem") return "union";
      if (context === "EnumItem") return "enum";
      if (context === "TraitItem") return "trait";
      if (context === "TypeItem" || context === "AssociatedType") return "type-alias";
      if (context === "ConstrainedTypeParameter" || context === "OptionalTypeParameter") return "type-parameter";
    }
    if (context === "TypeParamList") return "type-parameter";
    if (!qualified && primitive.test(text)) return "primitive-type";
  }
  if (node.name === "BoundIdentifier") {
    if (context === "Parameter") return "parameter";
    if (context === "LetDeclaration") return "variable";
    if (context === "ConstItem") return "constant";
    if (context === "ModItem") return "module";
    if (context === "FunctionItem") {
      const owner = parent?.parent?.parent;
      const associated = owner?.name === "ImplItem" || owner?.name === "TraitItem";
      const method = associated && !!parent?.getChild("ParamList")?.getChild("SelfParameter");
      const trait = owner?.name === "TraitItem" || (owner?.name === "ImplItem" && !!owner.getChild("for"));
      return functionRole(method, associated, trait, true);
    }
  }
  if (node.name === "Identifier" && context === "CallExpression" && parent?.firstChild?.from === node.from)
    return "function-call";
  if (node.name === "FieldIdentifier")
    return context === "FieldExpression" &&
      parent?.parent?.name === "CallExpression" &&
      parent.parent.firstChild?.from === parent.from
      ? "method-call"
      : "field";
  if (node.name === "self")
    return context === "SelfParameter" || context === "SelfPattern" ? "self-parameter" : "self-expression";
  if (node.name === "Boolean" || node.name === "SelfType") return "keyword";
  if (/^[a-z_]+$/.test(node.name) && node.name === text) return "keyword";
  if (node.name === "LineComment" && /^(?:\/\/!|\/\/\/(?!\/))/.test(text)) return;
  if (node.name === "BlockComment" && /^(?:\/\*!|\/\*\*(?![*/]))/.test(text)) return;
  return lexical.get(node.name);
}

const rustSemantics: LanguageSemantics = {
  tokenClasses(token) {
    const role = tokenRole(token);
    if (role) token.classes.push(`cm-sem-rust-${role}`);
  },
  fallbackRanges(tree, doc) {
    const ranges: SemanticRange[] = [];
    const add = (from: number, to: number, role: RustColorRole) => {
      if (from < to) ranges.push({ from, to, className: `cm-sem-rust-${role}`, source: "fallback" });
    };
    tree.iterate({
      enter({ node, from, to }) {
        if (from === to || (node.firstChild && !lexical.has(node.name))) return;
        const role = syntaxRole(node, doc.sliceString(from, to));
        if (!role) return;
        // Leave escapes and nested tokens to their own highlighting.
        let start = from;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          add(start, child.from, role);
          start = child.to;
        }
        add(start, to, role);
      },
    });
    return ranges;
  },
};

registerLanguageSemantics("rust", rustSemantics);
