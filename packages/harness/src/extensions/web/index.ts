/**
 * NatStack Web Tools Extension
 *
 * Registers three Pi tools:
 *   - `web_search` — Discovery via DuckDuckGo (zero-config) or an
 *     auto-selected keyed provider when the user has configured one
 *     in the credentials system.
 *   - `web_fetch` — Fetches a URL, extracts main content with Mozilla
 *     Readability, converts to markdown, stores the full result in the
 *     content-addressed blobstore, and returns `{ url, title, digest, size, head }`.
 *   - `web_read` — Reads a byte range of a previously-fetched blob by digest
 *     so the agent can drill into large pages without re-fetching.
 *
 * Designed for a "good basic experience" with zero setup: DDG works from
 * any residential IP. To upgrade to Tavily / Brave / Exa, the agent
 * registers a credential via the `@workspace-skills/web-research` skill;
 * the harness never sees the API key — it just fetches the provider URL
 * and the credentialed fetcher attaches auth based on URL audience.
 */
import type { PiExtensionAPI, PiExtensionFactory } from "../../pi-extension-api.js";
import { searchDuckDuckGo } from "./duckduckgo.js";
import { searchTavily } from "./tavily.js";
import { searchBrave } from "./brave.js";
import { searchExa } from "./exa.js";
import { extractPage } from "./extract.js";
import { selectSearchProvider, type CredentialPresenceProbe } from "./provider.js";
export type WebRpcCaller = <T = unknown>(target: string, method: string, args: unknown[]) => Promise<T>;
export interface WebToolsDeps {
    /** RPC client for blobstore put/range reads. */
    rpc: {
        call: WebRpcCaller;
    };
    /**
     * Asks the host whether a credential exists for a given provider origin
     * (e.g. `https://api.tavily.com/`). The host implements this by querying
     * the credentials runtime — the harness never sees the credential value.
     * Without this hook the extension stays on DuckDuckGo.
     */
    hasCredentialForOrigin?: CredentialPresenceProbe;
    /**
     * Override for the global fetch. In production the host wires a
     * binary-safe credentialed fetcher (`main:credentials.proxyFetch`)
     * that auto-attaches auth by URL-audience matching and carries
     * response bodies as bytes so PDFs/images round-trip intact. Tests
     * pass plain mocks.
     */
    fetcher?: typeof fetch;
    /** Length of the head excerpt included inline with `web_fetch` results. */
    headLength?: number;
    /** TTL (ms) for the URL→digest session memo. Default 10 minutes; 0 disables. */
    urlCacheTtlMs?: number;
    /** Override for `Date.now()` — used in tests. */
    now?: () => number;
    /** Minimum gap (ms) between successive requests to the same hostname. 0 disables. */
    perHostGapMs?: number;
    /** Override for sleep — used in tests. */
    sleep?: (ms: number) => Promise<void>;
}
const DEFAULT_HEAD_LENGTH = 5000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_READ_LIMIT = 8000;
const MAX_READ_LIMIT = 32000;
const DEFAULT_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_URL_CACHE_ENTRIES = 200;
/** Minimum gap between successive requests to the same hostname (politeness). */
const DEFAULT_PER_HOST_GAP_MS = 250;
const SEARCH_PARAMETERS = {
    type: "object",
    properties: {
        query: { type: "string", description: "Search query string." },
        max_results: {
            type: "integer",
            description: `How many results to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT}).`,
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
        },
    },
    required: ["query"],
};
const FETCH_PARAMETERS = {
    type: "object",
    properties: {
        url: { type: "string", description: "Absolute URL (http:// or https://) to fetch." },
    },
    required: ["url"],
};
const READ_PARAMETERS = {
    type: "object",
    properties: {
        digest: {
            type: "string",
            description: "sha256 digest returned by an earlier web_fetch call.",
        },
        offset: {
            type: "integer",
            description: "Byte offset to start reading from (default 0).",
            minimum: 0,
        },
        limit: {
            type: "integer",
            description: `Maximum number of bytes to read (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).`,
            minimum: 1,
            maximum: MAX_READ_LIMIT,
        },
    },
    required: ["digest"],
};
export function createWebToolsExtension(deps: WebToolsDeps): PiExtensionFactory {
    const rawFetcher = (deps.fetcher ?? fetch) as typeof fetch;
    const headLength = Math.max(500, deps.headLength ?? DEFAULT_HEAD_LENGTH);
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const urlCacheTtlMs = deps.urlCacheTtlMs ?? DEFAULT_URL_CACHE_TTL_MS;
    const perHostGapMs = Math.max(0, deps.perHostGapMs ?? DEFAULT_PER_HOST_GAP_MS);
    const urlCache = new Map<string, {
        digest: string;
        size: number;
        title: string;
        expiresAt: number;
    }>();
    const hostLastFetch = new Map<string, number>();
    async function politeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        if (perHostGapMs > 0) {
            const host = hostnameOf(input);
            if (host) {
                const last = hostLastFetch.get(host) ?? 0;
                const wait = last + perHostGapMs - now();
                if (wait > 0)
                    await sleep(wait);
                hostLastFetch.set(host, now());
            }
        }
        return rawFetcher(input as never, init);
    }
    const fetcher = politeFetch as unknown as typeof fetch;
    function urlCacheGet(url: string): {
        digest: string;
        size: number;
        title: string;
    } | null {
        const entry = urlCache.get(url);
        if (!entry)
            return null;
        if (entry.expiresAt <= now()) {
            urlCache.delete(url);
            return null;
        }
        return { digest: entry.digest, size: entry.size, title: entry.title };
    }
    function urlCacheSet(url: string, digest: string, size: number, title: string): void {
        if (urlCacheTtlMs <= 0)
            return;
        if (urlCache.size >= MAX_URL_CACHE_ENTRIES) {
            // Drop the oldest entry; insertion order preserves least-recently-set.
            const firstKey = urlCache.keys().next().value;
            if (firstKey !== undefined)
                urlCache.delete(firstKey);
        }
        urlCache.set(url, { digest, size, title, expiresAt: now() + urlCacheTtlMs });
    }
    return (pi: PiExtensionAPI) => {
        pi.registerTool({
            name: "web_search",
            label: "Web Search",
            description: "Search the open web. Returns a list of { title, url, snippet }. Uses DuckDuckGo by default; auto-upgrades to Tavily / Brave / Exa when the user has registered a credential for one of those providers (see the web-research skill).",
            parameters: SEARCH_PARAMETERS as never,
            execute: async (_toolCallId, params) => {
                const { query, max_results } = params as {
                    query: string;
                    max_results?: number;
                };
                if (!query || typeof query !== "string") {
                    throw new Error("web_search: 'query' is required");
                }
                const limit = clampInt(max_results, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
                const provider = await selectSearchProvider(deps.hasCredentialForOrigin);
                const t0 = now();
                const results = await runProvider(provider, query, limit, deps, fetcher);
                const elapsedMs = now() - t0;
                const text = formatSearchResults(results, provider, query);
                return {
                    content: [{ type: "text" as const, text }],
                    details: {
                        provider,
                        query,
                        count: results.length,
                        results,
                        elapsed_ms: elapsedMs,
                    },
                };
            },
        });
        pi.registerTool({
            name: "web_fetch",
            label: "Web Fetch",
            description: "Fetch a URL, extract its main content as markdown, and cache the full result in the blobstore. Returns the cleaned title, a head excerpt, and a digest. Use web_read with the digest to read more of the cached page without re-fetching.",
            parameters: FETCH_PARAMETERS as never,
            execute: async (_toolCallId, params) => {
                const { url } = params as {
                    url: string;
                };
                if (!url || typeof url !== "string") {
                    throw new Error("web_fetch: 'url' is required");
                }
                if (!/^https?:\/\//iu.test(url)) {
                    throw new Error("web_fetch: 'url' must start with http:// or https://");
                }
                const t0 = now();
                const cached = urlCacheGet(url);
                if (cached) {
                    const headSlice = await deps.rpc.call<string | null>("main", "blobstore.getRange", [cached.digest,
                        0,
                        headLength]);
                    if (headSlice !== null) {
                        const truncated = cached.size > headSlice.length;
                        const summary = [
                            `# ${cached.title}`,
                            url,
                            "",
                            `Cached as digest ${cached.digest} (${cached.size} bytes, served from session cache).`,
                            truncated
                                ? `Showing the first ${headSlice.length} of ${cached.size} bytes. Use web_read({ digest, offset, limit }) to read more.`
                                : "Full content shown below.",
                            "",
                            headSlice,
                        ].join("\n");
                        return {
                            content: [{ type: "text" as const, text: summary }],
                            details: {
                                url,
                                title: cached.title,
                                digest: cached.digest,
                                size: cached.size,
                                head_length: headSlice.length,
                                truncated,
                                served_from_cache: true,
                                elapsed_ms: now() - t0,
                            },
                        };
                    }
                    // Blob was pruned out from under us; fall through and re-fetch.
                }
                const page = await extractPage(url, fetcher as never);
                const stored = await deps.rpc.call<{
                    digest: string;
                    size: number;
                }>("main", "blobstore.putText", [page.markdown]);
                urlCacheSet(url, stored.digest, stored.size, page.title);
                const head = page.markdown.slice(0, headLength);
                const truncated = page.markdown.length > head.length;
                const summary = [
                    `# ${page.title}`,
                    page.url,
                    "",
                    `Cached as digest ${stored.digest} (${stored.size} bytes).`,
                    truncated
                        ? `Showing the first ${head.length} of ${stored.size} bytes. Use web_read({ digest, offset, limit }) to read more.`
                        : "Full content shown below.",
                    "",
                    head,
                ].join("\n");
                return {
                    content: [{ type: "text" as const, text: summary }],
                    details: {
                        url: page.url,
                        title: page.title,
                        digest: stored.digest,
                        size: stored.size,
                        head_length: head.length,
                        truncated,
                        served_from_cache: false,
                        elapsed_ms: now() - t0,
                        content_type: page.contentType,
                    },
                };
            },
        });
        pi.registerTool({
            name: "web_read",
            label: "Web Read",
            description: "Read a byte range of a page previously cached by web_fetch. Identify the page by the digest returned from web_fetch.",
            parameters: READ_PARAMETERS as never,
            execute: async (_toolCallId, params) => {
                const { digest, offset, limit } = params as {
                    digest: string;
                    offset?: number;
                    limit?: number;
                };
                if (!digest || typeof digest !== "string") {
                    throw new Error("web_read: 'digest' is required");
                }
                const off = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);
                const len = clampInt(limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
                const slice = await deps.rpc.call<string | null>("main", "blobstore.getRange", [digest,
                    off,
                    len]);
                if (slice === null) {
                    throw new Error(`web_read: no cached blob found for digest ${digest}`);
                }
                return {
                    content: [{ type: "text" as const, text: slice }],
                    details: { digest, offset: off, limit: len, bytes: slice.length },
                };
            },
        });
    };
}
async function runProvider(provider: import("./types.js").ProviderName, query: string, limit: number, _deps: WebToolsDeps, fetcher: typeof fetch): Promise<import("./types.js").SearchResult[]> {
    switch (provider) {
        case "tavily":
            return searchTavily(query, limit, fetcher as never);
        case "brave":
            return searchBrave(query, limit, fetcher as never);
        case "exa":
            return searchExa(query, limit, fetcher as never);
        case "duckduckgo":
        default:
            return searchDuckDuckGo(query, limit, fetcher as never);
    }
}
function hostnameOf(input: string | URL | Request): string | null {
    try {
        if (typeof input === "string")
            return new URL(input).hostname;
        if (input instanceof URL)
            return input.hostname;
        if (input && typeof input === "object" && "url" in input) {
            return new URL((input as {
                url: string;
            }).url).hostname;
        }
        return null;
    }
    catch {
        return null;
    }
}
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
    if (typeof raw !== "number" || !Number.isFinite(raw))
        return fallback;
    const n = Math.trunc(raw);
    if (n < min)
        return min;
    if (n > max)
        return max;
    return n;
}
function formatSearchResults(results: Array<{
    title: string;
    url: string;
    snippet: string;
}>, provider: string, query: string): string {
    if (results.length === 0) {
        return `No results for "${query}" (provider: ${provider}).`;
    }
    const lines: string[] = [`Web search results for "${query}" (provider: ${provider}):`, ""];
    for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet)
            lines.push(`   ${r.snippet}`);
        lines.push("");
    }
    return lines.join("\n");
}
export type { SearchResult, ProviderName } from "./types.js";
export type { CredentialPresenceProbe } from "./provider.js";
