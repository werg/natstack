export function resolveChatContextId(
  stateArgsContextId: string | undefined,
  runtimeContextId: string | undefined,
): string | undefined {
  const contextId = stateArgsContextId ?? runtimeContextId;
  if (typeof contextId !== "string") return undefined;
  const trimmed = contextId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Per-agent record persisted into `stateArgs.pendingAgents`. */
export interface PendingAgentRecord {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
}

/** Append a newly-added agent to the existing pendingAgents list. Pure helper
 *  used by handleAddAgent so the persistence shape is unit-testable. */
export function appendPendingAgent(
  existing: PendingAgentRecord[] | undefined,
  agent: PendingAgentRecord,
): PendingAgentRecord[] {
  return [...(existing ?? []), agent];
}

/** Older builds persisted `{agentId, handle}` without `key/source/className`.
 *  This helper backfills missing fields on rehydration while PRESERVING any
 *  existing `key` — regenerating the key would create a new DO row on every
 *  reload, breaking persistence (plan §pendingAgents regression). */
export interface RehydratePendingAgentDefaults {
  workerSource: string;
  fallbackClass: string;
  /** Function returning a short random suffix (UUID prefix). Injectable for tests. */
  randomSuffix: () => string;
}

export function rehydratePendingAgent(
  agent: Partial<PendingAgentRecord> & { agentId: string; handle: string },
  defaults: RehydratePendingAgentDefaults,
): { record: PendingAgentRecord; mutated: boolean } {
  if (agent.key && agent.source && agent.className) {
    return {
      record: {
        agentId: agent.agentId,
        handle: agent.handle,
        key: agent.key,
        source: agent.source,
        className: agent.className,
      },
      mutated: false,
    };
  }
  return {
    record: {
      agentId: agent.agentId,
      handle: agent.handle,
      key: agent.key ?? `${agent.handle}-${defaults.randomSuffix()}`,
      source: agent.source ?? defaults.workerSource,
      className: agent.className ?? agent.agentId,
    },
    mutated: true,
  };
}
