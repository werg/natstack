/** Pure bootstrap helpers, unit-testable without the runtime. */

export function resolveNewsContextId(
  stateArgsContextId: string | undefined,
  runtimeContextId: string | undefined,
): string | undefined {
  const contextId = stateArgsContextId ?? runtimeContextId;
  if (typeof contextId !== "string") return undefined;
  const trimmed = contextId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function newsChannelName(random: () => string = () => crypto.randomUUID()): string {
  return `news-${random().slice(0, 8)}`;
}

export function newsAgentKey(random: () => string = () => crypto.randomUUID()): string {
  return `news-agent-${random().slice(0, 8)}`;
}

/** Prompt seeded into the forked deep-dive chat. */
export function deepDivePrompt(story: { title: string; url: string }): string {
  return [
    `Deep-dive: ${story.title}`,
    story.url,
    "web_fetch the article and web_search for context and reactions. Relate it to today's briefing. Start with a tight summary, then go deep.",
  ].join("\n");
}
