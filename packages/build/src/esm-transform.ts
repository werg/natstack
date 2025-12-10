/**
 * ESM → async-executable transformer.
 *
 * Parses ESM (with JSX) and rewrites imports/exports so it can be run inside
 * an AsyncFunction with a custom import resolver.
 *
 * Note: TypeScript support is NOT needed here because esbuild already compiles
 * TS/TSX to JS/JSX before this transformation runs.
 */
import { Parser } from "acorn";
import jsx from "acorn-jsx";
import { generate } from "astring";

export interface EsmTransformOptions {
  /** Identifier used for import function (defaults to __importModule__) */
  importIdentifier?: string;
  /** Identifier used for exports object (defaults to __exports__) */
  exportIdentifier?: string;
}

/**
 * Error thrown when ESM transformation fails.
 */
export class EsmTransformError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly location?: { line: number; column: number }
  ) {
    super(message);
    this.name = "EsmTransformError";
  }
}

// We use `any` for AST nodes because:
// 1. acorn's types require start/end positions we don't have when constructing nodes
// 2. astring accepts any ESTree-like objects
// 3. The type complexity doesn't add value for this transformation code
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = any;

const AcornParser = Parser.extend(jsx());

// AST node constructors

function id(name: string): AstNode {
  return { type: "Identifier", name };
}

function literal(value: string): AstNode {
  return { type: "Literal", value, raw: JSON.stringify(value) };
}

/**
 * Create a member expression.
 * Uses dot notation (obj.prop) for valid identifiers, bracket notation (obj["prop"]) otherwise.
 */
function member(obj: AstNode, prop: string): AstNode {
  const isValidIdentifier = /^[$A-Z_a-z][$\w]*$/.test(prop);
  return {
    type: "MemberExpression",
    object: obj,
    property: isValidIdentifier ? id(prop) : literal(prop),
    computed: !isValidIdentifier,
    optional: false,
  };
}

function assign(left: AstNode, right: AstNode): AstNode {
  return { type: "AssignmentExpression", operator: "=", left, right };
}

function variable(
  name: AstNode,
  init: AstNode,
  kind: "const" | "let" | "var" = "const"
): AstNode {
  return {
    type: "VariableDeclaration",
    kind,
    declarations: [{ type: "VariableDeclarator", id: name, init }],
  };
}

function awaitCall(callee: AstNode, args: AstNode[]): AstNode {
  return {
    type: "AwaitExpression",
    argument: {
      type: "CallExpression",
      callee,
      arguments: args,
      optional: false,
    },
  };
}

function awaitImport(importId: AstNode, source: string): AstNode {
  return awaitCall(importId, [literal(source)]);
}

function exprStmt(expression: AstNode): AstNode {
  return { type: "ExpressionStatement", expression };
}

function createTempNamer(prefix: string): () => AstNode {
  let counter = 0;
  return () => id(`__${prefix}_${++counter}`);
}

// Import/export analysis helpers

function isTypeOnlyImport(node: AstNode): boolean {
  if (node.importKind === "type") return true;
  if (!node.specifiers || node.specifiers.length === 0) return false;
  return node.specifiers.every(
    (s: AstNode) => s.importKind === "type" || node.importKind === "type"
  );
}

function collectDeclaredIdentifiers(decl: AstNode): AstNode[] {
  const ids: AstNode[] = [];

  const collect = (pattern: AstNode): void => {
    if (!pattern) return;

    switch (pattern.type) {
      case "Identifier":
        ids.push(pattern);
        break;
      case "ObjectPattern":
        for (const prop of pattern.properties) {
          if (prop.type === "Property") {
            collect(prop.value);
          } else if (prop.type === "RestElement") {
            collect(prop.argument);
          }
        }
        break;
      case "ArrayPattern":
        for (const el of pattern.elements) {
          if (el) collect(el);
        }
        break;
      case "RestElement":
        collect(pattern.argument);
        break;
      case "AssignmentPattern":
        collect(pattern.left);
        break;
    }
  };

  if (decl.type === "VariableDeclaration") {
    for (const d of decl.declarations) {
      collect(d.id);
    }
  } else if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
    if (decl.id) ids.push(decl.id);
  }

  return ids;
}

// Statement transformers

function buildImportBinding(
  node: AstNode,
  importId: AstNode,
  tempName: () => AstNode
): AstNode[] {
  const src = node.source?.value;
  if (typeof src !== "string") return [];

  const statements: AstNode[] = [];

  // Side-effect only import: import "mod";
  if (!node.specifiers || node.specifiers.length === 0) {
    statements.push(exprStmt(awaitImport(importId, src)));
    return statements;
  }

  const defaultSpec = node.specifiers.find(
    (s: AstNode) => s.type === "ImportDefaultSpecifier"
  );
  const namespaceSpec = node.specifiers.find(
    (s: AstNode) => s.type === "ImportNamespaceSpecifier"
  );
  const namedSpecs = node.specifiers.filter((s: AstNode) => {
    if (s.type !== "ImportSpecifier") return false;
    return s.importKind !== "type";
  });

  // import * as ns from "mod";
  if (namespaceSpec && !defaultSpec && namedSpecs.length === 0) {
    statements.push(variable(namespaceSpec.local, awaitImport(importId, src)));
    return statements;
  }

  // Mixed/default/named imports => destructure the module
  const temp = namespaceSpec?.local ?? tempName();
  statements.push(variable(temp, awaitImport(importId, src)));

  const properties: AstNode[] = [];

  if (defaultSpec) {
    properties.push({
      type: "Property",
      kind: "init",
      method: false,
      shorthand: defaultSpec.local.name === "default",
      computed: false,
      key: id("default"),
      value: defaultSpec.local,
    });
  }

  for (const spec of namedSpecs) {
    const importedName =
      spec.imported.type === "Identifier"
        ? spec.imported.name
        : String(spec.imported.value);
    properties.push({
      type: "Property",
      kind: "init",
      method: false,
      shorthand: importedName === spec.local.name,
      computed: false,
      key: id(importedName),
      value: spec.local,
    });
  }

  if (properties.length > 0) {
    statements.push(
      variable({ type: "ObjectPattern", properties }, temp)
    );
  }

  return statements;
}

function buildExportAssignments(
  ids: AstNode[],
  exportId: AstNode,
  exportNames?: string[]
): AstNode[] {
  const names = exportNames ?? ids.map((i: AstNode) => i.name);
  return ids.map((idNode: AstNode, idx: number) => {
    const exportName = names[idx] ?? idNode.name;
    return exprStmt(assign(member(exportId, exportName), idNode));
  });
}

function transformStatement(
  stmt: AstNode,
  importId: AstNode,
  exportId: AstNode,
  tempName: () => AstNode
): AstNode[] {
  // Imports
  if (stmt.type === "ImportDeclaration") {
    if (isTypeOnlyImport(stmt)) return [];
    return buildImportBinding(stmt, importId, tempName);
  }

  // export default ...
  if (stmt.type === "ExportDefaultDeclaration") {
    const decl = stmt.declaration;

    // export default function foo() {} or export default class Foo {}
    if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
      const idNode = decl.id ?? tempName();

      // Create the declaration with an id if it was anonymous
      const namedDecl = decl.id ? decl : { ...decl, id: idNode };

      return [
        namedDecl,
        exprStmt(assign(member(exportId, "default"), idNode)),
      ];
    }

    // export default <expression>
    return [exprStmt(assign(member(exportId, "default"), decl))];
  }

  // export { ... } or export const/let/var/function/class
  if (stmt.type === "ExportNamedDeclaration") {
    if (stmt.exportKind === "type") return [];

    const statements: AstNode[] = [];

    // export { foo, bar as baz } from "mod";
    if (stmt.source) {
      const modTemp = tempName();
      statements.push(
        variable(modTemp, awaitImport(importId, stmt.source.value as string))
      );

      for (const spec of stmt.specifiers) {
        if (spec.type !== "ExportSpecifier") continue;
        const exportedName =
          spec.exported.type === "Identifier"
            ? spec.exported.name
            : String(spec.exported.value);
        const localName =
          spec.local.type === "Identifier"
            ? spec.local.name
            : String(spec.local.value);
        statements.push(
          exprStmt(assign(member(exportId, exportedName), member(modTemp, localName)))
        );
      }
      return statements;
    }

    // export const foo = 1; export function bar() {}
    if (stmt.declaration) {
      statements.push(stmt.declaration);
      const ids = collectDeclaredIdentifiers(stmt.declaration);
      statements.push(...buildExportAssignments(ids, exportId));
      return statements;
    }

    // export { foo, bar as baz }
    for (const spec of stmt.specifiers) {
      if (spec.type !== "ExportSpecifier") continue;
      const exportedName =
        spec.exported.type === "Identifier"
          ? spec.exported.name
          : String(spec.exported.value);
      const localName =
        spec.local.type === "Identifier" ? spec.local.name : "default";
      statements.push(exprStmt(assign(member(exportId, exportedName), id(localName))));
    }
    return statements;
  }

  // export * from "mod"; or export * as ns from "mod";
  if (stmt.type === "ExportAllDeclaration") {
    const modTemp = tempName();
    const statements: AstNode[] = [
      variable(modTemp, awaitImport(importId, stmt.source.value as string)),
    ];

    if (stmt.exported) {
      // export * as ns from "mod";
      const exportedName =
        stmt.exported.type === "Identifier"
          ? stmt.exported.name
          : String(stmt.exported.value);
      statements.push(exprStmt(assign(member(exportId, exportedName), modTemp)));
    } else {
      // export * from "mod"; -> Object.assign(__exports__, mod)
      statements.push(
        exprStmt({
          type: "CallExpression",
          callee: member(id("Object"), "assign"),
          arguments: [exportId, modTemp],
          optional: false,
        })
      );
    }
    return statements;
  }

  // Plain statement - pass through
  return [stmt];
}

/**
 * Transform ESM code for execution via AsyncFunction.
 *
 * Converts imports to dynamic imports and rewrites exports to assignments
 * to a provided exports object identifier.
 *
 * @throws EsmTransformError if parsing or transformation fails
 */
export function transformEsmForAsyncExecution(
  code: string,
  options: EsmTransformOptions = {}
): string {
  const importId = id(options.importIdentifier ?? "__importModule__");
  const exportId = id(options.exportIdentifier ?? "__exports__");

  // Parse the ESM code
  let ast: AstNode;
  try {
    ast = AcornParser.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
  } catch (parseError) {
    const err = parseError as Error & { loc?: { line: number; column: number } };
    const location = err.loc;
    const locationStr = location
      ? ` at line ${location.line}, column ${location.column}`
      : "";
    throw new EsmTransformError(
      `ESM parse error${locationStr}: ${err.message}`,
      err,
      location
    );
  }

  // Transform statements
  const newBody: AstNode[] = [];
  const nextTemp = createTempNamer("mod");

  try {
    for (const stmt of ast.body) {
      newBody.push(...transformStatement(stmt, importId, exportId, nextTemp));
    }
  } catch (transformError) {
    const err = transformError as Error;
    throw new EsmTransformError(`ESM transform error: ${err.message}`, err);
  }

  // Generate output code
  const newAst = {
    ...ast,
    body: newBody,
    sourceType: "module",
  };

  try {
    return generate(newAst, { indent: "  " });
  } catch (generateError) {
    const err = generateError as Error;
    throw new EsmTransformError(`ESM code generation error: ${err.message}`, err);
  }
}
