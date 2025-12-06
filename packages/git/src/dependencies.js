import { GitClient } from "./client.js";
/**
 * Dependency resolver for git-based panel dependencies
 */
export class DependencyResolver {
    constructor(fs, options, depsBasePath = "/deps") {
        this.fs = fs;
        this.git = new GitClient(fs, options);
        this.depsBasePath = depsBasePath;
    }
    /**
     * Resolve dependency specifications into fully qualified dependencies
     */
    resolveDependencies(deps) {
        return Object.entries(deps).map(([name, dep]) => {
            // Allow shorthand string format: "repo-url" or "repo-url#branch"
            const normalized = typeof dep === "string" ? this.parseShorthand(dep) : dep;
            // Determine the ref to use (priority: commit > tag > branch > 'main')
            const ref = normalized.commit ?? normalized.tag ?? normalized.branch ?? "main";
            return {
                name,
                repo: normalized.repo,
                branch: normalized.branch,
                commit: normalized.commit,
                tag: normalized.tag,
                resolvedUrl: this.git.resolveUrl(normalized.repo),
                localPath: `${this.depsBasePath}/${name}`,
                ref,
            };
        });
    }
    /**
     * Parse shorthand dependency format
     * Examples:
     *   "panels/shared" -> { repo: "panels/shared" }
     *   "panels/shared#develop" -> { repo: "panels/shared", branch: "develop" }
     *   "panels/shared@v1.0.0" -> { repo: "panels/shared", tag: "v1.0.0" }
     *   "panels/shared@abc123" -> { repo: "panels/shared", commit: "abc123" }
     */
    parseShorthand(shorthand) {
        // Check for branch reference
        const branchMatch = shorthand.match(/^(.+)#(.+)$/);
        if (branchMatch && branchMatch[1] && branchMatch[2]) {
            return { repo: branchMatch[1], branch: branchMatch[2] };
        }
        // Check for tag/commit reference
        const refMatch = shorthand.match(/^(.+)@(.+)$/);
        if (refMatch && refMatch[1] && refMatch[2]) {
            const repoName = refMatch[1];
            const ref = refMatch[2];
            // If it looks like a semver tag, treat as tag
            if (/^v?\d/.test(ref)) {
                return { repo: repoName, tag: ref };
            }
            // If it looks like a commit hash (7+ hex chars)
            if (/^[0-9a-f]{7,}$/i.test(ref)) {
                return { repo: repoName, commit: ref };
            }
            // Default to tag
            return { repo: repoName, tag: ref };
        }
        return { repo: shorthand };
    }
    /**
     * Clone or update a single dependency
     */
    async syncDependency(dep) {
        const exists = await this.pathExists(dep.localPath);
        if (!exists) {
            // Clone the repository
            await this.git.clone({
                url: dep.resolvedUrl,
                dir: dep.localPath,
                ref: dep.ref,
                depth: dep.commit ? undefined : 1, // Full history if pinned to commit
            });
            const commit = await this.git.getCurrentCommit(dep.localPath);
            return { action: "cloned", commit };
        }
        // Repository exists - check if update needed
        const currentCommit = await this.git.getCurrentCommit(dep.localPath);
        // If pinned to a specific commit, just ensure we're on it
        if (dep.commit) {
            if (currentCommit === dep.commit) {
                return { action: "unchanged", commit: currentCommit };
            }
            await this.git.fetch({ dir: dep.localPath });
            await this.git.checkout(dep.localPath, dep.commit);
            return { action: "updated", commit: dep.commit };
        }
        // For branches/tags, always fetch and pull latest
        await this.git.fetch({ dir: dep.localPath, ref: dep.ref });
        await this.git.checkout(dep.localPath, dep.ref);
        await this.git.pull({ dir: dep.localPath, ref: dep.ref });
        const newCommit = await this.git.getCurrentCommit(dep.localPath);
        const action = newCommit !== currentCommit ? "updated" : "unchanged";
        return { action, commit: newCommit };
    }
    /**
     * Sync all dependencies with cycle detection
     */
    async syncAll(deps, onProgress, visited = new Set(), depth = 0) {
        const MAX_DEPTH = 10; // Maximum dependency depth
        // Check depth limit
        if (depth > MAX_DEPTH) {
            throw new Error(`Dependency depth exceeds maximum (${MAX_DEPTH}). ` +
                `This likely indicates a circular dependency.`);
        }
        const resolved = this.resolveDependencies(deps);
        const results = new Map();
        for (const dep of resolved) {
            // Cycle detection: check if we're already processing this dependency
            if (visited.has(dep.name)) {
                const cycle = Array.from(visited).join(" -> ") + " -> " + dep.name;
                throw new Error(`Circular dependency detected: ${cycle}`);
            }
            // Mark as visiting
            visited.add(dep.name);
            onProgress?.(dep.name, "syncing");
            try {
                const result = await this.syncDependency(dep);
                results.set(dep.name, result);
                onProgress?.(dep.name, result.action);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                results.set(dep.name, { action: `error: ${message}`, commit: null });
                onProgress?.(dep.name, `error: ${message}`);
            }
            // Unmark after processing (allows same dep in different branches)
            visited.delete(dep.name);
        }
        return results;
    }
    /**
     * Get path to a dependency's local directory
     */
    getDepPath(name) {
        return `${this.depsBasePath}/${name}`;
    }
    /**
     * Check if a dependency is already cloned
     */
    async isCloned(name) {
        const depPath = this.getDepPath(name);
        return this.git.isRepo(depPath);
    }
    async pathExists(path) {
        try {
            // Use the callback-style stat that isomorphic-git expects
            const fsAny = this.fs;
            if (fsAny.promises?.stat) {
                await fsAny.promises.stat(path);
                return true;
            }
            // Fallback: try to list the directory via isRepo check
            return await this.git.isRepo(path);
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=dependencies.js.map