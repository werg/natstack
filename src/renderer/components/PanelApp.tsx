import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import {
  activePathAtom,
  panelColumnCountAtom,
  panelVisibilityStateAtom,
  targetPanelAtom,
} from '../state/panelAtoms';
import { reconcileVisibilityState } from '../state/panelVisibility';
import { ControlBar } from './ControlBar';
import { PanelStack } from './PanelStack';

export function PanelApp() {
  useVisibilitySynchronizer();

  return (
    <div className="app-container">
      <ControlBar />
      <PanelStack />
    </div>
  );
}

/**
 * Hook that synchronizes the visibility state atom with changes to:
 * - activePath (when navigating or adding/removing panels)
 * - columnCount (when user adjusts visible panel limit)
 * - targetPanelId (when user focuses a different panel)
 *
 * Exported for testing purposes.
 */
export function useVisibilitySynchronizer(): void {
  const activePath = useAtomValue(activePathAtom);
  const columnCount = useAtomValue(panelColumnCountAtom);
  const targetPanelId = useAtomValue(targetPanelAtom);
  const setVisibilityState = useSetAtom(panelVisibilityStateAtom);

  useEffect(() => {
    setVisibilityState((previous) =>
      reconcileVisibilityState({
        activePath,
        columnCount,
        targetPanelId,
        previous,
      })
    );
  }, [activePath, columnCount, targetPanelId, setVisibilityState]);
}
