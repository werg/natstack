/**
 * Context Template Discovery
 *
 * Scans the workspace for available context templates that users can select.
 * Also provides utilities to check for and initialize context templates.
 */

import { readdir, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { hasTemplateFile, loadTemplateFromDir } from "./parser.js";
import { getActiveWorkspace } from "../paths.js";
import type { AvailableTemplate } from "../../shared/contextTemplate.js";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("discovery");

/**
 * List all available context templates in the workspace.
 * Scans the `contexts/` directory for directories containing `context-template.yml`.
 *
 * @returns Array of available templates with spec, name, and description
 */
export async function listAvailableTemplates(): Promise<AvailableTemplate[]> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    console.warn("[discovery] No active workspace - cannot list templates");
    return [];
  }

  const contextsDir = join(workspace.path, "contexts");
  const templates: AvailableTemplate[] = [];

  try {
    const entries = await readdir(contextsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = join(contextsDir, entry.name);

      if (hasTemplateFile(dirPath)) {
        const yaml = loadTemplateFromDir(dirPath);
        templates.push({
          spec: `contexts/${entry.name}`,
          name: yaml.name ?? entry.name,
          description: yaml.description,
        });
      }
    }
  } catch (err) {
    // Return empty list if contexts/ doesn't exist or is unreadable
    console.warn("[discovery] Failed to list context templates:", err);
  }

  return templates;
}

/**
 * Check if a repo has a context-template.yml file.
 *
 * @param repoPath - Relative path to the repo (e.g., "panels/my-panel")
 * @returns true if the repo has a context template
 */
export function hasContextTemplate(repoPath: string): boolean {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    console.warn("[discovery] No active workspace - cannot check template");
    return false;
  }

  const absolutePath = join(workspace.path, repoPath);
  return hasTemplateFile(absolutePath);
}

/**
 * Template info returned by loadContextTemplate.
 */
export interface TemplateInfo {
  name?: string;
  description?: string;
  extends?: string;
  structure?: Record<string, string>;
}

/**
 * Load context template info from a repo.
 *
 * @param repoPath - Relative path to the repo (e.g., "panels/my-panel")
 * @returns Template info or null if no template exists
 */
export function loadContextTemplate(repoPath: string): TemplateInfo | null {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    console.warn("[discovery] No active workspace - cannot load template");
    return null;
  }

  const absolutePath = join(workspace.path, repoPath);

  if (!hasTemplateFile(absolutePath)) {
    return null;
  }

  try {
    const yaml = loadTemplateFromDir(absolutePath);
    return {
      name: yaml.name,
      description: yaml.description,
      extends: yaml.extends,
      structure: yaml.structure,
    };
  } catch (err) {
    console.error(`[discovery] Failed to load template from ${repoPath}:`, err);
    return null;
  }
}

/**
 * Initialize a basic context-template.yml in a repo.
 * Creates the file and commits it.
 *
 * @param repoPath - Relative path to the repo (e.g., "panels/my-panel")
 */
export async function initContextTemplate(repoPath: string): Promise<void> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    throw new Error("No active workspace");
  }

  const absolutePath = join(workspace.path, repoPath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  // Check if template already exists
  if (hasTemplateFile(absolutePath)) {
    throw new Error(`Context template already exists in ${repoPath}`);
  }

  // Create a basic context-template.yml
  const repoName = repoPath.split("/").pop() ?? "project";
  const templateContent = `# Context Template for ${repoName}
# See documentation for full configuration options

name: ${repoName}
description: Context template for ${repoName}

# Mount points define the filesystem structure
# structure:
#   /deps/some-lib: panels/some-lib
`;

  const templatePath = join(absolutePath, "context-template.yml");
  await writeFile(templatePath, templateContent, "utf-8");

  // Commit the new file
  try {
    execSync("git add context-template.yml", { cwd: absolutePath, stdio: "pipe" });
    execSync('git commit -m "Initialize context template"', { cwd: absolutePath, stdio: "pipe" });
    log.verbose(` Created context template in ${repoPath}`);
  } catch (err) {
    console.error(`[discovery] Failed to commit context template:`, err);
    throw new Error("Created template file but failed to commit");
  }
}

/**
 * Create a new git repository in the workspace.
 *
 * @param repoPath - Relative path for the new repo (e.g., "projects/my-project")
 */
export async function createRepo(repoPath: string): Promise<void> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    throw new Error("No active workspace");
  }

  const absolutePath = join(workspace.path, repoPath);

  // Check if path already exists
  if (existsSync(absolutePath)) {
    throw new Error(`Path already exists: ${repoPath}`);
  }

  // Create directory
  await mkdir(absolutePath, { recursive: true });

  // Initialize git repo
  try {
    execSync("git init", { cwd: absolutePath, stdio: "pipe" });

    // Create initial README
    const repoName = repoPath.split("/").pop() ?? "project";
    const readmePath = join(absolutePath, "README.md");
    await writeFile(readmePath, `# ${repoName}\n\nA new NatStack project.\n`, "utf-8");

    // Initial commit
    execSync("git add README.md", { cwd: absolutePath, stdio: "pipe" });
    execSync('git commit -m "Initial commit"', { cwd: absolutePath, stdio: "pipe" });

    log.verbose(` Created new repo at ${repoPath}`);
  } catch (err) {
    console.error(`[discovery] Failed to initialize repo:`, err);
    throw new Error("Failed to initialize git repository");
  }
}

/**
 * Save/update a context template in a repo.
 *
 * @param repoPath - Relative path to the repo (e.g., "panels/my-panel")
 * @param info - Updated template info
 */
export async function saveContextTemplate(repoPath: string, info: TemplateInfo): Promise<void> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    throw new Error("No active workspace");
  }

  const absolutePath = join(workspace.path, repoPath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  // Build YAML content
  const repoName = repoPath.split("/").pop() ?? "project";
  let yamlContent = `# Context Template for ${info.name ?? repoName}\n`;

  if (info.name) {
    yamlContent += `name: ${info.name}\n`;
  }

  if (info.description) {
    yamlContent += `description: ${info.description}\n`;
  }

  if (info.extends) {
    yamlContent += `extends: ${info.extends}\n`;
  }

  if (info.structure && Object.keys(info.structure).length > 0) {
    yamlContent += `\nstructure:\n`;
    for (const [path, spec] of Object.entries(info.structure)) {
      yamlContent += `  "${path}": "${spec}"\n`;
    }
  }

  const templatePath = join(absolutePath, "context-template.yml");
  await writeFile(templatePath, yamlContent, "utf-8");

  // Commit the changes
  try {
    execSync("git add context-template.yml", { cwd: absolutePath, stdio: "pipe" });
    execSync('git commit -m "Update context template"', { cwd: absolutePath, stdio: "pipe" });
    log.verbose(` Updated context template in ${repoPath}`);
  } catch (err) {
    // If nothing to commit (no changes), that's fine
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (!errorMsg.includes("nothing to commit")) {
      console.error(`[discovery] Failed to commit context template:`, err);
      throw new Error("Saved template file but failed to commit");
    }
  }
}
