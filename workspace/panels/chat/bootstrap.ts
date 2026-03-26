export function resolveChatContextId(
  stateArgsContextId: string | undefined,
  runtimeContextId: string | undefined,
): string | undefined {
  const contextId = stateArgsContextId ?? runtimeContextId;
  if (typeof contextId !== "string") return undefined;
  const trimmed = contextId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
