/**
 * Agent utility functions for project-panel.
 */

import { rpc } from "@natstack/runtime";
import type { AgentManifest } from "@natstack/core";

let cachedAgents: AgentManifest[] | null = null;

/**
 * Get agent manifest by ID.
 */
export async function getAgentById(agentId: string): Promise<AgentManifest | null> {
  if (!cachedAgents) {
    cachedAgents = await rpc.call<AgentManifest[]>("main", "bridge.listAgents");
  }
  return cachedAgents.find((a) => a.id === agentId) ?? null;
}

/**
 * Get agent handle from manifest.
 */
export function getAgentHandle(agentDef: AgentManifest): string {
  return agentDef.proposedHandle ?? agentDef.id;
}
