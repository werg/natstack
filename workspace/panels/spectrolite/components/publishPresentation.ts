import type { PublishSnapshot } from "../app/publishController";

export interface PublishPresentation {
  count: number;
  uncommittedCount: number;
  hasUncommitted: boolean;
  hasChanges: boolean;
  publishBlocked: boolean;
  syncBlockedByUncommitted: boolean;
  statusLabel: string;
}

export function getPublishPresentation(
  snapshot: PublishSnapshot,
  dirtyCount: number
): PublishPresentation {
  const count = snapshot.ahead;
  const uncommittedCount = Math.max(snapshot.uncommitted, dirtyCount);
  const hasUncommitted = uncommittedCount > 0;
  const localChangesLabel = formatLocalChanges(count, uncommittedCount);
  const publishBlocked = snapshot.deleted;
  const hasChanges = !publishBlocked && localChangesLabel !== null;

  let statusLabel = "Published";
  if (snapshot.deleted) {
    statusLabel = "Repo deleted";
  } else if (snapshot.diverged) {
    statusLabel = localChangesLabel ? `Needs sync, ${localChangesLabel}` : "Needs sync";
  } else if (localChangesLabel) {
    statusLabel = sentenceCase(localChangesLabel);
  }

  return {
    count,
    uncommittedCount,
    hasUncommitted,
    hasChanges,
    publishBlocked,
    syncBlockedByUncommitted: hasUncommitted,
    statusLabel,
  };
}

function formatLocalChanges(count: number, uncommittedCount: number): string | null {
  if (count > 0 && uncommittedCount > 0) {
    return `${count} unpublished, ${uncommittedCount} uncommitted`;
  }
  if (count > 0) {
    return `${count} unpublished change${count === 1 ? "" : "s"}`;
  }
  if (uncommittedCount > 0) {
    return `uncommitted change${uncommittedCount === 1 ? "" : "s"}`;
  }
  return null;
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
