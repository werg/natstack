/**
 * In-memory document buffer for open MDX files.
 *
 * `savedMdx` tracks the bytes on disk; `currentMdx` tracks the user's
 * in-flight edits. `lastFlushedMdx` is the snapshot we published in the most
 * recent `kb.user_edit` — diffs are computed against that, not against disk,
 * so agent-written edits don't reappear in the next user flush.
 */

export interface FileBufferEntry {
  path: string;
  savedMdx: string;
  currentMdx: string;
  lastFlushedMdx: string;
  loadedAt: number;
}

export type FileBufferMap = Record<string, FileBufferEntry>;

export function createBufferEntry(path: string, content: string): FileBufferEntry {
  return {
    path,
    savedMdx: content,
    currentMdx: content,
    lastFlushedMdx: content,
    loadedAt: Date.now(),
  };
}

export function isBufferDirty(entry: FileBufferEntry): boolean {
  return entry.currentMdx !== entry.savedMdx;
}

export function hasUnflushedChanges(entry: FileBufferEntry): boolean {
  return entry.currentMdx !== entry.lastFlushedMdx;
}
