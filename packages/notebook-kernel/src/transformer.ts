/**
 * Cell Transformer
 *
 * Uses acorn to parse cell code and transform top-level declarations
 * into scope assignments, enabling variable persistence across cells.
 *
 * Also transforms:
 * - Import declarations → dynamic imports
 * - Export declarations → local variables with scope assignment
 */

import * as acorn from "acorn";
import type { TransformResult } from "./types.js";

// Acorn node types we care about
type AcornNode = acorn.Node & {
  type: string;
  kind?: "const" | "let" | "var";
  id?: { name: string; start: number; end: number };
  declarations?: Array<{ id: AcornPattern; init?: AcornNode }>;
  body?: AcornNode[];
  source?: { value: string; raw: string };
  specifiers?: Array<{
    type: string;
    local?: { name: string };
    imported?: { name: string };
    exported?: { name: string };
  }>;
  declaration?: AcornNode;
};

type AcornPattern = acorn.Node & {
  type: string;
  name?: string;
  properties?: Array<{
    type: string;
    value?: AcornPattern;
    argument?: AcornPattern;
  }>;
  elements?: Array<AcornPattern | null>;
  argument?: AcornPattern;
  left?: AcornPattern;
};

/** Transformation operation to apply */
interface Transformation {
  start: number;
  end: number;
  text: string;
}

/**
 * Transform cell code to hoist top-level declarations to the session scope.
 *
 * Transformations:
 * - `const x = 1;` → `const x = 1; __scope__.x = x;`
 * - `let y = 2;` → `let y = 2; __scope__.y = y;` (tracked as mutable)
 * - `function foo() {}` → `__scope__.foo = function foo() {};`
 * - `class Bar {}` → `__scope__.Bar = class Bar {};`
 * - `import x from 'mod'` → `const { default: x } = await __importModule__('mod');`
 * - `export const x = 1;` → `const x = 1; __scope__.x = x;`
 *
 * Nested declarations (in loops, blocks, functions) are NOT transformed.
 */
export function transformCell(code: string): TransformResult {
  let ast: acorn.Program;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
  } catch (error) {
    // Re-throw parse errors - the executor will handle them appropriately
    throw new Error(
      `Parse error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const constNames: string[] = [];
  const mutableNames: string[] = [];
  const transformations: Transformation[] = [];

  for (const node of ast.body as AcornNode[]) {
    switch (node.type) {
      case "VariableDeclaration": {
        const names = extractBindingNames(node);
        const isMutable = node.kind === "let" || node.kind === "var";
        if (isMutable) {
          mutableNames.push(...names);
        } else {
          constNames.push(...names);
        }
        const assignments = names.map((n) => `__scope__.${n} = ${n};`).join(" ");
        // Use replacement instead of insertion to avoid position conflicts
        transformations.push({
          start: node.start,
          end: node.end,
          text: code.slice(node.start, node.end) + " " + assignments,
        });
        break;
      }

      case "FunctionDeclaration": {
        if (node.id?.name) {
          const name = node.id.name;
          // Functions are mutable bindings (can be reassigned in subsequent cells)
          mutableNames.push(name);
          transformations.push({
            start: node.start,
            end: node.end,
            text: `__scope__.${name} = ${code.slice(node.start, node.end)};`,
          });
        }
        break;
      }

      case "ClassDeclaration": {
        if (node.id?.name) {
          const name = node.id.name;
          // Classes are mutable bindings
          mutableNames.push(name);
          transformations.push({
            start: node.start,
            end: node.end,
            text: `__scope__.${name} = ${code.slice(node.start, node.end)};`,
          });
        }
        break;
      }

      case "ImportDeclaration": {
        // Transform: import x from 'mod' → const { default: x } = await __importModule__('mod');
        // Transform: import { a, b } from 'mod' → const { a, b } = await __importModule__('mod');
        // Transform: import * as ns from 'mod' → const ns = await __importModule__('mod');
        const transformed = transformImportDeclaration(node);
        if (transformed) {
          constNames.push(...transformed.names);
          transformations.push({
            start: node.start,
            end: node.end,
            text: transformed.code,
          });
        }
        break;
      }

      case "ExportNamedDeclaration": {
        // Transform: export const x = 1; → const x = 1; __scope__.x = x;
        // Transform: export function foo() {} → __scope__.foo = function foo() {};
        if (node.declaration) {
          const decl = node.declaration;
          const declCode = code.slice(decl.start, decl.end);

          if (decl.type === "VariableDeclaration") {
            const names = extractBindingNames(decl);
            const isMutable = decl.kind === "let" || decl.kind === "var";
            if (isMutable) {
              mutableNames.push(...names);
            } else {
              constNames.push(...names);
            }
            const assignments = names.map((n) => `__scope__.${n} = ${n};`).join(" ");
            transformations.push({
              start: node.start,
              end: node.end,
              text: declCode + " " + assignments,
            });
          } else if (decl.type === "FunctionDeclaration" && decl.id?.name) {
            const name = decl.id.name;
            mutableNames.push(name);
            transformations.push({
              start: node.start,
              end: node.end,
              text: `__scope__.${name} = ${declCode};`,
            });
          } else if (decl.type === "ClassDeclaration" && decl.id?.name) {
            const name = decl.id.name;
            mutableNames.push(name);
            transformations.push({
              start: node.start,
              end: node.end,
              text: `__scope__.${name} = ${declCode};`,
            });
          }
        } else if (node.specifiers && node.specifiers.length > 0) {
          // export { a, b } - just remove the export (variables already in scope)
          // export { a, b } from 'mod' - import and assign
          if (node.source) {
            const specStr = node.specifiers
              .map((s) => {
                const local = s.local?.name ?? s.exported?.name;
                const exported = s.exported?.name ?? s.local?.name;
                if (local && exported) {
                  constNames.push(exported);
                  return local === exported ? local : `${local} as ${exported}`;
                }
                return null;
              })
              .filter(Boolean)
              .join(", ");
            const assignments = node.specifiers
              .map((s) => {
                const name = s.exported?.name ?? s.local?.name;
                return name ? `__scope__.${name} = ${name};` : null;
              })
              .filter(Boolean)
              .join(" ");
            transformations.push({
              start: node.start,
              end: node.end,
              text: `const { ${specStr} } = await __importModule__(${JSON.stringify(node.source.value)}); ${assignments}`,
            });
          } else {
            // Just strip the export keyword - variables already exist
            transformations.push({
              start: node.start,
              end: node.end,
              text: "", // Remove the entire export statement
            });
          }
        }
        break;
      }

      case "ExportDefaultDeclaration": {
        // Transform: export default expr → __scope__.default = expr;
        // We'll use __default__ to avoid keyword issues
        const declNode = node as AcornNode & { declaration: AcornNode };
        const declCode = code.slice(declNode.declaration.start, declNode.declaration.end);
        mutableNames.push("__default__");
        transformations.push({
          start: node.start,
          end: node.end,
          text: `__scope__.__default__ = ${declCode};`,
        });
        break;
      }

      case "ExportAllDeclaration": {
        // export * from 'mod' - re-export all to __exports__ to avoid polluting scope
        // export * as ns from 'mod' - namespace re-export
        const sourceNode = node as AcornNode & {
          source: { value: string };
          exported?: { name: string };
        };
        if (sourceNode.exported?.name) {
          // export * as ns from 'mod' - assign namespace
          const name = sourceNode.exported.name;
          mutableNames.push(name);
          transformations.push({
            start: node.start,
            end: node.end,
            text: `__scope__.${name} = await __importModule__(${JSON.stringify(sourceNode.source.value)});`,
          });
        } else {
          // export * from 'mod' - merge into exports object (not scope)
          // Warn about potential collisions since multiple export * statements will merge
          const warnCode = `
            (() => {
              const __mod = await __importModule__(${JSON.stringify(sourceNode.source.value)});
              const __existingKeys = Object.keys(__exports__);
              const __newKeys = Object.keys(__mod);
              const __collisions = __newKeys.filter(k => __existingKeys.includes(k));
              if (__collisions.length > 0) {
                console.warn("Export namespace collision: keys [" + __collisions.join(", ") + "] from '${sourceNode.source.value}' will overwrite existing exports");
              }
              Object.assign(__exports__, __mod);
            })()
          `.trim();
          transformations.push({
            start: node.start,
            end: node.end,
            text: warnCode,
          });
        }
        break;
      }
    }
  }

  // Apply transformations by building segments (more efficient than repeated slicing)
  if (transformations.length === 0) {
    return { code, constNames, mutableNames };
  }

  transformations.sort((a, b) => a.start - b.start);

  const segments: string[] = [];
  let lastIndex = 0;

  for (const t of transformations) {
    // Add unchanged code before this transformation
    if (t.start > lastIndex) {
      segments.push(code.slice(lastIndex, t.start));
    }
    // Add the transformed code
    segments.push(t.text);
    lastIndex = t.end;
  }

  // Add remaining code after last transformation
  if (lastIndex < code.length) {
    segments.push(code.slice(lastIndex));
  }

  return { code: segments.join(""), constNames, mutableNames };
}

/**
 * Transform an import declaration to a dynamic import.
 */
function transformImportDeclaration(
  node: AcornNode
): { code: string; names: string[] } | null {
  if (!node.source || typeof node.source.value !== "string") return null;
  const source = JSON.stringify(node.source.value);
  const names: string[] = [];

  if (!node.specifiers || node.specifiers.length === 0) {
    // import 'mod' - side effect only (e.g., polyfills, CSS)
    // Side effects execute but don't assign to scope, which is correct behavior
    return { code: `await __importModule__(${source});`, names: [] };
  }

  const parts: string[] = [];
  let hasNamespace = false;
  let namespaceName = "";

  for (const spec of node.specifiers) {
    if (spec.type === "ImportDefaultSpecifier" && spec.local?.name) {
      parts.push(`default: ${spec.local.name}`);
      names.push(spec.local.name);
    } else if (spec.type === "ImportSpecifier" && spec.local?.name) {
      const imported = spec.imported?.name ?? spec.local.name;
      if (imported === spec.local.name) {
        parts.push(imported);
      } else {
        parts.push(`${imported}: ${spec.local.name}`);
      }
      names.push(spec.local.name);
    } else if (spec.type === "ImportNamespaceSpecifier" && spec.local?.name) {
      hasNamespace = true;
      namespaceName = spec.local.name;
      names.push(namespaceName);
    }
  }

  let code: string;
  if (hasNamespace) {
    code = `const ${namespaceName} = await __importModule__(${source}); __scope__.${namespaceName} = ${namespaceName};`;
  } else {
    const destructure = `{ ${parts.join(", ")} }`;
    const assignments = names.map((n) => `__scope__.${n} = ${n};`).join(" ");
    code = `const ${destructure} = await __importModule__(${source}); ${assignments}`;
  }

  return { code, names };
}

/**
 * Extract all binding names from a variable declaration.
 */
function extractBindingNames(node: AcornNode): string[] {
  const names: string[] = [];
  if (node.declarations) {
    for (const decl of node.declarations) {
      extractFromPattern(decl.id, names);
    }
  }
  return names;
}

/**
 * Recursively extract variable names from a binding pattern.
 */
function extractFromPattern(pattern: AcornPattern, names: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      if (pattern.name) {
        names.push(pattern.name);
      }
      break;

    case "ObjectPattern":
      if (pattern.properties) {
        for (const prop of pattern.properties) {
          if (prop.type === "RestElement" && prop.argument) {
            extractFromPattern(prop.argument, names);
          } else if (prop.value) {
            extractFromPattern(prop.value, names);
          }
        }
      }
      break;

    case "ArrayPattern":
      if (pattern.elements) {
        for (const elem of pattern.elements) {
          if (elem) {
            extractFromPattern(elem, names);
          }
        }
      }
      break;

    case "RestElement":
      if (pattern.argument) {
        extractFromPattern(pattern.argument, names);
      }
      break;

    case "AssignmentPattern":
      if (pattern.left) {
        extractFromPattern(pattern.left, names);
      }
      break;
  }
}
