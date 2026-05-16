import type { ProviderName } from "./types.js";

export type ProviderApiKeyGetter = (
  name: string,
) => string | undefined | Promise<string | undefined>;

/**
 * Picks the search provider based on which API keys are available.
 *
 * Preference order: Tavily > Brave > Exa > DuckDuckGo (zero-config fallback).
 * Tavily wins because it's the most agent-friendly (returns long, clean
 * snippets); Brave is the next-best general engine; Exa is excellent for
 * semantic/neural queries; DDG is the residual free fallback.
 */
export async function selectSearchProvider(
  getKey: ProviderApiKeyGetter | undefined,
): Promise<ProviderName> {
  if (!getKey) return "duckduckgo";
  if (await hasKey(getKey, "TAVILY_API_KEY")) return "tavily";
  if (await hasKey(getKey, "BRAVE_API_KEY")) return "brave";
  if (await hasKey(getKey, "EXA_API_KEY")) return "exa";
  return "duckduckgo";
}

async function hasKey(getKey: ProviderApiKeyGetter, name: string): Promise<boolean> {
  const v = await getKey(name);
  return typeof v === "string" && v.trim().length > 0;
}
