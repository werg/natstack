export function resolveChatContextId(
  stateArgsContextId: string | undefined,
  runtimeContextId: string | undefined,
): string | undefined {
  const contextId = stateArgsContextId ?? runtimeContextId;
  if (typeof contextId !== "string") return undefined;
  const trimmed = contextId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Per-agent record persisted into `stateArgs.installedAgents`. */
export interface InstalledAgentRecord {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
  /** Per-agent config (model/effort/approval/respondPolicy/…) used to (re)create
   *  the agent — seeded into its creation stateArgs, NOT the subscription. */
  config?: Record<string, unknown>;
}

/** Append a newly-added agent to the existing installedAgents list. Pure helper
 *  used by handleAddAgent so the persistence shape is unit-testable. */
export function appendInstalledAgent(
  existing: InstalledAgentRecord[] | undefined,
  agent: InstalledAgentRecord,
): InstalledAgentRecord[] {
  return [...(existing ?? []), agent];
}
