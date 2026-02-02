/**
 * Workspace discovery and management tools for pubsub RPC.
 *
 * Implements: workspace_list, workspace_clone, context_info, context_template_list, context_template_read
 * Enables agents to discover, clone, and manage repos in their context.
 */

import * as fs from "fs";
import * as path from "path";
import * as git from "isomorphic-git";
import { GitClient } from "@natstack/git";
import type { MethodDefinition } from "@natstack/agentic-messaging";
import {
  WorkspaceListArgsSchema,
  WorkspaceCloneArgsSchema,
  ContextInfoArgsSchema,
  ContextTemplateListArgsSchema,
  ContextTemplateReadArgsSchema,
  type WorkspaceListArgs,
  type WorkspaceCloneArgs,
  type ContextInfoArgs,
  type ContextTemplateListArgs,
  type ContextTemplateReadArgs,
} from "@natstack/agentic-messaging";
import {
  getWorkspaceTree,
  gitConfig,
  rpc,
  type WorkspaceNode,
} from "@natstack/runtime";

/** Standard workspace mount path prefix */
const WORKSPACE_PREFIX = "/workspace";

/** Directories that may contain context templates */
const TEMPLATE_DIRECTORIES = ["contexts", "panels", "workers", "projects"];

/**
 * Check if a node matches the requested category filter.
 * - "skills" only matches repos with skillInfo (have SKILL.md)
 * - "packages" matches repos in packages/ without skillInfo
 * - other categories match by top-level directory
 */
function matchesCategory(node: WorkspaceNode, category: string): boolean {
  if (category === "all") return true;

  const topDir = node.path.split("/")[0];

  if (category === "skills") {
    // Only repos with SKILL.md are skills
    return !!node.skillInfo;
  }

  if (category === "packages") {
    // Packages are in packages/ and are NOT skills
    return topDir === "packages" && !node.skillInfo;
  }

  // For panels, workers, contexts - match by directory
  return topDir === category;
}

/**
 * Format workspace tree as readable text
 */
function formatWorkspaceTree(
  nodes: WorkspaceNode[],
  indent: string = "",
  category?: string
): string {
  const lines: string[] = [];

  for (const node of nodes) {
    if (node.isGitRepo) {
      // Filter by category if specified
      if (category && !matchesCategory(node, category)) continue;

      // Build info string with skill, launchable, or package info
      let info = "";
      if (node.skillInfo) {
        info = ` [skill] ${node.skillInfo.description}`;
      } else if (node.launchable) {
        info = ` [${node.launchable.type}: ${node.launchable.title}]`;
      } else if (node.packageInfo) {
        info = ` [package: ${node.packageInfo.name}]`;
      }
      lines.push(`${indent}${node.path}${info}`);
    } else if (node.children && node.children.length > 0) {
      // For directories, check if any children match the filter
      const childContent = formatWorkspaceTree(node.children, indent + "  ", category);
      if (childContent) {
        lines.push(`${indent}${node.name}/`);
        lines.push(childContent);
      }
    }
  }

  return lines.filter(Boolean).join("\n");
}

function collectTemplateCandidates(nodes: WorkspaceNode[]): string[] {
  const results: string[] = [];
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    const topDir = node.path.split("/")[0];
    if (node.isGitRepo && TEMPLATE_DIRECTORIES.includes(topDir)) {
      results.push(node.path);
    }

    if (node.children.length > 0) {
      stack.push(...node.children);
    }
  }

  return results;
}

/**
 * workspace_list - List available repos in the workspace
 */
export async function workspaceList(args: WorkspaceListArgs): Promise<string> {
  const category = args.category ?? "all";

  try {
    const tree = await getWorkspaceTree();

    if (!tree.children || tree.children.length === 0) {
      return "No repositories found in workspace.";
    }

    const formatted = formatWorkspaceTree(tree.children, "", category);

    if (!formatted) {
      return `No repositories found in category: ${category}`;
    }

    return `Workspace repositories${category !== "all" ? ` (${category})` : ""}:\n\n${formatted}`;
  } catch (error) {
    return `Error listing workspace: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * context_template_list - List available context templates in the workspace
 */
export async function contextTemplateList(_args: ContextTemplateListArgs): Promise<string> {
  try {
    const tree = await getWorkspaceTree();

    if (!tree.children || tree.children.length === 0) {
      return "No repositories found in workspace.";
    }

    const candidates = collectTemplateCandidates(tree.children);
    if (candidates.length === 0) {
      return "No context templates found.";
    }

    const templateSpecs = await Promise.all(
      candidates.map(async (spec) => {
        try {
          const hasTemplate = await rpc.call<boolean>("main", "bridge.hasContextTemplate", spec);
          return hasTemplate ? spec : null;
        } catch {
          return null;
        }
      })
    );

    const templates = templateSpecs.filter((spec): spec is string => spec !== null).sort();
    if (templates.length === 0) {
      return "No context templates found.";
    }

    return `Context templates:\n\n${templates.map((spec) => `- ${spec}`).join("\n")}`;
  } catch (error) {
    return `Error listing context templates: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Parse a repo spec like "panels/editor#main" into path and ref
 */
function parseRepoSpec(spec: string): { repoPath: string; ref?: string } {
  const hashIndex = spec.indexOf("#");
  if (hashIndex !== -1) {
    return {
      repoPath: spec.slice(0, hashIndex),
      ref: spec.slice(hashIndex + 1),
    };
  }

  const atIndex = spec.indexOf("@");
  if (atIndex !== -1) {
    return {
      repoPath: spec.slice(0, atIndex),
      ref: spec.slice(atIndex + 1),
    };
  }

  return { repoPath: spec };
}

/**
 * workspace_clone - Clone a repo into the context's OPFS
 */
export async function workspaceClone(
  args: WorkspaceCloneArgs,
  workspaceRoot?: string
): Promise<string> {
  const { repoPath, ref } = parseRepoSpec(args.repo_spec);
  const mountPath = args.mount_path ?? `${WORKSPACE_PREFIX}/${repoPath}`;

  if (!repoPath.trim()) {
    return "Error: Invalid repo_spec. Expected a path like 'panels/editor'.";
  }

  // Check git server config
  if (!gitConfig?.serverUrl || !gitConfig?.token) {
    return "Error: Git server not configured. Cannot clone repositories.";
  }

  // Capture for use in closure (TypeScript narrowing)
  const serverUrl = gitConfig.serverUrl;
  const token = gitConfig.token;

  // Ensure mount path is absolute
  const absoluteMountPath = mountPath.startsWith("/")
    ? mountPath
    : path.join(workspaceRoot ?? "/", mountPath);

  // Check if already exists
  try {
    const stat = await fs.promises.stat(absoluteMountPath);
    if (stat.isDirectory()) {
      return `Repository already exists at ${absoluteMountPath}. Use git tools to update.`;
    }
  } catch {
    // Doesn't exist, proceed with clone
  }

  try {
    // Create parent directories
    const parentDir = path.dirname(absoluteMountPath);
    await fs.promises.mkdir(parentDir, { recursive: true });

    // Clone using GitClient
    const gitClient = new GitClient(fs.promises, { serverUrl, token });
    await gitClient.clone({
      url: `${serverUrl}/${repoPath}`,
      dir: absoluteMountPath,
      ref: ref,
      depth: 1,
    });

    // Get commit info for confirmation
    const log = await git.log({ fs, dir: absoluteMountPath, depth: 1 });
    const shortSha = log[0]?.oid.slice(0, 7) ?? "unknown";

    return `Cloned ${repoPath}${ref ? `#${ref}` : ""} to ${absoluteMountPath} (${shortSha})`;
  } catch (error) {
    return `Error cloning ${repoPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Recursively find git repos in a directory (up to maxDepth levels).
 */
async function findGitRepos(
  dir: string,
  relativePath: string,
  maxDepth: number
): Promise<Array<{ path: string; absolutePath: string }>> {
  if (maxDepth <= 0) return [];

  const repos: Array<{ path: string; absolutePath: string }> = [];

  try {
    const entries = await fs.promises.readdir(dir);

    for (const entry of entries) {
      if (entry.startsWith(".")) continue; // Skip hidden

      const entryPath = path.join(dir, entry);
      const entryRelPath = relativePath ? `${relativePath}/${entry}` : entry;

      try {
        const stat = await fs.promises.stat(entryPath);
        if (!stat.isDirectory()) continue;

        // Check if it's a git repo
        const gitDir = path.join(entryPath, ".git");
        try {
          await fs.promises.stat(gitDir);
          repos.push({ path: entryRelPath, absolutePath: entryPath });
        } catch {
          // Not a git repo, recurse
          const subRepos = await findGitRepos(entryPath, entryRelPath, maxDepth - 1);
          repos.push(...subRepos);
        }
      } catch {
        // Can't stat, skip
      }
    }
  } catch {
    // Can't read dir
  }

  return repos;
}

/**
 * Get git repo info (branch and commit)
 */
async function getRepoInfo(absolutePath: string): Promise<string> {
  try {
    const branch = await git.currentBranch({ fs, dir: absolutePath });
    const log = await git.log({ fs, dir: absolutePath, depth: 1 });
    const commit = log[0]?.oid.slice(0, 7) ?? "unknown";
    return `${branch ?? "detached"}@${commit}`;
  } catch {
    return "git repo";
  }
}

/**
 * context_info - Show what repos are mounted in the current context
 */
export async function contextInfo(
  _args: ContextInfoArgs,
  workspaceRoot?: string
): Promise<string> {
  const root = workspaceRoot ?? "/";
  const lines: string[] = ["Context filesystem:\n"];

  // Check /workspace directory (scan up to 4 levels deep)
  const workspaceDir = path.join(root, "workspace");
  const workspaceRepos = await findGitRepos(workspaceDir, "", 4);

  if (workspaceRepos.length > 0) {
    for (const repo of workspaceRepos.sort((a, b) => a.path.localeCompare(b.path))) {
      const info = await getRepoInfo(repo.absolutePath);
      lines.push(`  ${WORKSPACE_PREFIX}/${repo.path} (${info})`);
    }
  } else {
    lines.push("  No repos in /workspace/");
  }

  // Check /args directory (bootstrap repos)
  const argsDir = path.join(root, "args");
  try {
    const entries = await fs.promises.readdir(argsDir);
    if (entries.length > 0) {
      lines.push("\nBootstrap repos (/args):");
      for (const entry of entries) {
        const entryPath = path.join(argsDir, entry);
        const info = await getRepoInfo(entryPath);
        lines.push(`  /args/${entry} (${info})`);
      }
    }
  } catch {
    // No args directory
  }

  // Check /src (panel source)
  try {
    await fs.promises.stat(path.join(root, "src"));
    lines.push("\nPanel source: /src");
  } catch {
    // No src directory
  }

  return lines.length === 1 ? "Context is empty." : lines.join("\n");
}

/**
 * context_template_read - Read a context template's YAML
 */
export async function contextTemplateRead(
  args: ContextTemplateReadArgs,
  workspaceRoot?: string
): Promise<string> {
  const templateSpec = args.template_spec;

  if (!templateSpec) {
    return "No template_spec provided. Specify a template like 'contexts/default' or 'panels/chat'.";
  }

  // Template files are in the workspace, need to read via bridge or workspace tree
  // For now, we'll try to read from the local OPFS if the context includes it
  const possiblePaths = [
    `/workspace/${templateSpec}/context-template.yml`,
    `/workspace/${templateSpec}/context-template.yaml`,
  ];

  for (const templatePath of possiblePaths) {
    try {
      const content = await fs.promises.readFile(templatePath, "utf-8");
      return `Template: ${templateSpec}\n\n${content}`;
    } catch {
      // Try next path
    }
  }

  return `Template not found: ${templateSpec}\n\nNote: Clone the template's repo first with WorkspaceClone, or the template may not be in this context.`;
}

/**
 * Create workspace tool method definitions for pubsub RPC.
 */
export function createWorkspaceToolMethodDefinitions(
  workspaceRoot?: string
): Record<string, MethodDefinition> {
  return {
    workspace_list: {
      description: `List workspace repos. Filter by category: skills (repos with SKILL.md), panels, workers, contexts, packages, or all.`,
      parameters: WorkspaceListArgsSchema,
      async execute(args) {
        return workspaceList(args as WorkspaceListArgs);
      },
    },

    workspace_clone: {
      description: `Clone a repo into /workspace/<path>. Supports branch (repo#branch) or tag (repo@tag). Push-enabled.`,
      parameters: WorkspaceCloneArgsSchema,
      async execute(args) {
        return workspaceClone(args as WorkspaceCloneArgs, workspaceRoot);
      },
    },

    context_info: {
      description: `Show repos mounted in your context (/workspace/*, /args/*, /src).`,
      parameters: ContextInfoArgsSchema,
      async execute(args) {
        return contextInfo(args as ContextInfoArgs, workspaceRoot);
      },
    },

    context_template_list: {
      description: `List available context templates in the workspace.`,
      parameters: ContextTemplateListArgsSchema,
      async execute(args) {
        return contextTemplateList(args as ContextTemplateListArgs);
      },
    },

    context_template_read: {
      description: `Read a context template's YAML. Template must be cloned first.`,
      parameters: ContextTemplateReadArgsSchema,
      async execute(args) {
        return contextTemplateRead(args as ContextTemplateReadArgs, workspaceRoot);
      },
    },
  };
}
