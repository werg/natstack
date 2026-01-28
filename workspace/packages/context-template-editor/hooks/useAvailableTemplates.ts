/**
 * Hook for fetching available context templates from contexts/ directory.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { rpc } from "@natstack/runtime";
import type { AvailableTemplate, WorkspaceTree, WorkspaceNode, ResolvedTemplate, MountPoint, TemplateInfo } from "../types";
import { generateMountId, parseGitSpec } from "../types";

export interface UseAvailableTemplatesResult {
  /** Available templates */
  templates: AvailableTemplate[];
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Reload templates */
  reload: () => Promise<void>;
  /** Load a specific template's info (including structure) */
  loadTemplate: (spec: string) => Promise<TemplateInfo | null>;
}

/** Directories that can contain context templates */
const TEMPLATE_DIRECTORIES = ["contexts", "panels", "workers", "projects"];

/**
 * Find context templates in the workspace tree.
 * Templates can be in contexts/, panels/, workers/, or projects/ directories.
 */
function findTemplates(nodes: WorkspaceNode[], parentPath = ""): AvailableTemplate[] {
  const templates: AvailableTemplate[] = [];

  for (const node of nodes) {
    const nodePath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const topDir = nodePath.split("/")[0];

    // Check if this is in a template directory and is a git repo
    if (TEMPLATE_DIRECTORIES.includes(topDir) && node.isGitRepo) {
      templates.push({
        spec: nodePath,
        name: node.name,
        // Description would come from loading the template
      });
    }

    // Recurse into children
    if (node.children.length > 0) {
      templates.push(...findTemplates(node.children, nodePath));
    }
  }

  return templates;
}

export function useAvailableTemplates(): UseAvailableTemplatesResult {
  const [templates, setTemplates] = useState<AvailableTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Get workspace tree and find potential templates
      const tree = await rpc.call<WorkspaceTree>("main", "bridge.getWorkspaceTree");
      const potentialTemplates = findTemplates(tree.children);

      // Filter to only repos that actually have context-template.yml
      const templatesWithFiles = await Promise.all(
        potentialTemplates.map(async (template) => {
          try {
            const hasTemplate = await rpc.call<boolean>(
              "main",
              "bridge.hasContextTemplate",
              template.spec
            );
            return hasTemplate ? template : null;
          } catch {
            return null;
          }
        })
      );

      setTemplates(templatesWithFiles.filter((t): t is AvailableTemplate => t !== null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadTemplate = useCallback(async (spec: string): Promise<TemplateInfo | null> => {
    try {
      // Load context template info via bridge (returns TemplateInfo with structure)
      const info = await rpc.call<TemplateInfo | null>(
        "main",
        "bridge.loadContextTemplate",
        spec
      );
      return info;
    } catch (err) {
      console.error(`Failed to load template ${spec}:`, err);
      return null;
    }
  }, []);

  return {
    templates,
    loading,
    error,
    reload: load,
    loadTemplate,
  };
}

/**
 * Convert resolved template structure to mount points.
 */
export function structureToMountPoints(
  structure: Record<string, string>,
  isInherited: boolean
): MountPoint[] {
  return Object.entries(structure).map(([path, spec]) => {
    const { repoSpec, ref } = parseGitSpec(spec);
    return {
      id: generateMountId(),
      path,
      repoSpec,
      ref,
      isInherited,
    };
  });
}
