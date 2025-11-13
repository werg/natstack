import type { PanelId, TabKind } from '../types/panel.types';

export type TabStripPosition = 'top' | 'bottom' | 'vertical';

export interface TabData {
  id: PanelId;
  title: string;
  active?: boolean;
  kind?: TabKind;
  parentId?: PanelId | null;
}

export class TabStrip extends HTMLElement {
  private position: TabStripPosition;
  private tabs: Map<PanelId, { element: HTMLElement; data: TabData }> =
    new Map();
  private onTabClick?: (data: TabData) => void;

  constructor(position: TabStripPosition = 'top') {
    super();
    this.position = position;

    this.className = `tabstrip-container tabstrip-${position}`;
  }

  setOnTabClick(handler: (data: TabData) => void): void {
    this.onTabClick = handler;
  }

  addTab(data: TabData): void {
    const tab = this.createTab(data);
    this.tabs.set(data.id, { element: tab, data });
    this.appendChild(tab);
  }

  removeTab(panelId: PanelId): void {
    const entry = this.tabs.get(panelId);
    if (entry) {
      entry.element.remove();
      this.tabs.delete(panelId);
    }
  }

  setActiveTab(panelId: PanelId): void {
    this.tabs.forEach(({ element, data }) => {
      element.classList.remove('active');
      data.active = false;
    });

    const activeTab = this.tabs.get(panelId);
    if (activeTab) {
      activeTab.element.classList.add('active');
      activeTab.data.active = true;
    }
  }

  updateTabTitle(panelId: PanelId, title: string): void {
    const entry = this.tabs.get(panelId);
    if (entry) {
      entry.element.textContent = title;
      entry.element.title = title;
      entry.data.title = title;
    }
  }

  clearTabs(): void {
    this.tabs.forEach(({ element }) => element.remove());
    this.tabs.clear();
  }

  getTabIds(): PanelId[] {
    return Array.from(this.tabs.keys());
  }

  hasTab(panelId: PanelId): boolean {
    return this.tabs.has(panelId);
  }

  getTabCount(): number {
    return this.tabs.size;
  }

  show(): void {
    this.style.display = 'flex';
  }

  hide(): void {
    this.style.display = 'none';
  }

  setPosition(position: TabStripPosition): void {
    this.classList.remove(`tabstrip-${this.position}`);
    this.position = position;
    this.classList.add(`tabstrip-${position}`);

    this.tabs.forEach(({ element }) => {
      if (position === 'vertical') {
        element.classList.add('tab-vertical');
      } else {
        element.classList.remove('tab-vertical');
      }
    });
  }

  private createTab(data: TabData): HTMLElement {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.dataset['tabId'] = data.id;

    if (data.kind) {
      tab.dataset['tabKind'] = data.kind;
      tab.classList.add(`tab-${data.kind}`);
    }

    tab.textContent = data.title;
    tab.title = data.title;

    if (this.position === 'vertical') {
      tab.classList.add('tab-vertical');
    }

    if (data.active) {
      tab.classList.add('active');
    }

    tab.addEventListener('click', () => {
      if (this.onTabClick) {
        this.onTabClick({ ...data });
      }
    });

    return tab;
  }
}

customElements.define('app-tabstrip', TabStrip);
