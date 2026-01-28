/**
 * Agent utility functions for project-panel.
 */

import { getAgentRegistry, type AgentDefinition } from "@natstack/agentic-messaging/registry";

let cachedAgents: AgentDefinition[] | null = null;

/**
 * Get agent definition by ID.
 */
export async function getAgentById(agentId: string): Promise<AgentDefinition | null> {
  if (!cachedAgents) {
    const registry = getAgentRegistry();
    await registry.initialize();
    cachedAgents = await registry.listEnabled();
  }
  return cachedAgents.find((a) => a.id === agentId) ?? null;
}

/**
 * Get agent worker source from definition.
 */
export function getAgentWorkerSource(agentDef: AgentDefinition): string {
  return agentDef.workerSource;
}

/**
 * Get agent handle from definition.
 */
export function getAgentHandle(agentDef: AgentDefinition): string {
  return agentDef.proposedHandle;
}
