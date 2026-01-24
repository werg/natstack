/**
 * Template Inheritance Resolution
 *
 * Recursively resolves template inheritance chains, resolving all git refs
 * to exact commit SHAs. Detects circular extends and validates the result.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type {
  GitSpec,
  ContextTemplateYaml,
  ResolvedTemplate,
  ResolvedGitSpec,
  ResolveOptions,
  TemplateProgress,
} from "./types.js";
import { CircularExtendsError } from "./types.js";
import { parseGitSpec, loadTemplateFromDir, parseTemplateYaml, TEMPLATE_FILE_NAME } from "./parser.js";
import { getActiveWorkspace } from "../paths.js";

const execFileAsync = promisify(execFile);

/**
 * Context passed through recursive resolution
 */
interface ResolutionContext {
  /** Workspace root path */
  workspacePath: string;
  /** Set of visited specs to detect circular extends */
  visited: Set<string>;
  /** Inheritance chain for error messages */
  inheritanceChain: string[];
  /** Progress callback */
  onProgress?: (progress: TemplateProgress) => void;
}

/**
 * Resolve a template and all its parents recursively.
 *
 * @param templateSpec - Git spec for the template (e.g., "templates/base#main")
 * @param options - Resolution options
 * @returns Fully resolved template with all refs as commit SHAs
 * @throws CircularExtendsError if circular inheritance is detected
 */
export async function resolveTemplate(
  templateSpec: GitSpec,
  options?: ResolveOptions
): Promise<ResolvedTemplate> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    throw new Error("No active workspace - cannot resolve template");
  }

  const context: ResolutionContext = {
    workspacePath: workspace.path,
    visited: new Set(),
    inheritanceChain: [],
    onProgress: options?.onProgress,
  };

  return resolveTemplateInternal(templateSpec, context);
}

/**
 * Internal recursive resolution function.
 */
async function resolveTemplateInternal(
  templateSpec: GitSpec,
  ctx: ResolutionContext
): Promise<ResolvedTemplate> {
  const { repo, ref } = parseGitSpec(templateSpec);

  // Handle special case: "." means current workspace root
  const repoPath = repo === "." ? ctx.workspacePath : path.resolve(ctx.workspacePath, repo);

  // Check if repo directory exists
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Template repository not found: ${repoPath}`);
  }

  // Resolve ref to exact commit SHA
  ctx.onProgress?.({
    stage: "resolving",
    message: `Resolving ${templateSpec}...`,
  });

  const resolvedCommit = await resolveRefToCommit(repoPath, ref);

  // Build a unique key for cycle detection
  const specKey = `${repo}@${resolvedCommit}`;

  // Detect circular extends
  if (ctx.visited.has(specKey)) {
    throw new CircularExtendsError([...ctx.inheritanceChain, specKey]);
  }

  ctx.visited.add(specKey);
  ctx.inheritanceChain.push(specKey);

  // Load the template YAML from the resolved commit
  // For simplicity, we currently read from the working directory
  // A more complete implementation would check out the specific commit
  const templateYaml = await loadTemplateAtCommit(repoPath, resolvedCommit);

  // Recursively resolve parent template if extends is specified
  let resolvedExtends: ResolvedTemplate["extends"] | undefined;

  if (templateYaml.extends) {
    const parentResolved = await resolveTemplateInternal(templateYaml.extends, ctx);
    const { ref: parentRef } = parseGitSpec(templateYaml.extends);
    const parentCommit = await resolveRefToCommit(
      path.resolve(ctx.workspacePath, parseGitSpec(templateYaml.extends).repo),
      parentRef
    );

    resolvedExtends = {
      spec: templateYaml.extends,
      resolvedCommit: parentCommit,
      resolvedTemplate: parentResolved,
    };
  }

  // Resolve all structure specs to commits
  const resolvedStructure: Record<string, ResolvedGitSpec> = {};

  if (templateYaml.structure) {
    for (const [targetPath, gitSpec] of Object.entries(templateYaml.structure)) {
      const parsed = parseGitSpec(gitSpec);
      const structureRepoPath = path.resolve(ctx.workspacePath, parsed.repo);

      if (!fs.existsSync(structureRepoPath)) {
        throw new Error(
          `Structure dependency not found: ${structureRepoPath} (from ${templateSpec})`
        );
      }

      const structureCommit = await resolveRefToCommit(structureRepoPath, parsed.ref);

      resolvedStructure[targetPath] = {
        originalSpec: gitSpec,
        repo: parsed.repo,
        ref: parsed.ref,
        resolvedCommit: structureCommit,
      };
    }
  }

  // Pop from inheritance chain (for backtracking in case of multiple extends at same level)
  ctx.inheritanceChain.pop();

  return {
    name: templateYaml.name,
    description: templateYaml.description,
    extends: resolvedExtends,
    structure: resolvedStructure,
    sourceSpec: templateSpec,
    sourceCommit: resolvedCommit,
  };
}

/**
 * Resolve a git ref to a commit SHA.
 *
 * @param repoPath - Path to the git repository
 * @param ref - Git ref (branch, tag, or commit) - if undefined, uses HEAD
 * @returns Full commit SHA
 */
async function resolveRefToCommit(
  repoPath: string,
  ref?: string
): Promise<string> {
  const targetRef = ref ?? "HEAD";

  try {
    return await runGit(["rev-parse", targetRef], repoPath);
  } catch (error) {
    // Try fallback refs
    const candidates: string[] = [];

    if (targetRef === "main") candidates.push("master");
    if (targetRef === "master") candidates.push("main");

    // Try origin/<branch> for plain branch names
    if (!targetRef.includes("/") && !targetRef.startsWith("refs/")) {
      candidates.push(`origin/${targetRef}`);
    }

    for (const candidate of candidates) {
      try {
        return await runGit(["rev-parse", candidate], repoPath);
      } catch {
        // continue
      }
    }

    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve ref "${targetRef}" in ${repoPath}: ${msg}`);
  }
}

/**
 * Get the relative path from the git repo root to a subdirectory.
 *
 * @param dirPath - Absolute path to a directory within a git repo
 * @returns Relative path from repo root, or empty string if at root
 */
async function getRelativePathFromRepoRoot(dirPath: string): Promise<string> {
  // Get the repo root
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], dirPath);
  // Calculate relative path
  const relativePath = path.relative(repoRoot, dirPath);
  return relativePath;
}

/**
 * Load a template YAML at a specific commit.
 *
 * Uses `git show <commit>:<path>` to read the file content directly
 * from git, ensuring immutability - the template content is fixed to
 * the exact commit, not affected by working directory changes.
 *
 * Handles subdirectories correctly by calculating the path relative
 * to the git repo root.
 *
 * @param repoPath - Path to the template directory (may be subdirectory of a git repo)
 * @param commit - Exact commit SHA to read from
 * @returns Parsed template YAML
 * @throws Error if template file doesn't exist at the commit
 */
async function loadTemplateAtCommit(
  repoPath: string,
  commit: string
): Promise<ContextTemplateYaml> {
  try {
    // Get path relative to git repo root
    const relativePath = await getRelativePathFromRepoRoot(repoPath);
    // Build the full path to the template file from repo root
    const templatePath = relativePath
      ? `${relativePath}/${TEMPLATE_FILE_NAME}`
      : TEMPLATE_FILE_NAME;

    // Use git show to read the file at the exact commit
    const content = await runGit(["show", `${commit}:${templatePath}`], repoPath);
    return parseTemplateYaml(content);
  } catch (error) {
    // No silent fallbacks - if template file doesn't exist, fail loudly
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Template file "${TEMPLATE_FILE_NAME}" not found at commit ${commit.slice(0, 8)} in ${repoPath}: ${msg}`
    );
  }
}

/**
 * Run a git command and return trimmed stdout.
 */
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Resolve a template spec to just its commit hash without full resolution.
 * Useful for quick validation.
 *
 * @param templateSpec - Git spec for the template
 * @returns Resolved commit SHA
 */
export async function resolveTemplateCommit(templateSpec: GitSpec): Promise<string> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    throw new Error("No active workspace - cannot resolve template");
  }

  const { repo, ref } = parseGitSpec(templateSpec);
  const repoPath = repo === "." ? workspace.path : path.resolve(workspace.path, repo);

  if (!fs.existsSync(repoPath)) {
    throw new Error(`Template repository not found: ${repoPath}`);
  }

  return resolveRefToCommit(repoPath, ref);
}

/**
 * Check if a template spec points to a valid repository with a template file.
 *
 * @param templateSpec - Git spec for the template
 * @returns true if the template exists and is valid
 */
export async function templateExists(templateSpec: GitSpec): Promise<boolean> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    return false;
  }

  const { repo } = parseGitSpec(templateSpec);
  const repoPath = repo === "." ? workspace.path : path.resolve(workspace.path, repo);

  if (!fs.existsSync(repoPath)) {
    return false;
  }

  const templatePath = path.join(repoPath, TEMPLATE_FILE_NAME);
  return fs.existsSync(templatePath);
}
