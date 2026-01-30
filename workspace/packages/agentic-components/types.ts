export interface AgentSelectorProps {
  defaultAgentId?: string;
  onDefaultAgentChange: (agentId: string | undefined) => void;
}
