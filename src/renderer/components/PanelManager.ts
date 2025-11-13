/**
 * PanelManager - Orchestrates the entire panel system
 */

import type { PanelId, PanelState, LayoutState } from '../types/panel.types';
import { PanelStateManager } from '../state/PanelState';
import { LayoutEngine } from '../layout/LayoutEngine';
import { Panel } from './Panel';
import { TabStrip, TabData } from './TabStrip';

export class PanelManager {
  private container: HTMLElement;
  private stateManager: PanelStateManager;
  private layoutEngine: LayoutEngine;
  private panels: Map<PanelId, Panel> = new Map();
  private panelStack: HTMLElement;
  private tabStrip: TabStrip;

  constructor(container: HTMLElement, maxVisiblePanels = 3) {
    this.container = container;
    this.stateManager = new PanelStateManager(maxVisiblePanels);
    this.layoutEngine = new LayoutEngine();

    // Create panel stack container
    this.panelStack = document.createElement('div');
    this.panelStack.className = 'panel-stack';

    // Create unified tab strip
    this.tabStrip = new TabStrip('top');
    this.tabStrip.hide();
    this.tabStrip.setOnTabClick((tab) => this.handleTabClick(tab));

    // Add to container
    this.container.appendChild(this.tabStrip);
    this.container.appendChild(this.panelStack);

    // Subscribe to state changes
    this.stateManager.subscribe((state) => this.onStateChange(state));

    // Initialize with root panel
    this.initializeRootPanel();
  }

  /**
   * Initialize the root panel
   */
  private initializeRootPanel(): void {
    const rootId = this.stateManager.getTreeManager().getRootId();
    const rootNode = this.stateManager.getTreeManager().getNode(rootId);

    if (!rootNode) {
      throw new Error('Root panel not found');
    }

    // Create root panel
    const panel = new Panel(rootId, rootNode);
    this.panels.set(rootId, panel);
    this.panelStack.appendChild(panel);

    // Set up initial content
    this.renderPanelContent(rootId);

    // Trigger initial render
    this.render();
  }

  /**
   * Handle state changes
   */
  private onStateChange(state: PanelState): void {
    this.render();
  }

  /**
   * Main render method
   */
  private render(): void {
    const state = this.stateManager.getState();
    const treeManager = this.stateManager.getTreeManager();
    const layout = this.layoutEngine.calculateLayout(state, treeManager);

    // Update panels
    this.updatePanels(layout);

    // Update tab bar
    this.updateTabStrip(layout);
  }

  /**
   * Update panel visibility and states
   */
  private updatePanels(layout: LayoutState): void {
    const state = this.stateManager.getState();
    const treeManager = this.stateManager.getTreeManager();

    // Create/update panels in the active path
    state.activePath.forEach((panelId) => {
      if (!this.panels.has(panelId)) {
        const node = treeManager.getNode(panelId);
        if (node) {
          const panel = new Panel(panelId, node);
          this.panels.set(panelId, panel);
          this.panelStack.appendChild(panel);
          this.renderPanelContent(panelId);
        }
      }
    });

    // Update visibility and order
    const visiblePanelIds = layout.visiblePanels;
    const expandedPanelIds = layout.expandedPanels;

    this.panels.forEach((panel, panelId) => {
      const node = treeManager.getNode(panelId);
      if (node) {
        panel.setTitle(node.title);
      }

      const isVisible = visiblePanelIds.includes(panelId);
      const isExpanded = expandedPanelIds.includes(panelId);
      const isFocused = state.focusedPanel === panelId;
      const isInActivePath = state.activePath.includes(panelId);

      if (isVisible) {
        // Show panel
        if (isExpanded) {
          panel.setVisibility('expanded');
        } else {
          panel.setVisibility('collapsed');
        }

        // Set width
        const width = layout.panelWidths.get(panelId) || 0;
        panel.setWidth(width);

        // Set focus state
        panel.setFocused(isFocused);

        // Set active state
        panel.setActive(isInActivePath);
      } else {
        // Hide panel
        panel.setVisibility('hidden');
      }
    });

    // Reorder panels in DOM to match visible order
    visiblePanelIds.forEach((panelId) => {
      const panel = this.panels.get(panelId);
      if (panel) {
        this.panelStack.appendChild(panel);
      }
    });
  }

  /**
   * Update the unified tab bar (breadcrumbs + sibling tabs)
   */
  private updateTabStrip(layout: LayoutState): void {
    const state = this.stateManager.getState();
    const treeManager = this.stateManager.getTreeManager();

    this.tabStrip.clearTabs();

    if (layout.tabEntries.length === 0) {
      this.tabStrip.hide();
      return;
    }

    layout.tabEntries.forEach((entry) => {
      const node = treeManager.getNode(entry.id);
      if (!node) {
        return;
      }

      this.tabStrip.addTab({
        id: entry.id,
        title: node.title,
        active: state.focusedPanel === entry.id,
        kind: entry.kind,
        parentId: entry.parentId,
      });
    });

    this.tabStrip.show();
  }

  /**
   * Render content for a specific panel
   */
  private renderPanelContent(panelId: PanelId): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Clear existing content
    panel.clearContent();

    // Add "Launch Child" button for prototype
    const content = panel.getContentElement();

    const buttonContainer = document.createElement('div');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.flexDirection = 'column';
    buttonContainer.style.gap = '12px';

    // Launch Child button
    const launchButton = document.createElement('button');
    launchButton.className = 'button button-primary';
    launchButton.textContent = 'Launch Child Panel';
    launchButton.addEventListener('click', () => this.handleLaunchChild(panelId));
    buttonContainer.appendChild(launchButton);

    // If not root, add close button
    if (panelId !== this.stateManager.getTreeManager().getRootId()) {
      const closeButton = document.createElement('button');
      closeButton.className = 'button button-secondary';
      closeButton.textContent = 'Close This Panel';
      closeButton.addEventListener('click', () => this.handleClosePanel(panelId));
      buttonContainer.appendChild(closeButton);
    }

    // Add info text
    const info = document.createElement('p');
    info.style.marginTop = '20px';
    info.style.color = 'var(--color-text-secondary)';
    info.textContent = `Panel ID: ${panelId}`;
    buttonContainer.appendChild(info);

    content.appendChild(buttonContainer);

    // Add collapse/expand button to header
    panel.addActionButton('Toggle Collapse', () => {
      this.stateManager.toggleCollapse(panelId);
    });
  }

  /**
   * Handle tab click
   */
  private handleTabClick(tab: TabData): void {
    const node = this.stateManager.getTreeManager().getNode(tab.id);
    if (!node) return;

    const state = this.stateManager.getState();

    // Path tabs correspond to collapsed panels in the active path
    if (tab.kind === 'path' && state.activePath.includes(tab.id)) {
      this.stateManager.navigateToPanel(tab.id);
      return;
    }

    if (tab.kind === 'sibling' && tab.parentId) {
      this.stateManager.selectTab(tab.parentId, tab.id);
      return;
    }

    // Fallback: just focus the panel
    this.stateManager.focusPanel(tab.id);
  }

  /**
   * Handle launch child
   */
  private handleLaunchChild(parentId: PanelId): void {
    const parent = this.stateManager.getTreeManager().getNode(parentId);
    if (!parent) return;

    // Generate child name
    const childCount = parent.children.length;
    const childName = `${parent.title} > Child ${childCount + 1}`;

    // Launch the child
    const childId = this.stateManager.launchChild(parentId, childName);

    if (childId) {
      console.log(`Launched child panel: ${childId}`);
    }
  }

  /**
   * Handle close panel
   */
  private handleClosePanel(panelId: PanelId): void {
    // Remove panel from DOM
    const panel = this.panels.get(panelId);
    if (panel) {
      panel.remove();
      this.panels.delete(panelId);
    }

    // Close in state manager
    this.stateManager.closePanel(panelId);
  }

  /**
   * Set maximum visible panels
   */
  setMaxVisiblePanels(max: number): void {
    this.stateManager.setMaxVisiblePanels(max);
  }

  /**
   * Get the state manager (for debugging)
   */
  getStateManager(): PanelStateManager {
    return this.stateManager;
  }

  /**
   * Get current state (for debugging)
   */
  getState(): Readonly<PanelState> {
    return this.stateManager.getState();
  }
}
