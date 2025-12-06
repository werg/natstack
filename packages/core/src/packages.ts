/**
 * Package Registry
 *
 * Runtime management of workspace-level package mappings for dynamic imports.
 * Provides two-tier resolution: project-level (package.json) and workspace-level (natstack.yml).
 */

/**
 * Specification for a package dependency.
 */
export interface PackageSpec {
  /** Git spec: "owner/repo#tag" or "owner/repo@branch" */
  gitSpec?: string;
  /** npm version spec: "^1.2.3" */
  npmSpec?: string;
  /** Resolved filesystem path (after clone/build) */
  resolvedPath?: string;
}

/**
 * Package registry interface for managing package mappings.
 */
export interface PackageRegistry {
  /** Get package spec by name, checking project then workspace */
  get(name: string): PackageSpec | undefined;

  /** Register/update a workspace-level package mapping */
  set(name: string, spec: string): void;

  /** Remove a workspace-level package mapping */
  delete(name: string): void;

  /** Get all workspace-level mappings */
  getWorkspacePackages(): Record<string, string>;

  /** Set project-level dependencies (from package.json) */
  setProjectDependencies(deps: Record<string, string>): void;

  /** Clear project-level dependencies */
  clearProjectDependencies(): void;

  /** Check if a package is registered */
  has(name: string): boolean;

  /** Get all registered package names */
  keys(): string[];
}

/**
 * Parse a dependency spec string into a PackageSpec.
 *
 * Formats:
 * - "owner/repo#tag" - Git tag (e.g., "user/lib#v1.0.0")
 * - "owner/repo@branch" - Git branch (e.g., "user/lib@main")
 * - "owner/repo@commit" - Git commit hash (e.g., "user/lib@abc1234")
 * - "^1.2.3" / "~1.2.3" - npm semver (marked external)
 * - "1.2.3" - exact npm version
 */
export function parseSpec(spec: string): PackageSpec {
  // Check for git shorthand patterns
  // Pattern: owner/repo#ref or owner/repo@ref
  const gitMatch = spec.match(/^([^/@]+\/[^/@]+)([#@])(.+)$/);
  if (gitMatch) {
    return { gitSpec: spec };
  }

  // Check for simple owner/repo (no ref specified, defaults to main)
  if (/^[^/@]+\/[^/@]+$/.test(spec) && !spec.startsWith("^") && !spec.startsWith("~")) {
    return { gitSpec: `${spec}@main` };
  }

  // npm version specs (semver ranges or exact versions)
  if (
    spec.startsWith("^") ||
    spec.startsWith("~") ||
    spec.startsWith(">=") ||
    spec.startsWith("<=") ||
    spec.startsWith(">") ||
    spec.startsWith("<") ||
    /^\d+\.\d+\.\d+/.test(spec) ||
    spec === "*" ||
    spec === "latest"
  ) {
    return { npmSpec: spec };
  }

  // Unknown format - treat as npm spec
  return { npmSpec: spec };
}

/**
 * Check if a spec is a git dependency.
 */
export function isGitSpec(spec: string): boolean {
  const parsed = parseSpec(spec);
  return parsed.gitSpec !== undefined;
}

/**
 * Check if a spec is an npm dependency.
 */
export function isNpmSpec(spec: string): boolean {
  const parsed = parseSpec(spec);
  return parsed.npmSpec !== undefined;
}

/**
 * Implementation of PackageRegistry.
 */
class PackageRegistryImpl implements PackageRegistry {
  private workspacePackages = new Map<string, string>();
  private projectDependencies = new Map<string, string>();
  private resolvedPaths = new Map<string, string>();

  get(name: string): PackageSpec | undefined {
    // Project-level takes precedence
    const projectSpec = this.projectDependencies.get(name);
    if (projectSpec) {
      const spec = parseSpec(projectSpec);
      const resolvedPath = this.resolvedPaths.get(name);
      if (resolvedPath) {
        spec.resolvedPath = resolvedPath;
      }
      return spec;
    }

    // Fall back to workspace-level
    const workspaceSpec = this.workspacePackages.get(name);
    if (workspaceSpec) {
      const spec = parseSpec(workspaceSpec);
      const resolvedPath = this.resolvedPaths.get(name);
      if (resolvedPath) {
        spec.resolvedPath = resolvedPath;
      }
      return spec;
    }

    return undefined;
  }

  set(name: string, spec: string): void {
    this.workspacePackages.set(name, spec);
    // Clear resolved path when spec changes
    this.resolvedPaths.delete(name);
  }

  delete(name: string): void {
    this.workspacePackages.delete(name);
    this.resolvedPaths.delete(name);
  }

  getWorkspacePackages(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, spec] of this.workspacePackages) {
      result[name] = spec;
    }
    return result;
  }

  setProjectDependencies(deps: Record<string, string>): void {
    this.projectDependencies.clear();
    for (const [name, spec] of Object.entries(deps)) {
      this.projectDependencies.set(name, spec);
    }
  }

  clearProjectDependencies(): void {
    this.projectDependencies.clear();
  }

  has(name: string): boolean {
    return this.projectDependencies.has(name) || this.workspacePackages.has(name);
  }

  keys(): string[] {
    const names = new Set<string>();
    for (const name of this.projectDependencies.keys()) {
      names.add(name);
    }
    for (const name of this.workspacePackages.keys()) {
      names.add(name);
    }
    return Array.from(names);
  }

  /**
   * Set the resolved path for a package (after clone/build).
   * This is called by the dependency resolver.
   */
  setResolvedPath(name: string, path: string): void {
    this.resolvedPaths.set(name, path);
  }

  /**
   * Get the resolved path for a package, if available.
   */
  getResolvedPath(name: string): string | undefined {
    return this.resolvedPaths.get(name);
  }

  /**
   * Clear all resolved paths (useful when filesystem changes).
   */
  clearResolvedPaths(): void {
    this.resolvedPaths.clear();
  }

  /**
   * Bulk set workspace packages from a config object.
   */
  setWorkspacePackages(packages: Record<string, string>): void {
    this.workspacePackages.clear();
    for (const [name, spec] of Object.entries(packages)) {
      this.workspacePackages.set(name, spec);
    }
  }
}

// Singleton registry instance
let registryInstance: PackageRegistryImpl | null = null;

/**
 * Get the singleton package registry instance.
 */
export function getPackageRegistry(): PackageRegistry & {
  setResolvedPath(name: string, path: string): void;
  getResolvedPath(name: string): string | undefined;
  clearResolvedPaths(): void;
  setWorkspacePackages(packages: Record<string, string>): void;
} {
  if (!registryInstance) {
    registryInstance = new PackageRegistryImpl();
  }
  return registryInstance;
}

/**
 * Reset the package registry (primarily for testing).
 */
export function resetPackageRegistry(): void {
  registryInstance = null;
}
