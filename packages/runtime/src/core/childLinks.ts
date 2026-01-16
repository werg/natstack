import type { RepoArgSpec } from "./types.js";

export interface BuildChildLinkOptions {
  gitRef?: string;
  sessionId?: string;
  repoArgs?: Record<string, RepoArgSpec>;
}

export function buildChildLink(source: string, options?: BuildChildLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const searchParams = new URLSearchParams();
  if (options?.sessionId) searchParams.set("session", options.sessionId);
  if (options?.repoArgs) searchParams.set("repoArgs", JSON.stringify(options.repoArgs));
  const paramsStr = searchParams.toString();
  const params = paramsStr ? `?${paramsStr}` : "";
  const fragment = options?.gitRef ? `#${encodeURIComponent(options.gitRef)}` : "";
  return `natstack-child:///${encodedPath}${params}${fragment}`;
}
