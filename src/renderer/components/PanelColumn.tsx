import { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import type { PanelColumnLayout, PanelTabModel } from '../types/panel.types';
import {
  closePanelAtom,
  launchChildAtom,
  navigateToAtom,
  rootPanelIdAtom,
  selectSiblingAtom,
} from '../state/panelAtoms';
import { TabBar } from './TabBar';

interface PanelColumnProps {
  column: PanelColumnLayout;
}

export function PanelColumn({ column }: PanelColumnProps) {
  const rootPanelId = useAtomValue(rootPanelIdAtom);
  const launchChild = useSetAtom(launchChildAtom);
  const closePanel = useSetAtom(closePanelAtom);
  const navigateTo = useSetAtom(navigateToAtom);
  const selectSibling = useSetAtom(selectSiblingAtom);

  const panelClassName = useMemo(() => {
    const classes = ['panel'];
    if (column.isTarget) {
      classes.push('panel-target');
    }
    return classes.join(' ');
  }, [column.isTarget]);

  const handleTabSelection = (tab: PanelTabModel): void => {
    switch (tab.kind) {
      case 'breadcrumb':
        // Navigate to a hidden ancestor panel
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

      case 'child':
        // Navigate to a hidden child panel
        navigateTo(tab.id);
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

  return (
    <div
      className={panelClassName}
      style={{ width: `${column.widthPercent}%`, flex: `0 0 ${column.widthPercent}%` }}
      data-panel-id={column.id}
    >
      <TabBar
        tabs={column.breadcrumbTabs}
        variant="breadcrumbs"
        ariaLabel="Hidden ancestor panels"
        onSelect={handleTabSelection}
      />

      <TabBar
        tabs={column.siblingTabs}
        variant="siblings"
        ariaLabel="Sibling panels"
        onSelect={handleTabSelection}
      />

      <header className="panel-header">
        <h2 className="panel-title">{column.node.title}</h2>
        <div className="panel-actions">
          <button
            type="button"
            className="button button-ghost button-sm"
            onClick={handleLaunchChild}
          >
            Launch Child
          </button>
          {column.id !== rootPanelId && (
            <button
              type="button"
              className="button button-ghost button-sm"
              onClick={handleClose}
            >
              Close
            </button>
          )}
        </div>
      </header>

      <div className="panel-content">
        <div className="panel-section">
          <p className="panel-meta">Panel ID: {column.id}</p>
          <p className="panel-meta">
            Depth: {column.depth >= 0 ? column.depth : 0}
          </p>
        </div>

        <div className="panel-section">
          <p className="panel-meta">
            Children: {column.node.children.length || 'None'}
          </p>
        </div>
      </div>

      <TabBar
        tabs={column.childTabs}
        variant="children"
        ariaLabel="Hidden child panels"
        onSelect={handleTabSelection}
      />
    </div>
  );
}
