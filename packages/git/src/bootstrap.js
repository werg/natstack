import { GitClient } from "./client.js";
import { DependencyResolver } from "./dependencies.js";
/**
 * Bootstrap a panel by cloning/pulling its source and dependencies into OPFS.
 *
 * Usage:
 * ```typescript
 * import { bootstrap } from "@natstack/git";
 * import { fs } from "@zenfs/core";
 *
 * const config = await window.__natstackPanelBridge.git.getConfig();
 * const result = await bootstrap(fs, config);
 *
 * if (result.success) {
 *   // Panel source is now at result.sourcePath
 *   // Dependencies are at result.depPaths
 * }
 * ```
 */
export async function bootstrap(fs, config) {
    const sourcePath = config.sourcePath ?? "/src";
    const depsPath = config.depsPath ?? "/deps";
    const result = {
        success: false,
        sourcePath,
        depPaths: {},
        depCommits: {},
        actions: {
            source: "error",
            deps: {},
        },
    };
    const gitOptions = {
        serverUrl: config.serverUrl,
        token: config.token,
        author: config.author ?? {
            name: "NatStack Panel",
            email: "panel@natstack.local",
        },
    };
    const git = new GitClient(fs, gitOptions);
    try {
        // Step 1: Clone or pull panel source
        const sourceExists = await git.isRepo(sourcePath);
        if (!sourceExists) {
            // Clone the source repo
            await git.clone({
                url: config.sourceRepo,
                dir: sourcePath,
                ref: "main",
                depth: 1,
            });
            result.actions.source = "cloned";
        }
        else {
            // Pull latest changes
            try {
                await git.pull({
                    dir: sourcePath,
                    ref: "main",
                });
                result.actions.source = "pulled";
            }
            catch (pullError) {
                // Pull might fail if there are no changes or conflicts
                // Check if we're already up to date
                const status = await git.status(sourcePath);
                if (!status.dirty) {
                    result.actions.source = "unchanged";
                }
                else {
                    throw pullError;
                }
            }
        }
        // Get current commit SHA for cache key generation
        const sourceCommit = await git.getCurrentCommit(sourcePath);
        if (sourceCommit) {
            result.sourceCommit = sourceCommit;
        }
        // Step 2: Clone or update dependencies
        if (config.gitDependencies && Object.keys(config.gitDependencies).length > 0) {
            const resolver = new DependencyResolver(fs, gitOptions, depsPath);
            const depResults = await resolver.syncAll(config.gitDependencies);
            for (const [name, depResult] of depResults) {
                result.depPaths[name] = `${depsPath}/${name}`;
                if (depResult.action.startsWith("error")) {
                    result.actions.deps[name] = "error";
                }
                else {
                    result.actions.deps[name] = depResult.action;
                    // Track commit SHA for cache key generation
                    if (depResult.commit) {
                        result.depCommits[name] = depResult.commit;
                    }
                }
            }
        }
        result.success = true;
    }
    catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
}
/**
 * Check if panel source exists in OPFS
 */
export async function hasSource(fs, sourcePath = "/src") {
    try {
        const fsAny = fs;
        if (fsAny.promises?.stat) {
            await fsAny.promises.stat(sourcePath);
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=bootstrap.js.map