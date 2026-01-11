export interface BuildChildLinkOptions {
  gitRef?: string;
  sessionId?: string;
}

export function buildChildLink(source: string, options?: BuildChildLinkOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const params = options?.sessionId ? `?session=${encodeURIComponent(options.sessionId)}` : "";
  const fragment = options?.gitRef ? `#${encodeURIComponent(options.gitRef)}` : "";
  return `natstack-child:///${encodedPath}${params}${fragment}`;
}
