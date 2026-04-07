/**
 * Workspace package discovery for type checking.
 *
 * Walks up from a starting directory to find a pnpm-workspace.yaml (or
 * package.json with workspaces), then scans every package referenced by
 * that manifest and builds a name → directory map keyed by the actual
 * `name` field of each package.json.
 *
 * This is the single source of truth for "which name maps to which on-disk
 * directory" — used by the TypeCheckService's module resolver to bypass
 * scope-prefix guessing (which broke when packages like @natstack/pubsub
 * lived under workspace/packages/ instead of the obvious packages/).
 *
 * Also hosts the `resolveExportSubpath` helper for walking package.json
 * `exports` trees — placed here so the resolver and the export-map utility
 * live in the same module.
 */

import * as fs from "fs";
import * as path from "path";

// ===========================================================================
// package.json `exports` resolution
// ===========================================================================

/**
 * Conditions to walk when resolving an export subpath for the TypeScript
 * service. We prefer explicit `types` over `default` so `.d.ts` files win
 * when a package ships both compiled JS and type declarations.
 */
export const WORKSPACE_CONDITIONS = ["types", "default"] as const;

/**
 * Resolve a single subpath export from a package.json `exports` map.
 *
 * Walks `conditions` in order, recursing into nested condition objects
 * (e.g. `{ "import": { "types": "..." } }`). Returns the resolved path
 * string or `null` if the subpath is not exported.
 *
 * Shared between the TypeCheckService and the esbuild panel builder — any
 * change here affects both.
 */
export function resolveExportSubpath(
  exports: Record<string, unknown>,
  subpath: string,
  conditions: readonly string[],
): string | null {
  const exportValue = exports[subpath];
  if (exportValue === undefined) return null;
  return resolveConditionValue(exportValue, conditions);
}

function resolveConditionValue(
  value: unknown,
  conditions: readonly string[],
): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  for (const cond of conditions) {
    if (obj[cond] === undefined) continue;
    const resolved = resolveConditionValue(obj[cond], conditions);
    if (resolved) return resolved;
  }
  return null;
}

// ===========================================================================
// Import specifier parsing
// ===========================================================================

/** Parsed components of a `@workspace<scope>/name[/subpath]` import specifier. */
export interface WorkspaceImportParts {
  /** Full package name including scope, e.g. `"@workspace/runtime"`. */
  packageName: string;
  /** Exports-map-style subpath, either `"."` or `"./subpath"`. */
  subpath: string;
}

/**
 * Parse a workspace-scoped import specifier into its package name and
 * subpath parts. Matches any `@workspace` or `@workspace-*` scope (the
 * builder uses `@workspace-panels/*`, `@workspace-about/*`, etc).
 *
 * Returns `null` for specifiers that aren't workspace-scoped.
 *
 * Examples:
 *   "@workspace/runtime"                → { packageName: "@workspace/runtime", subpath: "." }
 *   "@workspace/runtime/config"         → { packageName: "@workspace/runtime", subpath: "./config" }
 *   "@workspace-panels/chat/index.tsx"  → { packageName: "@workspace-panels/chat", subpath: "./index.tsx" }
 */
export function parseWorkspaceImport(importPath: string): WorkspaceImportParts | null {
  const match = importPath.match(/^(@workspace(?:-\w+)?)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const packageName = `${match[1]}/${match[2]}`;
  const rest = match[3] ?? "";
  const subpath = rest ? `.${rest}` : ".";
  return { packageName, subpath };
}

// ===========================================================================
// Workspace discovery
// ===========================================================================

export interface WorkspacePackageInfo {
  /** The package's `name` field */
  name: string;
  /** Absolute path to the package directory */
  dir: string;
  /** Parsed package.json contents */
  packageJson: PackageJsonShape;
}

export interface WorkspaceContext {
  /** Absolute path to the monorepo root (directory containing the workspace manifest) */
  monorepoRoot: string;
  /** Map from package name (e.g. "@natstack/pubsub") to package info */
  packages: Map<string, WorkspacePackageInfo>;
}

interface PackageJsonShape {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: Record<string, unknown> | string;
  [key: string]: unknown;
}

/** Module-level cache keyed by monorepo root. */
const contextCache = new Map<string, WorkspaceContext>();

/** Clear the workspace context cache. Call when packages are added/removed. */
export function clearWorkspaceContextCache(): void {
  contextCache.clear();
}

/**
 * Walk up from `startDir` looking for a pnpm-workspace.yaml or a
 * package.json with a `workspaces` field. Returns the directory containing
 * the manifest, or null if none is found.
 */
export function findMonorepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  // Cap at 20 levels to avoid pathological loops on broken filesystems
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const pkgJson = path.join(current, "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgJson, "utf-8")) as { workspaces?: unknown };
        if (parsed.workspaces) {
          return current;
        }
      } catch {
        // Malformed package.json — keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Read the package globs declared in pnpm-workspace.yaml or package.json's
 * `workspaces` field. Returns an empty array if no manifest is present.
 *
 * The pnpm-workspace.yaml parser handles the common case of a top-level
 * `packages:` list (with `'glob'` or `glob` entries) — we don't pull in a
 * full YAML dependency just for this.
 */
function readWorkspaceGlobs(monorepoRoot: string): string[] {
  const yamlPath = path.join(monorepoRoot, "pnpm-workspace.yaml");
  if (fs.existsSync(yamlPath)) {
    try {
      const content = fs.readFileSync(yamlPath, "utf-8");
      return parsePnpmWorkspaceYaml(content);
    } catch {
      /* fall through */
    }
  }

  const pkgJsonPath = path.join(monorepoRoot, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      if (Array.isArray(parsed.workspaces)) return parsed.workspaces;
      if (parsed.workspaces?.packages) return parsed.workspaces.packages;
    } catch {
      /* fall through */
    }
  }

  return [];
}

/**
 * Minimal pnpm-workspace.yaml parser. Extracts the entries under the
 * top-level `packages:` key. Handles `- 'glob'`, `- "glob"`, `- glob`,
 * with leading whitespace and # comments.
 */
function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;

  for (const rawLine of lines) {
    // Strip comments and trailing whitespace
    const stripped = rawLine.replace(/#.*$/, "").replace(/\s+$/, "");
    if (!stripped) continue;

    // Detect entering the packages: list
    if (/^packages\s*:\s*$/.test(stripped)) {
      inPackages = true;
      continue;
    }

    // A new top-level key ends the packages section
    if (inPackages && /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(stripped)) {
      inPackages = false;
    }

    if (!inPackages) continue;

    // Match list entries: optional indent, dash, value
    const m = stripped.match(/^\s*-\s*(.+)$/);
    if (!m) continue;
    let value = m[1]!.trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) globs.push(value);
  }

  return globs;
}

/**
 * Expand a single workspace glob (e.g. "packages/*") into the list of
 * directories that match. Only supports the trailing `*` wildcard at the
 * last segment, which covers the patterns used in this repo.
 */
function expandGlob(monorepoRoot: string, glob: string): string[] {
  // Normalize separators
  const normalized = glob.replace(/\\/g, "/");

  // Exact directory (no wildcard)
  if (!normalized.includes("*")) {
    const dir = path.resolve(monorepoRoot, normalized);
    return fs.existsSync(dir) ? [dir] : [];
  }

  // Trailing wildcard: parent/*
  const lastSlash = normalized.lastIndexOf("/");
  const parent = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ".";
  const pattern = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;

  // Only support pattern == "*" — the only form used in this repo
  if (pattern !== "*") return [];

  const parentAbs = path.resolve(monorepoRoot, parent);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parentAbs, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    results.push(path.join(parentAbs, entry.name));
  }
  return results;
}

/**
 * Discover the workspace context from a starting directory.
 *
 * Returns the monorepo root and a map of all package names to package
 * info, or null if no workspace manifest is found.
 *
 * Results are cached per monorepo root.
 */
export function discoverWorkspaceContext(startDir: string): WorkspaceContext | null {
  const monorepoRoot = findMonorepoRoot(startDir);
  if (!monorepoRoot) return null;

  const cached = contextCache.get(monorepoRoot);
  if (cached) return cached;

  const globs = readWorkspaceGlobs(monorepoRoot);
  const packages = new Map<string, WorkspacePackageInfo>();

  for (const glob of globs) {
    for (const pkgDir of expandGlob(monorepoRoot, glob)) {
      const pkgJsonPath = path.join(pkgDir, "package.json");
      if (!fs.existsSync(pkgJsonPath)) continue;

      let parsed: PackageJsonShape;
      try {
        parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as PackageJsonShape;
      } catch {
        continue;
      }
      if (!parsed.name) continue;

      // First entry wins on duplicate names — manifest order matters less
      // than the actual on-disk content the user is editing.
      if (!packages.has(parsed.name)) {
        packages.set(parsed.name, {
          name: parsed.name,
          dir: pkgDir,
          packageJson: parsed,
        });
      }
    }
  }

  const context: WorkspaceContext = { monorepoRoot, packages };
  contextCache.set(monorepoRoot, context);
  return context;
}
