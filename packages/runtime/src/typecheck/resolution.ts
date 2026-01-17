/**
 * Shared module resolution logic for NatStack panels and workers.
 *
 * This module provides the canonical resolution rules used by both:
 * - The esbuild-based panel builder (at build time)
 * - The TypeScript language service (at dev time for type checking)
 *
 * By centralizing resolution logic here, we ensure type checking sees the same
 * module graph as the build system, eliminating false positives/negatives.
 */

/**
 * Configuration for module resolution behavior.
 */
export interface ModuleResolutionConfig {
  /** Enable fs module shimming (fs → @natstack/runtime async fs) */
  fsShimEnabled: boolean;
  /** Packages to deduplicate (force single instance) */
  dedupePackages: string[];
  /** Path to the runtime node_modules for deduped packages */
  runtimeNodeModules?: string;
}

/**
 * Result of resolving a module specifier.
 */
export type ResolutionResult =
  | { kind: "fs-shim" }
  | { kind: "path-shim" }
  | { kind: "natstack"; packageName: string }
  | { kind: "dedupe"; packageName: string }
  | { kind: "standard" };

/**
 * Default packages to deduplicate.
 * These use React context or other singleton patterns requiring single instances.
 */
export const DEFAULT_DEDUPE_PACKAGES = [
  "react",
  "react-dom",
  "@radix-ui/themes",
  "@radix-ui/react-*", // Wildcard for all Radix primitives
] as const;

/**
 * Async fs methods exported by @natstack/runtime.
 * Used by both the build shim and type definitions.
 */
export const FS_ASYNC_METHODS = [
  "readFile",
  "writeFile",
  "readdir",
  "stat",
  "lstat",
  "mkdir",
  "rmdir",
  "rm",
  "unlink",
  "exists",
  "access",
  "appendFile",
  "copyFile",
  "rename",
  "realpath",
  "open",
  "readlink",
  "symlink",
  "chmod",
  "chown",
  "utimes",
  "truncate",
] as const;

/**
 * Sync fs methods that are not available in browser environments.
 * The shim throws helpful errors for these.
 */
export const FS_SYNC_METHODS = [
  "readFileSync",
  "writeFileSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "mkdirSync",
  "rmdirSync",
  "rmSync",
  "unlinkSync",
  "existsSync",
  "accessSync",
  "appendFileSync",
  "copyFileSync",
  "renameSync",
  "realpathSync",
  "openSync",
  "readlinkSync",
  "symlinkSync",
  "chmodSync",
  "chownSync",
  "utimesSync",
  "truncateSync",
  "closeSync",
  "readSync",
  "writeSync",
  "fstatSync",
] as const;

/**
 * fs constants exported by the shim.
 */
export const FS_CONSTANTS = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_SYNC: 1052672,
  S_IFMT: 61440,
  S_IFREG: 32768,
  S_IFDIR: 16384,
  S_IFCHR: 8192,
  S_IFBLK: 24576,
  S_IFIFO: 4096,
  S_IFLNK: 40960,
  S_IFSOCK: 49152,
} as const;

/**
 * Check if a module specifier refers to Node's fs module.
 */
export function isFsModule(specifier: string): boolean {
  return (
    specifier === "fs" ||
    specifier === "node:fs" ||
    specifier === "fs/promises" ||
    specifier === "node:fs/promises"
  );
}

/**
 * Check if a module specifier refers to Node's path module.
 */
export function isPathModule(specifier: string): boolean {
  return (
    specifier === "path" ||
    specifier === "node:path" ||
    specifier === "path/posix" ||
    specifier === "node:path/posix"
  );
}

/**
 * Generate the path shim module code for esbuild.
 * Re-exports pathe which is browser-compatible.
 */
export function generatePathShimCode(): string {
  return `export * from "pathe";
import * as pathe from "pathe";
export default pathe;`;
}

/**
 * Check if a module specifier is for fs/promises (vs plain fs).
 */
export function isFsPromisesModule(specifier: string): boolean {
  return specifier === "fs/promises" || specifier === "node:fs/promises";
}

/**
 * Check if a module specifier refers to a @natstack/* package.
 */
export function isNatstackModule(specifier: string): boolean {
  return specifier.startsWith("@natstack/");
}

/**
 * Extract the package name from a @natstack/* specifier.
 */
export function getNatstackPackageName(specifier: string): string {
  // @natstack/runtime → runtime
  // @natstack/runtime/panel/fs → runtime
  const withoutScope = specifier.slice("@natstack/".length);
  const slashIndex = withoutScope.indexOf("/");
  return slashIndex === -1 ? withoutScope : withoutScope.slice(0, slashIndex);
}

/**
 * Convert a package specifier to a regex pattern for matching imports.
 *
 * Examples:
 * - "lodash" → matches "lodash" and "lodash/debounce"
 * - "@scope/pkg" → matches "@scope/pkg" and "@scope/pkg/sub"
 * - "@radix-ui/react-*" → matches "@radix-ui/react-select", "@radix-ui/react-dialog/sub"
 */
export function packageToRegex(pkg: string): RegExp {
  // Escape regex special characters except *
  const escaped = pkg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

  if (escaped.includes("*")) {
    // Wildcard pattern: @radix-ui/react-* → @radix-ui/react-[^/]+
    const pattern = escaped.replace(/\*/g, "[^/]+");
    return new RegExp(`^${pattern}(\\/.*)?$`);
  } else {
    // Exact package with optional subpaths
    return new RegExp(`^${escaped}(\\/.*)?$`);
  }
}

/**
 * Check if a module specifier matches any dedupe pattern.
 */
export function matchesDedupePattern(
  specifier: string,
  patterns: readonly string[]
): boolean {
  for (const pkg of patterns) {
    if (packageToRegex(pkg).test(specifier)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a module specifier according to NatStack's resolution rules.
 *
 * @param specifier - The module specifier (e.g., "fs", "@natstack/runtime", "react")
 * @param config - Resolution configuration
 * @returns Resolution result indicating how the module should be resolved
 */
export function resolveModule(
  specifier: string,
  config: ModuleResolutionConfig
): ResolutionResult {
  // 1. FS shim resolution
  if (config.fsShimEnabled && isFsModule(specifier)) {
    return { kind: "fs-shim" };
  }

  // 2. Path shim resolution (always enabled when fs shim is enabled)
  if (config.fsShimEnabled && isPathModule(specifier)) {
    return { kind: "path-shim" };
  }

  // 3. @natstack/* resolution
  if (isNatstackModule(specifier)) {
    return { kind: "natstack", packageName: getNatstackPackageName(specifier) };
  }

  // 4. Dedupe resolution
  if (matchesDedupePattern(specifier, config.dedupePackages)) {
    return { kind: "dedupe", packageName: specifier };
  }

  // 5. Standard resolution
  return { kind: "standard" };
}

/**
 * Generate the fs shim module code for esbuild.
 *
 * @param isPromises - Whether this is fs/promises (true) or fs (false)
 */
export function generateFsShimCode(isPromises: boolean): string {
  const asyncExports = FS_ASYNC_METHODS.map(
    (m) => `export const ${m} = fs.${m}.bind(fs);`
  ).join("\n");

  const syncStubs = FS_SYNC_METHODS.map(
    (m) =>
      `export function ${m}() { throw new Error("Synchronous fs methods (${m}) are not available in NatStack panels. Use the async version instead."); }`
  ).join("\n");

  const fsConstants = `
export const constants = ${JSON.stringify(FS_CONSTANTS, null, 2)};`;

  if (isPromises) {
    // fs/promises - just export async methods
    return `import { fs } from "@natstack/runtime";
export default fs;
${asyncExports}
`;
  } else {
    // fs - export promises, async methods, sync stubs, and constants
    return `import { fs } from "@natstack/runtime";
export default { ...fs, promises: fs };
export const promises = fs;
${asyncExports}
${syncStubs}
${fsConstants}
`;
  }
}

/**
 * Check if a string is a bare specifier (npm package, not a path).
 */
export function isBareSpecifier(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  if (spec.startsWith("data:") || spec.startsWith("node:")) return false;
  // Exclude virtual/shim modules with protocol-like prefixes
  if (spec.includes(":")) return false;
  // Exclude file paths with common JS/TS/CSS/asset extensions (but not npm packages like lodash.merge)
  // CSS and other assets can be imported by esbuild but should not be treated as npm packages
  if (/\.(js|mjs|cjs|ts|mts|cts|tsx|jsx|json|css|scss|sass|less|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|eot)$/i.test(spec)) return false;
  return true;
}
