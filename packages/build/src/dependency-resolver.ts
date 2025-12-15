/**
 * Dependency Resolution
 *
 * Resolves package imports to filesystem paths or marks them as external.
 * Integrates with PackageRegistry for project and workspace-level dependencies.
 */

/**
 * Package specification for dependency resolution.
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
 * Package registry interface for dependency lookup.
 */
export interface PackageRegistry {
  /** Get package spec by name */
  get(name: string): PackageSpec | undefined;
  /** Check if a package is registered */
  has(name: string): boolean;
  /** Get all registered package names */
  keys(): string[];
}

/**
 * Resolved dependency information.
 */
export interface ResolvedDependency {
  /** Original package name */
  name: string;
  /** Type of resolution */
  type: "git" | "npm" | "local";
  /** Filesystem path for git/local deps (after clone/build) */
  path?: string;
  /** True if package should be marked external (npm deps) */
  external?: boolean;
}

/**
 * Options for dependency resolution.
 */
export interface DependencyResolverOptions {
  /** Package registry for looking up dependencies */
  registry?: PackageRegistry;
  /** Explicit dependency mappings (alternative to registry) */
  dependencies?: Record<string, string>;
  /** Base path for cloned packages (default: /packages) */
  packagesBasePath?: string;
}

/**
 * Parse a bare specifier to extract package name and subpath.
 *
 * Examples:
 *   "@natstack/build" -> { name: "@natstack/build", subpath: undefined }
 *   "@natstack/build/transform" -> { name: "@natstack/build", subpath: "transform" }
 *   "lodash" -> { name: "lodash", subpath: undefined }
 *   "lodash/debounce" -> { name: "lodash", subpath: "debounce" }
 */
export function parsePackageSpecifier(specifier: string): {
  name: string;
  subpath: string | undefined;
} {
  // Handle scoped packages (@org/pkg)
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      const name = `${parts[0]}/${parts[1]}`;
      const subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
      return { name, subpath };
    }
  }

  // Handle non-scoped packages
  const slashIndex = specifier.indexOf("/");
  if (slashIndex === -1) {
    return { name: specifier, subpath: undefined };
  }

  const name = specifier.slice(0, slashIndex);
  const subpath = specifier.slice(slashIndex + 1);
  return { name, subpath };
}

/**
 * Check if a spec string is a git dependency.
 */
function isGitSpec(spec: string): boolean {
  // Git shorthand patterns: owner/repo#ref or owner/repo@ref
  return /^[^/@]+\/[^/@]+[#@]/.test(spec) || /^[^/@]+\/[^/@]+$/.test(spec);
}

/**
 * Resolve a package dependency.
 *
 * Resolution order:
 * 1. Check explicit dependencies map (if provided)
 * 2. Check registry (project deps -> workspace packages)
 * 3. Default to external (npm)
 */
export async function resolveDependency(
  specifier: string,
  options: DependencyResolverOptions = {}
): Promise<ResolvedDependency> {
  const { registry, dependencies, packagesBasePath = "/packages" } = options;
  const { name, subpath } = parsePackageSpecifier(specifier);

  // Check explicit dependencies first
  if (dependencies && name in dependencies) {
    const spec = dependencies[name];
    if (spec) {
      return resolveSingleSpec(name, spec, subpath, packagesBasePath);
    }
  }

  // Check registry
  if (registry) {
    const packageSpec = registry.get(name);
    if (packageSpec) {
      return resolvePackageSpec(name, packageSpec, subpath, packagesBasePath);
    }
  }

  // Unknown package - mark external (let browser/CDN handle)
  return { name, type: "npm", external: true };
}

/**
 * Resolve a single dependency spec string.
 */
function resolveSingleSpec(
  name: string,
  spec: string,
  subpath: string | undefined,
  packagesBasePath: string
): ResolvedDependency {
  // Check if it's a git spec
  if (isGitSpec(spec)) {
    const basePath = `${packagesBasePath}/${name}`;
    const fullPath = subpath ? `${basePath}/${subpath}` : basePath;
    return { name, type: "git", path: fullPath };
  }

  // npm spec - mark external
  return { name, type: "npm", external: true };
}

/**
 * Resolve a PackageSpec to a ResolvedDependency.
 */
function resolvePackageSpec(
  name: string,
  spec: PackageSpec,
  subpath: string | undefined,
  packagesBasePath: string
): ResolvedDependency {
  // If already resolved to a path, use it
  if (spec.resolvedPath) {
    const fullPath = subpath ? `${spec.resolvedPath}/${subpath}` : spec.resolvedPath;
    return { name, type: "local", path: fullPath };
  }

  // Git dependency
  if (spec.gitSpec) {
    const basePath = `${packagesBasePath}/${name}`;
    const fullPath = subpath ? `${basePath}/${subpath}` : basePath;
    return { name, type: "git", path: fullPath };
  }

  // npm dependency - mark external
  return { name, type: "npm", external: true };
}

/**
 * Batch resolve multiple dependencies.
 */
export async function resolveDependencies(
  specifiers: string[],
  options: DependencyResolverOptions = {}
): Promise<Map<string, ResolvedDependency>> {
  const results = new Map<string, ResolvedDependency>();

  for (const specifier of specifiers) {
    const resolved = await resolveDependency(specifier, options);
    results.set(specifier, resolved);
  }

  return results;
}

/**
 * Get all packages that need to be cloned (git dependencies).
 */
export function getGitDependencies(
  options: DependencyResolverOptions
): Array<{ name: string; spec: string }> {
  const { registry, dependencies } = options;
  const gitDeps: Array<{ name: string; spec: string }> = [];

  // Check explicit dependencies
  if (dependencies) {
    for (const [name, spec] of Object.entries(dependencies)) {
      if (isGitSpec(spec)) {
        gitDeps.push({ name, spec });
      }
    }
  }

  // Check registry
  if (registry) {
    for (const name of registry.keys()) {
      const spec = registry.get(name);
      if (spec?.gitSpec) {
        // Skip if already in explicit dependencies
        if (!dependencies || !(name in dependencies)) {
          gitDeps.push({ name, spec: spec.gitSpec });
        }
      }
    }
  }

  return gitDeps;
}
