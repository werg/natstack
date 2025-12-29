export function buildChildLink(source: string, gitRef?: string): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const fragment = gitRef ? `#${encodeURIComponent(gitRef)}` : "";
  return `natstack-child:///${encodedPath}${fragment}`;
}

