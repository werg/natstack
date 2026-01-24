/**
 * Template Builder Worker
 *
 * Clones template dependencies to OPFS storage for the current partition.
 * This worker is created by the main process to build template partitions
 * that can then be copied to context-specific partitions.
 *
 * Config is passed via the NATSTACK_TEMPLATE_CONFIG environment variable
 * as a JSON string containing:
 * - structure: Map of target paths to repo specs
 * - specHash: The template specification hash
 * - gitConfig: Git server URL and token for cloning
 */

import { rpc, fs } from "@natstack/runtime";
import { GitClient } from "@natstack/git";

/**
 * Template configuration passed from main process.
 */
interface TemplateConfig {
  structure: Record<string, { repo: string; resolvedCommit: string }>;
  specHash: string;
  gitConfig: {
    serverUrl: string;
    token: string;
  };
}

/**
 * Parse template config from environment variable.
 */
function parseTemplateConfig(): TemplateConfig | null {
  // Config is passed via process.env (exposed by preload from --natstack-panel-env)
  const configStr = process.env["NATSTACK_TEMPLATE_CONFIG"];
  if (!configStr) {
    return null;
  }

  try {
    return JSON.parse(configStr) as TemplateConfig;
  } catch (error) {
    console.error("[TemplateBuilder] Failed to parse config:", error);
    return null;
  }
}

/**
 * Clone a repository at a specific commit to OPFS.
 */
async function cloneRepo(
  git: GitClient,
  repo: string,
  commit: string,
  targetPath: string
): Promise<void> {
  console.log(`[TemplateBuilder] Cloning ${repo}@${commit.slice(0, 8)} to ${targetPath}`);

  // Check if already exists and matches
  try {
    const exists = await git.isRepo(targetPath);
    if (exists) {
      const currentCommit = await git.getCurrentCommit(targetPath);
      if (currentCommit === commit) {
        console.log(`[TemplateBuilder] ${targetPath} already at correct commit`);
        return;
      }
      // Wrong commit - need to re-clone (delete and clone fresh)
      console.log(`[TemplateBuilder] ${targetPath} at wrong commit, re-cloning`);
      await fs.rm(targetPath, { recursive: true });
    }
  } catch {
    // Path doesn't exist or error checking - proceed with clone
  }

  // Clone the repository at the specific commit
  await git.clone({
    url: repo,
    dir: targetPath,
    ref: commit,
  });

  console.log(`[TemplateBuilder] Cloned ${repo} to ${targetPath}`);
}

/**
 * Signal completion to the main process.
 */
async function signalComplete(result: { success: boolean; specHash?: string; error?: string }): Promise<void> {
  try {
    await rpc.call("main", "bridge.signalTemplateComplete", result);
  } catch (error) {
    console.error("[TemplateBuilder] Failed to signal completion:", error);
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log("[TemplateBuilder] Worker starting...");

  // Parse config from command line
  const config = parseTemplateConfig();
  if (!config) {
    const error = "No template config found in arguments";
    console.error(`[TemplateBuilder] ${error}`);
    await signalComplete({ success: false, error });
    return;
  }

  console.log(`[TemplateBuilder] Building template ${config.specHash.slice(0, 12)}`);
  console.log(`[TemplateBuilder] Structure:`, Object.keys(config.structure));

  try {
    // Create git client (fs proxy waits for OPFS to be ready internally)
    const git = new GitClient(fs, {
      serverUrl: config.gitConfig.serverUrl,
      token: config.gitConfig.token,
      author: {
        name: "NatStack Template Builder",
        email: "template@natstack.local",
      },
    });

    // Clone all repositories
    const entries = Object.entries(config.structure);
    let completed = 0;

    for (const [targetPath, spec] of entries) {
      await cloneRepo(git, spec.repo, spec.resolvedCommit, targetPath);
      completed++;
      console.log(`[TemplateBuilder] Progress: ${completed}/${entries.length}`);
    }

    // Write marker file to OPFS
    await fs.writeFile(
      "/.template-ready",
      JSON.stringify({
        specHash: config.specHash,
        builtAt: Date.now(),
        entries: entries.length,
      })
    );

    console.log("[TemplateBuilder] Build complete");
    await signalComplete({ success: true, specHash: config.specHash });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[TemplateBuilder] Build failed:", errorMsg);
    await signalComplete({ success: false, error: errorMsg });
  }
}

// Run main
void main();
