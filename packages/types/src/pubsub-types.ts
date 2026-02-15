/**
 * PubSub Types - Shared types extracted from @workspace/pubsub.
 */

/**
 * Structured agent build error with full diagnostics.
 * Returned when an agent fails to spawn due to build errors.
 */
export interface AgentBuildError {
  message: string;
  buildLog?: string;
  typeErrors?: Array<{
    file: string;
    line: number;
    column: number;
    message: string;
  }>;
  dirtyRepo?: {
    modified: string[];
    untracked: string[];
    staged: string[];
  };
}
