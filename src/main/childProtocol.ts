export interface ParsedChildUrl {
  source: string;
  gitRef?: string;
  sessionId?: string;
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
  const gitRef = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : undefined;
  return { source, gitRef: gitRef || undefined, sessionId };
}

export interface BuildChildUrlOptions {
  gitRef?: string;
  sessionId?: string;
}

export function buildChildUrl(source: string, options?: BuildChildUrlOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const params = options?.sessionId ? `?session=${encodeURIComponent(options.sessionId)}` : "";
  const fragment = options?.gitRef ? `#${encodeURIComponent(options.gitRef)}` : "";
  return `natstack-child:///${encodedPath}${params}${fragment}`;
}
