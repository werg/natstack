import { transform } from "sucrase";

export interface TransformOptions {
  /** Source syntax: typescript, jsx, or tsx */
  syntax: "typescript" | "jsx" | "tsx";
}

export interface TransformResult {
  code: string;
  /** Module specifiers found in require() calls */
  requires: string[];
}

/**
 * Transform TypeScript/TSX/JSX to CommonJS JavaScript using Sucrase.
 */
export function transformCode(source: string, options: TransformOptions): TransformResult {
  const transforms: ("typescript" | "jsx" | "imports")[] = ["imports"];

  if (options.syntax === "typescript" || options.syntax === "tsx") {
    transforms.push("typescript");
  }
  if (options.syntax === "jsx" || options.syntax === "tsx") {
    transforms.push("jsx");
  }

  const result = transform(source, {
    transforms,
    jsxRuntime: "automatic",
    jsxImportSource: "react",
    disableESTransforms: true,
  });

  const requires = extractRequires(result.code);

  return {
    code: result.code,
    requires,
  };
}

/**
 * Extract module specifiers from require() calls.
 * Used to validate all dependencies are available before execution.
 */
function extractRequires(code: string): string[] {
  const matches = Array.from(code.matchAll(/require\(["']([^"']+)["']\)/g));
  const specifiers: string[] = [];
  for (const match of matches) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return Array.from(new Set(specifiers));
}
