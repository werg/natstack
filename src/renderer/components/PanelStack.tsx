import { useAtomValue } from 'jotai';

import { panelLayoutAtom } from '../state/panelAtoms';
import { PanelColumn } from './PanelColumn';

export function PanelStack() {
  const layout = useAtomValue(panelLayoutAtom);

  if (layout.columns.length === 0) {
    return (
      <div className="panel-stack">
        <div className="panel panel-target">
          <div className="panel-content">
            <p>No panels selected.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-stack" aria-live="polite">
      {layout.columns.map((column) => (
        <PanelColumn key={column.id} column={column} />
      ))}
    </div>
  );
}
