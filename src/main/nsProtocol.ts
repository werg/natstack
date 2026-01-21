/**
 * Protocol parser for ns:// URLs.
 *
 * URL Format: ns:///{source}?action={navigate|child}&context={context}&repoArgs={json}&gitRef={ref}
 *
 * Examples:
 *   ns:///panels/editor
 *   ns:///panels/editor?action=child
 *   ns:///workers/background-task
 *   ns:///panels/editor?gitRef=main
 *   ns:///panels/editor?repoArgs=%7B%22workspace%22%3A%22repos%2Fapp%22%7D
 */

import { z } from "zod";
import type { RepoArgSpec } from "../shared/ipc/types.js";

const RepoArgSpecSchema = z.union([
  z.string(),
  z.object({
    repo: z.string(),
    ref: z.string().optional(),
  }),
]);

const RepoArgsSchema = z.record(z.string(), RepoArgSpecSchema);

export type NsAction = "navigate" | "child";

export interface ParsedNsUrl {
  source: string;
  action: NsAction;
  gitRef?: string;
  /**
   * Context ID configuration:
   * - undefined: auto-derive from panel ID (default)
   * - true: generate a new unique context
   * - string: use that specific context ID
   */
  contextId?: boolean | string;
  repoArgs?: Record<string, RepoArgSpec>;
  env?: Record<string, string>;
  name?: string;
  ephemeral?: boolean;
  /** If true, immediately focus the new panel after creation (only applies to action=child on app panels) */
  focus?: boolean;
  /** Unsafe mode configuration (true, false, or path string) */
  unsafe?: boolean | string;
}

/**
 * Parse an ns:// URL into its components.
 */
export function parseNsUrl(url: string): ParsedNsUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "ns:") {
    throw new Error(`Invalid ns URL protocol: ${parsed.protocol}`);
  }

  // Format: ns:///panels/editor or ns://panels/editor
  // Note: URLs like ns://panels/editor parse "panels" as host; support both.
  const rawPath = parsed.host ? `${parsed.host}${parsed.pathname}` : parsed.pathname.replace(/^\/+/, "");
  const source = decodeURIComponent(rawPath);
  if (!source) {
    throw new Error(`Invalid ns URL: missing source path (${url})`);
  }

  // Parse action (default: navigate)
  const actionParam = parsed.searchParams.get("action");
  let action: NsAction = "navigate";
  if (actionParam === "child") {
    action = "child";
  } else if (actionParam && actionParam !== "navigate") {
    throw new Error(`Invalid ns URL action: ${actionParam} (expected "navigate" or "child")`);
  }

  const gitRef = parsed.searchParams.get("gitRef") ?? undefined;
  const name = parsed.searchParams.get("name") ?? undefined;
  const ephemeral = parsed.searchParams.get("ephemeral") === "true" || undefined;
  const focus = parsed.searchParams.get("focus") === "true" || undefined;

  // Parse contextId: "true" -> true (new unique context), string -> that context ID
  // Also support legacy "context" and "newContext" params for backwards compatibility
  let contextId: boolean | string | undefined;
  const contextIdParam = parsed.searchParams.get("contextId");
  const legacyContext = parsed.searchParams.get("context");
  const legacyNewContext = parsed.searchParams.get("newContext") === "true";

  if (contextIdParam === "true" || legacyNewContext) {
    contextId = true;
  } else if (contextIdParam) {
    contextId = contextIdParam;
  } else if (legacyContext) {
    contextId = legacyContext;
  }

  // Parse unsafe parameter: "true" -> true, "false" -> false, other string -> path
  const unsafeParam = parsed.searchParams.get("unsafe");
  let unsafe: boolean | string | undefined;
  if (unsafeParam === "true") {
    unsafe = true;
  } else if (unsafeParam === "false") {
    unsafe = false;
  } else if (unsafeParam) {
    unsafe = unsafeParam; // Path string
  }

  let repoArgs: Record<string, RepoArgSpec> | undefined;
  const repoArgsParam = parsed.searchParams.get("repoArgs");
  if (repoArgsParam) {
    try {
      const parsedJson = JSON.parse(repoArgsParam);
      const result = RepoArgsSchema.safeParse(parsedJson);
      if (result.success) {
        repoArgs = result.data;
      } else {
        throw new Error(`Invalid repoArgs in ns URL: ${result.error.message}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error("Invalid JSON in repoArgs parameter");
      }
      throw e;
    }
  }

  let env: Record<string, string> | undefined;
  const envParam = parsed.searchParams.get("env");
  if (envParam) {
    try {
      const parsedEnv = JSON.parse(envParam);
      if (typeof parsedEnv === "object" && parsedEnv !== null) {
        // Validate all values are strings
        const isValid = Object.values(parsedEnv).every((v) => typeof v === "string");
        if (isValid) {
          env = parsedEnv as Record<string, string>;
        } else {
          throw new Error("Invalid env in ns URL: all values must be strings");
        }
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error("Invalid JSON in env parameter");
      }
      throw e;
    }
  }

  return { source, action, gitRef, contextId, repoArgs, env, name, ephemeral, focus, unsafe };
}

export interface BuildNsUrlOptions {
  action?: NsAction;
  gitRef?: string;
  /**
   * Context ID configuration:
   * - true: generate a new unique context
   * - string: use that specific context ID
   */
  contextId?: boolean | string;
  repoArgs?: Record<string, RepoArgSpec>;
  env?: Record<string, string>;
  name?: string;
  ephemeral?: boolean;
  /** If true, immediately focus the new panel after creation (only applies to action=child on app panels) */
  focus?: boolean;
  /** Unsafe mode configuration (true, false, or path string) */
  unsafe?: boolean | string;
}

/**
 * Build an ns:// URL from source and options.
 */
export function buildNsUrl(source: string, options?: BuildNsUrlOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const searchParams = new URLSearchParams();

  if (options?.action && options.action !== "navigate") {
    searchParams.set("action", options.action);
  }
  if (options?.contextId !== undefined) {
    // true -> "true", string -> the string value
    searchParams.set("contextId", String(options.contextId));
  }
  if (options?.gitRef) {
    searchParams.set("gitRef", options.gitRef);
  }
  if (options?.repoArgs) {
    searchParams.set("repoArgs", JSON.stringify(options.repoArgs));
  }
  if (options?.env) {
    searchParams.set("env", JSON.stringify(options.env));
  }
  if (options?.name) {
    searchParams.set("name", options.name);
  }
  if (options?.ephemeral) {
    searchParams.set("ephemeral", "true");
  }
  if (options?.focus) {
    searchParams.set("focus", "true");
  }
  if (options?.unsafe !== undefined) {
    searchParams.set("unsafe", String(options.unsafe));
  }

  const paramsStr = searchParams.toString();
  const params = paramsStr ? `?${paramsStr}` : "";
  return `ns:///${encodedPath}${params}`;
}
