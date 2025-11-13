import { useAtomValue, useSetAtom } from 'jotai';

import {
  activePathAtom,
  panelColumnCountAtom,
  panelLayoutAtom,
  adjustColumnCountAtom,
} from '../state/panelAtoms';
import {
  MIN_COLUMN_COUNT,
  MAX_COLUMN_COUNT,
} from '../constants/panel';

export function ControlBar() {
  const columnCount = useAtomValue(panelColumnCountAtom);
  const layout = useAtomValue(panelLayoutAtom);
  const activePath = useAtomValue(activePathAtom);
  const adjustColumns = useSetAtom(adjustColumnCountAtom);

  return (
    <div className="control-bar">
      <div className="control-group">
        <span className="control-label">Max Visible Panels:</span>
        <button
          type="button"
          className="button button-secondary button-sm"
          onClick={() => adjustColumns(-1)}
          disabled={columnCount <= MIN_COLUMN_COUNT}
          aria-label="Decrease panel columns"
        >
          -
        </button>
        <span className="control-label control-count">{columnCount}</span>
        <button
          type="button"
          className="button button-secondary button-sm"
          onClick={() => adjustColumns(1)}
          disabled={columnCount >= MAX_COLUMN_COUNT}
          aria-label="Increase panel columns"
        >
          +
        </button>
      </div>
      <div className="control-group">
        <span className="control-label">
          Showing {layout.visiblePanelIds.length} / {activePath.length} in path
        </span>
      </div>
    </div>
  );
}
