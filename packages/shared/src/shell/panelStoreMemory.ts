import type { Panel, PanelSummary } from "../types.js";
import type { PanelStore, PanelStoreCreateInput, PanelStoreUpdateInput } from "./panelStore.js";

interface StoredPanelRecord {
  panel: Panel;
  parentId: string | null;
  position: number;
  collapsed: boolean;
  archived: boolean;
}

export class PanelStoreMemory implements PanelStore {
  private readonly panels = new Map<string, StoredPanelRecord>();

  createPanel(input: PanelStoreCreateInput): void {
    for (const sibling of this.getSiblingRecords(input.parentId)) {
      sibling.position += 1;
    }

    this.panels.set(input.id, {
      panel: {
        id: input.id,
        title: input.title,
        children: [],
        selectedChildId: null,
        snapshot: input.snapshot,
        artifacts: {},
      },
      parentId: input.parentId,
      position: 0,
      collapsed: false,
      archived: false,
    });
  }

  getPanel(panelId: string): Panel | null {
    const record = this.panels.get(panelId);
    if (!record || record.archived) return null;
    return this.clonePanel(record.panel);
  }

  getParentId(panelId: string): string | null {
    return this.panels.get(panelId)?.parentId ?? null;
  }

  getChildren(parentId: string): PanelSummary[] {
    return this.getSiblingRecords(parentId)
      .map((record) => ({
        id: record.panel.id,
        title: record.panel.title,
        childCount: this.getSiblingRecords(record.panel.id).length,
        position: record.position,
      }));
  }

  updatePanel(panelId: string, input: PanelStoreUpdateInput): void {
    const record = this.requireRecord(panelId);
    if (input.selectedChildId !== undefined) {
      record.panel.selectedChildId = input.selectedChildId;
    }
    if (input.snapshot !== undefined) {
      record.panel.snapshot = input.snapshot;
    }
    if (input.parentId !== undefined) {
      record.parentId = input.parentId;
    }
  }

  setSelectedChild(panelId: string, childId: string | null): void {
    this.requireRecord(panelId).panel.selectedChildId = childId;
  }

  updateSelectedPath(focusedPanelId: string): void {
    const visited = new Set<string>();
    let currentId: string | null = focusedPanelId;

    while (currentId) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const parentId = this.getParentId(currentId);
      if (!parentId) break;
      const parent = this.requireRecord(parentId);
      parent.panel.selectedChildId = currentId;
      currentId = parentId;
    }
  }

  setTitle(panelId: string, title: string): void {
    this.requireRecord(panelId).panel.title = title;
  }

  movePanel(panelId: string, newParentId: string | null, targetPosition: number): void {
    const record = this.requireRecord(panelId);
    const oldParentId = record.parentId;
    const oldSiblings = this.getSiblingRecords(oldParentId).filter((sibling) => sibling.panel.id !== panelId);
    oldSiblings.forEach((sibling, index) => {
      sibling.position = index;
    });

    record.parentId = newParentId;
    const newSiblings = this.getSiblingRecords(newParentId).filter((sibling) => sibling.panel.id !== panelId);
    const clampedPosition = Math.max(0, Math.min(targetPosition, newSiblings.length));
    newSiblings.splice(clampedPosition, 0, record);
    newSiblings.forEach((sibling, index) => {
      sibling.position = index;
    });
  }

  getFullTree(): Panel[] {
    const activeRecords = [...this.panels.values()]
      .filter((record) => !record.archived)
      .sort((a, b) => a.position - b.position);
    const panelMap = new Map<string, Panel>();

    for (const record of activeRecords) {
      panelMap.set(record.panel.id, this.clonePanel(record.panel));
    }

    const roots: Panel[] = [];
    for (const record of activeRecords) {
      const panel = panelMap.get(record.panel.id)!;
      if (record.parentId) {
        panelMap.get(record.parentId)?.children.push(panel);
      } else {
        roots.push(panel);
      }
    }
    return roots;
  }

  getCollapsedIds(): string[] {
    return [...this.panels.values()]
      .filter((record) => record.collapsed && !record.archived)
      .map((record) => record.panel.id);
  }

  setCollapsed(panelId: string, collapsed: boolean): void {
    this.requireRecord(panelId).collapsed = collapsed;
  }

  setCollapsedBatch(panelIds: string[], collapsed: boolean): void {
    for (const panelId of panelIds) {
      this.setCollapsed(panelId, collapsed);
    }
  }

  archivePanel(panelId: string): void {
    const record = this.requireRecord(panelId);
    record.archived = true;
  }

  isArchived(panelId: string): boolean {
    return this.panels.get(panelId)?.archived ?? false;
  }

  private requireRecord(panelId: string): StoredPanelRecord {
    const record = this.panels.get(panelId);
    if (!record) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    return record;
  }

  private getSiblingRecords(parentId: string | null): StoredPanelRecord[] {
    return [...this.panels.values()]
      .filter((record) => record.parentId === parentId && !record.archived)
      .sort((a, b) => a.position - b.position);
  }

  private clonePanel(panel: Panel): Panel {
    return {
      ...panel,
      snapshot: {
        ...panel.snapshot,
        options: { ...panel.snapshot.options },
        stateArgs: panel.snapshot.stateArgs ? { ...panel.snapshot.stateArgs } : panel.snapshot.stateArgs,
      },
      artifacts: { ...panel.artifacts },
      children: panel.children.map((child) => this.clonePanel(child)),
    };
  }
}
