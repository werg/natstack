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

export interface ParsedChildUrl {
  source: string;
  gitRef?: string;
  sessionId?: string;
  repoArgs?: Record<string, RepoArgSpec>;
  ephemeral?: boolean;
}

export function parseChildUrl(url: string): ParsedChildUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "natstack-child:") {
    throw new Error(`Invalid child URL protocol: ${parsed.protocol}`);
  }

  // Preferred format: natstack-child:///panels/editor?session=safe_named_abc#main
  // Note: URLs like natstack-child://panels/editor parse "panels" as host; support both.
  const rawPath = parsed.host ? `${parsed.host}${parsed.pathname}` : parsed.pathname.replace(/^\/+/, "");
  const source = decodeURIComponent(rawPath);
  if (!source) {
    throw new Error(`Invalid child URL: missing source path (${url})`);
  }

  const sessionId = parsed.searchParams.get("session") ?? undefined;
  const repoArgsParam = parsed.searchParams.get("repoArgs");
  const gitRef = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : undefined;
  const ephemeral = parsed.searchParams.get("ephemeral") === "true" || undefined;
  let repoArgs: Record<string, RepoArgSpec> | undefined;
  if (repoArgsParam) {
    try {
      const parsed = JSON.parse(repoArgsParam);
      const result = RepoArgsSchema.safeParse(parsed);
      if (result.success) {
        repoArgs = result.data;
      } else {
        throw new Error(`Invalid repoArgs in child URL: ${result.error.message}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error("Invalid JSON in repoArgs parameter");
      }
      throw e;
    }
  }
  return { source, gitRef: gitRef || undefined, sessionId, repoArgs, ephemeral };
}

export interface BuildChildUrlOptions {
  gitRef?: string;
  sessionId?: string;
  repoArgs?: Record<string, RepoArgSpec>;
  ephemeral?: boolean;
}

export function buildChildUrl(source: string, options?: BuildChildUrlOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const searchParams = new URLSearchParams();
  if (options?.sessionId) searchParams.set("session", options.sessionId);
  if (options?.repoArgs) searchParams.set("repoArgs", JSON.stringify(options.repoArgs));
  if (options?.ephemeral) searchParams.set("ephemeral", "true");
  const paramsStr = searchParams.toString();
  const params = paramsStr ? `?${paramsStr}` : "";
  const fragment = options?.gitRef ? `#${encodeURIComponent(options.gitRef)}` : "";
  return `natstack-child:///${encodedPath}${params}${fragment}`;
}
