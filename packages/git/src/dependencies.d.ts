import type { FsClient } from "isomorphic-git";
import type { GitDependency, ResolvedDependency, GitClientOptions } from "./types.js";
/**
 * Dependency resolver for git-based panel dependencies
 */
export declare class DependencyResolver {
    private git;
    private fs;
    private depsBasePath;
    constructor(fs: FsClient, options: GitClientOptions, depsBasePath?: string);
    /**
     * Resolve dependency specifications into fully qualified dependencies
     */
    resolveDependencies(deps: Record<string, GitDependency | string>): ResolvedDependency[];
    /**
     * Parse shorthand dependency format
     * Examples:
     *   "panels/shared" -> { repo: "panels/shared" }
     *   "panels/shared#develop" -> { repo: "panels/shared", branch: "develop" }
     *   "panels/shared@v1.0.0" -> { repo: "panels/shared", tag: "v1.0.0" }
     *   "panels/shared@abc123" -> { repo: "panels/shared", commit: "abc123" }
     */
    private parseShorthand;
    /**
     * Clone or update a single dependency
     */
    syncDependency(dep: ResolvedDependency): Promise<{
        action: "cloned" | "updated" | "unchanged";
        commit: string | null;
    }>;
    /**
     * Sync all dependencies with cycle detection
     */
    syncAll(deps: Record<string, GitDependency | string>, onProgress?: (name: string, action: string) => void, visited?: Set<string>, depth?: number): Promise<Map<string, {
        action: string;
        commit: string | null;
    }>>;
    /**
     * Get path to a dependency's local directory
     */
    getDepPath(name: string): string;
    /**
     * Check if a dependency is already cloned
     */
    isCloned(name: string): Promise<boolean>;
    private pathExists;
}
//# sourceMappingURL=dependencies.d.ts.map