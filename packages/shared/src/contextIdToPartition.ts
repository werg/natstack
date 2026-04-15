/**
 * Convert a NatStack contextId into the Electron session partition used by
 * app panels. Panels with the same contextId share browser storage; panels
 * with different contextIds are isolated.
 */
export function contextIdToPartition(contextId: string): string {
  return `persist:panel:${contextId}`;
}
