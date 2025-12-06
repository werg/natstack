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
export declare function parseSpec(spec: string): PackageSpec;
/**
 * Check if a spec is a git dependency.
 */
export declare function isGitSpec(spec: string): boolean;
/**
 * Check if a spec is an npm dependency.
 */
export declare function isNpmSpec(spec: string): boolean;
/**
 * Get the singleton package registry instance.
 */
export declare function getPackageRegistry(): PackageRegistry & {
    setResolvedPath(name: string, path: string): void;
    getResolvedPath(name: string): string | undefined;
    clearResolvedPaths(): void;
    setWorkspacePackages(packages: Record<string, string>): void;
};
/**
 * Reset the package registry (primarily for testing).
 */
export declare function resetPackageRegistry(): void;
//# sourceMappingURL=packages.d.ts.map