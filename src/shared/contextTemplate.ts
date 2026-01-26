/**
 * Shared context template types used by main process and runtime/UI.
 */

/**
 * An available context template that can be selected by users.
 */
export interface AvailableTemplate {
  /** Template spec path relative to workspace (e.g., "contexts/default") */
  spec: string;
  /** Display name from YAML or directory name */
  name: string;
  /** Optional description from YAML */
  description?: string;
}
