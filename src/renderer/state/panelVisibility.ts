import { clamp } from '../../main/utils';
import type { PanelId, PanelVisibilityRecord } from '../types/panel.types';

export interface VisibilityInput {
  activePath: PanelId[];
  columnCount: number;
  targetPanelId: PanelId | null;
  previous?: Map<PanelId, PanelVisibilityRecord>;
}

export function reconcileVisibilityState({
  activePath,
  columnCount,
  targetPanelId,
  previous,
}: VisibilityInput): Map<PanelId, PanelVisibilityRecord> {
  if (activePath.length === 0) {
    return previous ?? new Map();
  }

  const maxColumns = Math.max(1, columnCount);
  const maxStartIndex = Math.max(0, activePath.length - maxColumns);
  let startIndex = Math.max(0, activePath.length - maxColumns);

  if (previous && previous.size > 0) {
    const previousFirstVisible = activePath.find(
      (id) => previous.get(id)?.visible
    );
    if (previousFirstVisible) {
      const previousIndex = activePath.indexOf(previousFirstVisible);
      if (previousIndex !== -1) {
        startIndex = clamp(previousIndex, 0, maxStartIndex);
      }
    }
  }

  if (targetPanelId) {
    const targetIndex = activePath.indexOf(targetPanelId);
    if (targetIndex !== -1) {
      if (targetIndex < startIndex) {
        startIndex = targetIndex;
      } else if (targetIndex >= startIndex + maxColumns) {
        startIndex = targetIndex - maxColumns + 1;
      }
    }
  }

  startIndex = clamp(startIndex, 0, maxStartIndex);

  const visibleWindow = activePath.slice(
    startIndex,
    startIndex + maxColumns
  );
  const visibleSet = new Set(visibleWindow);

  const next = new Map<PanelId, PanelVisibilityRecord>();
  activePath.forEach((panelId) => {
    next.set(panelId, {
      panelId,
      visible: visibleSet.has(panelId),
      hiddenBecause: visibleSet.has(panelId) ? null : 'overflow',
    });
  });

  if (previous && mapsEqual(previous, next)) {
    return previous;
  }

  return next;
}

function mapsEqual(
  a: Map<PanelId, PanelVisibilityRecord>,
  b: Map<PanelId, PanelVisibilityRecord>
): boolean {
  if (a.size !== b.size) {
    return false;
  }

  for (const [key, record] of a) {
    const other = b.get(key);
    if (!other) {
      return false;
    }
    if (
      record.visible !== other.visible ||
      record.hiddenBecause !== other.hiddenBecause
    ) {
      return false;
    }
  }

  return true;
}
