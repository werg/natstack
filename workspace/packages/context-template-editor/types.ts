/**
 * Types for the context template editor.
 */

/**
 * Raw context template YAML structure.
 */
export interface ContextTemplateYaml {
  name?: string;
  description?: string;
  extends?: string;
  structure?: Record<string, string>;
}

/**
 * A mount point in the editor.
 */
export interface MountPoint {
  /** Unique ID for React keys */
  id: string;
  /** Mount path in the context (e.g., "/workspace/panels/code-editor") */
  path: string;
  /** Git repo spec (e.g., "panels/code-editor") */
  repoSpec: string;
  /** Git ref selection */
  ref: RefSelection;
  /** Whether this mount is inherited from parent template */
  isInherited: boolean;
  /** Whether this path conflicts with an inherited path */
  hasConflict?: boolean;
}

/**
 * Git ref selection for a mount point.
 */
export interface RefSelection {
  /** Type of ref */
  type: "latest" | "branch" | "tag" | "commit";
  /** Value (branch name, tag, or commit hash) - undefined for "latest" */
  value?: string;
}

/**
 * Editor state for a template.
 */
export interface EditorTemplateState {
  /** Template name (auto-generated from project) */
  name: string;
  /** Optional description */
  description?: string;
  /** Parent template spec to extend (e.g., "contexts/demo") */
  extends?: string;
  /** Mount points (user-defined + inherited) */
  mountPoints: MountPoint[];
}

/**
 * Available template info from contexts/ directory.
 */
export interface AvailableTemplate {
  /** Git spec (e.g., "contexts/demo") */
  spec: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
}

/**
 * Workspace node from getWorkspaceTree.
 */
export interface WorkspaceNode {
  name: string;
  path: string;
  isGitRepo: boolean;
  launchable?: { type: string; title: string };
  packageInfo?: { name: string; version?: string };
  skillInfo?: { name: string; description: string };
  children: WorkspaceNode[];
}

/**
 * Workspace tree response.
 */
export interface WorkspaceTree {
  children: WorkspaceNode[];
}

/**
 * Resolved template with inheritance chain.
 */
export interface ResolvedTemplate {
  name?: string;
  description?: string;
  structure: Record<string, string>;
  inheritanceChain: string[];
}

/**
 * Props for ContextTemplateEditor component.
 */
export interface ContextTemplateEditorProps {
  /** Current template (for editing) or undefined (for new) */
  initialTemplate?: ContextTemplateYaml;
  /** Git spec of the project repo where template will be saved */
  projectRepoSpec: string;
  /** Project name (used for auto-generating template name) */
  projectName: string;
  /** Called when user saves the template */
  onSave: (template: ContextTemplateYaml) => Promise<void>;
  /** Called when template changes (for parent form validation) */
  onChange?: (template: ContextTemplateYaml, isValid: boolean) => void;
  /** Whether the editor is expanded */
  expanded?: boolean;
  /** Toggle expansion */
  onToggleExpanded?: () => void;
}

/**
 * Props for ProjectRepoSelector component.
 */
export interface ProjectRepoSelectorProps {
  /** Currently selected repo spec */
  value: string | null;
  /** Called when repo is selected or created */
  onChange: (repoSpec: string) => void;
  /** Called when a new repo is created */
  onCreateNew?: (location: string, name: string) => Promise<string>;
}

/**
 * Convert editor state to YAML format.
 */
export function stateToYaml(state: EditorTemplateState): ContextTemplateYaml {
  const yaml: ContextTemplateYaml = {
    name: state.name,
  };

  if (state.description) {
    yaml.description = state.description;
  }

  if (state.extends) {
    yaml.extends = state.extends;
  }

  // Only include user-defined mount points (not inherited)
  const userMounts = state.mountPoints.filter(mp => !mp.isInherited);
  if (userMounts.length > 0) {
    yaml.structure = {};
    for (const mp of userMounts) {
      const specWithRef = formatGitSpec(mp.repoSpec, mp.ref);
      yaml.structure[mp.path] = specWithRef;
    }
  }

  return yaml;
}

/**
 * Format a git spec with ref.
 */
export function formatGitSpec(repoSpec: string, ref: RefSelection): string {
  if (ref.type === "latest" || !ref.value) {
    return repoSpec;
  }
  if (ref.type === "branch") {
    return `${repoSpec}#${ref.value}`;
  }
  // tag or commit use @
  return `${repoSpec}@${ref.value}`;
}

/**
 * Parse a git spec into repo and ref.
 */
export function parseGitSpec(spec: string): { repoSpec: string; ref: RefSelection } {
  // Check for branch (#)
  const branchIdx = spec.indexOf("#");
  if (branchIdx !== -1) {
    return {
      repoSpec: spec.slice(0, branchIdx),
      ref: { type: "branch", value: spec.slice(branchIdx + 1) },
    };
  }

  // Check for tag/commit (@)
  const atIdx = spec.indexOf("@");
  if (atIdx !== -1) {
    const refValue = spec.slice(atIdx + 1);
    // Detect if it's a commit hash (7-40 hex chars)
    const isCommit = /^[0-9a-f]{7,40}$/i.test(refValue);
    return {
      repoSpec: spec.slice(0, atIdx),
      ref: { type: isCommit ? "commit" : "tag", value: refValue },
    };
  }

  return {
    repoSpec: spec,
    ref: { type: "latest" },
  };
}

/**
 * Generate a unique ID for mount points.
 */
export function generateMountId(): string {
  return `mount-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate default mount path for a repo.
 */
export function defaultMountPath(repoSpec: string): string {
  // Mirror workspace structure under /workspace/ prefix
  // e.g., "panels/code-editor" -> "/workspace/panels/code-editor"
  // e.g., "panels/code-editor#main" -> "/workspace/panels/code-editor"
  const specWithoutRef = repoSpec.split("#")[0];
  return `/workspace/${specWithoutRef}`;
}

/**
 * Loaded template info (from bridge.loadContextTemplate).
 */
export interface TemplateInfo {
  /** Template name */
  name?: string;
  /** Optional description */
  description?: string;
  /** Parent template to extend */
  extends?: string;
  /** Mount point structure */
  structure?: Record<string, string>;
}

/**
 * Mount entry in YAML structure.
 */
export interface MountEntry {
  /** Mount path */
  path: string;
  /** Git spec with optional ref */
  spec: string;
}

/**
 * Generate template spec from location and name.
 */
export function generateTemplateSpec(location: string, repoName: string): string {
  return `${location}/${repoName}`;
}

/**
 * Convert YAML to editor state.
 */
export function yamlToEditorState(yaml: ContextTemplateYaml, projectName: string): EditorTemplateState {
  const mountPoints: MountPoint[] = [];

  if (yaml.structure) {
    for (const [path, spec] of Object.entries(yaml.structure)) {
      const { repoSpec, ref } = parseGitSpec(spec);
      mountPoints.push({
        id: generateMountId(),
        path,
        repoSpec,
        ref,
        isInherited: false,
      });
    }
  }

  return {
    name: yaml.name ?? projectName,
    description: yaml.description,
    extends: yaml.extends,
    mountPoints,
  };
}

/**
 * Alias for stateToYaml for consistency.
 */
export const editorStateToYaml = stateToYaml;
