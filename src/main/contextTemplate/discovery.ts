/**
 * Context Template Discovery
 *
 * Scans the workspace for available context templates that users can select.
 */

import { readdir } from "fs/promises";
import { join } from "path";
import { hasTemplateFile, loadTemplateFromDir } from "./parser.js";
import { getActiveWorkspace } from "../paths.js";
import type { AvailableTemplate } from "../../shared/contextTemplate.js";

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
