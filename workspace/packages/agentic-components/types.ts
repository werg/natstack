/**
 * Minimal agent info for selection UI.
 */
export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
}

export interface AgentSelectorProps {
  /** Available agents to select from */
  agents: AgentInfo[];
  /** Currently selected agent ID */
  defaultAgentId?: string;
  /** Callback when selection changes */
  onDefaultAgentChange: (agentId: string | undefined) => void;
  /** Show loading state */
  loading?: boolean;
}
