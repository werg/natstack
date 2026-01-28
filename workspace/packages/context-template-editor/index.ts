/**
 * Context Template Editor package.
 *
 * Provides a UI for creating and editing context templates
 * that define OPFS sandbox configurations for NatStack projects.
 */

// Main editor component
export { ContextTemplateEditor } from "./components/ContextTemplateEditor";

// Sub-components (for custom compositions)
export { ParentTemplateSelector } from "./components/ParentTemplateSelector";
export { ProjectRepoSelector, type RepoLocation } from "./components/ProjectRepoSelector";
export { MountPointList } from "./components/MountPointList";
export { MountPointItem } from "./components/MountPointItem";
export { RepoSelector } from "./components/RepoSelector";
export { RefSelector } from "./components/RefSelector";
export { InheritanceChain } from "./components/InheritanceChain";
export { TemplateInfoCard } from "./components/TemplateInfoCard";

// Hooks (for custom implementations)
export { useTemplateState } from "./hooks/useTemplateState";
export { useAvailableTemplates } from "./hooks/useAvailableTemplates";
export {
  useWorkspaceTree,
  findGitRepos,
  findProjectRepos,
  groupReposByDirectory,
  filterReposByPrefix,
  PROJECT_DIRECTORIES,
} from "./hooks/useWorkspaceTree";
export { useGitRefs } from "./hooks/useGitRefs";

// Types
export type {
  ContextTemplateYaml,
  MountEntry,
  MountPoint,
  RefSelection,
  EditorTemplateState,
  WorkspaceNode,
  WorkspaceTree,
  TemplateInfo,
  AvailableTemplate,
  ResolvedTemplate,
} from "./types";

// Utilities
export {
  parseGitSpec,
  formatGitSpec,
  generateTemplateSpec,
  generateMountId,
  defaultMountPath,
  stateToYaml,
  yamlToEditorState,
  editorStateToYaml,
} from "./types";

// Hook result types
export type { UseTemplateStateOptions, UseTemplateStateResult, ValidationError } from "./hooks/useTemplateState";
