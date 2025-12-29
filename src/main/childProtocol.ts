export interface ParsedChildUrl {
  source: string;
  gitRef?: string;
}

export function parseChildUrl(url: string): ParsedChildUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "natstack-child:") {
    throw new Error(`Invalid child URL protocol: ${parsed.protocol}`);
  }

  // Preferred format: natstack-child:///panels/editor#main
  // Note: URLs like natstack-child://panels/editor parse "panels" as host; support both.
  const rawPath = parsed.host ? `${parsed.host}${parsed.pathname}` : parsed.pathname.replace(/^\/+/, "");
  const source = decodeURIComponent(rawPath);
  if (!source) {
    throw new Error(`Invalid child URL: missing source path (${url})`);
  }

  const gitRef = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : undefined;
  return { source, gitRef: gitRef || undefined };
}

export function buildChildUrl(source: string, gitRef?: string): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const fragment = gitRef ? `#${encodeURIComponent(gitRef)}` : "";
  return `natstack-child:///${encodedPath}${fragment}`;
}

