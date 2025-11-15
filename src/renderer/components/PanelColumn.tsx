import { useMemo, useRef, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import type { PanelColumnLayout, PanelTabModel } from '../types/panel.types';
import {
  closePanelAtom,
  launchChildAtom,
  navigateToAtom,
  selectSiblingAtom,
  toggleMinimizeAtom,
  setPanelWidthAtom,
} from '../state/panelAtoms';
import { TabBar } from './TabBar';

interface PanelColumnProps {
  column: PanelColumnLayout;
}

export function PanelColumn({ column }: PanelColumnProps) {
  const launchChild = useSetAtom(launchChildAtom);
  const closePanel = useSetAtom(closePanelAtom);
  const navigateTo = useSetAtom(navigateToAtom);
  const selectSibling = useSetAtom(selectSiblingAtom);
  const toggleMinimize = useSetAtom(toggleMinimizeAtom);
  const setPanelWidth = useSetAtom(setPanelWidthAtom);

  const panelRef = useRef<HTMLDivElement>(null);
  const resizeStartX = useRef<number>(0);
  const resizeStartWidth = useRef<number>(0);

  const panelClassName = useMemo(() => {
    const classes = ['panel'];
    return classes.join(' ');
  }, []);

  const handleTabSelection = (tab: PanelTabModel): void => {
    switch (tab.kind) {
      case 'breadcrumb':
        // Navigate to a minimized ancestor panel
        navigateTo(tab.id);
        break;

      case 'sibling':
        // Switch to a sibling panel
        if (!tab.parentId) {
          console.error('Sibling tab missing parentId:', tab);
          return;
        }
        selectSibling({ parentId: tab.parentId, childId: tab.id });
        break;

      default:
        // Exhaustiveness check - TypeScript will error if a new tab kind is added
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _exhaustive: never = tab.kind;
        console.error('Unknown tab kind:', tab);
    }
  };

  const handleLaunchChild = (): void => {
    launchChild({ parentId: column.id });
  };

  const handleClose = (): void => {
    closePanel(column.id);
  };

  const handleToggleMinimize = (): void => {
    toggleMinimize(column.id);
  };

  const handleResizeStart = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      if (!panelRef.current) return;

      resizeStartX.current = e.clientX;
      resizeStartWidth.current = panelRef.current.offsetWidth;

      const handleMouseMove = (moveEvent: MouseEvent): void => {
        const deltaX = moveEvent.clientX - resizeStartX.current;
        const newWidth = Math.max(
          60,
          Math.min(window.innerWidth * 0.8, resizeStartWidth.current + deltaX)
        );
        setPanelWidth({ panelId: column.id, width: newWidth });
      };

      const handleMouseUp = (): void => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [column.id, setPanelWidth]
  );

  return (
    <div
      ref={panelRef}
      className={panelClassName}
      style={{
        width: `${column.widthFraction * 100}%`,
        flex: `0 0 ${column.widthFraction * 100}%`,
        position: 'relative',
      }}
      data-panel-id={column.id}
    >
      {/* Top tabs: minimized ancestors for leftmost panel */}
      {column.topTabs.length > 0 && (
        <TabBar
          tabs={column.topTabs}
          variant="breadcrumbs"
          ariaLabel="Minimized ancestor panels"
          onSelect={handleTabSelection}
        />
      )}

      {/* Sibling tabs always at top of panel */}
      {column.siblingTabs.length > 0 && (
        <TabBar
          tabs={column.siblingTabs}
          variant="siblings"
          ariaLabel="Sibling panels"
          onSelect={handleTabSelection}
        />
      )}

      <header className="panel-header">
        <h2 className="panel-title">{column.node.title}</h2>
        <div className="panel-actions">
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={handleToggleMinimize}
            aria-label={column.minimized ? 'Restore panel' : 'Minimize panel'}
          >
            {column.minimized ? '▶' : '◀'}
          </button>
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={handleLaunchChild}
          >
            Launch Child
          </button>
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={handleClose}
            >
              Close
            </button>
        </div>
      </header>

      <div className="panel-content">
        <div className="panel-section">
          <p className="panel-meta">Panel ID: {column.id}</p>
          <p className="panel-meta">
            Hi
          </p>
        </div>

        <div className="panel-section">
          <p className="panel-meta">
            Children: {column.node.children.length || 'None'}
          </p>
        </div>
      </div>

      {/* Bottom tabs: minimized ancestors (breadcrumbs) for non-leftmost panels */}
      {column.bottomTabs.length > 0 && (
        <TabBar
          tabs={column.bottomTabs}
          variant="breadcrumbs-bottom"
          ariaLabel="Minimized ancestor panels"
          onSelect={handleTabSelection}
        />
      )}

      {/* Resize handle */}
      <div
        className="resize-handle"
        onMouseDown={handleResizeStart}
        aria-label="Resize panel"
      />
    </div>
  );
}
