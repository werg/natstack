import * as Keychain from "react-native-keychain";
import type { Panel, PanelSummary } from "@natstack/shared/types";
import type { PanelStore, PanelStoreCreateInput, PanelStoreUpdateInput } from "@natstack/shared/shell/panelStore";

interface StoredPanelRecord {
  panel: Panel;
  parentId: string | null;
  position: number;
  collapsed: boolean;
  archived: boolean;
}

interface PersistedState {
  records: Record<string, StoredPanelRecord>;
}

export class PanelStoreAsync implements PanelStore {
  private readonly serviceName: string;
  private loaded = false;
  private records = new Map<string, StoredPanelRecord>();

  constructor(workspaceId: string) {
    this.serviceName = `com.natstack.mobile.panels.${workspaceId}`;
  }

  async createPanel(input: PanelStoreCreateInput): Promise<void> {
    await this.ensureLoaded();
    for (const sibling of this.getSiblingRecords(input.parentId)) {
      sibling.position += 1;
    }
    this.records.set(input.id, {
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
    await this.persist();
  }

  async getPanel(panelId: string): Promise<Panel | null> {
    await this.ensureLoaded();
    const record = this.records.get(panelId);
    if (!record || record.archived) return null;
    return this.clonePanel(record.panel);
  }

  async getParentId(panelId: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.records.get(panelId)?.parentId ?? null;
  }

  async getChildren(parentId: string): Promise<PanelSummary[]> {
    await this.ensureLoaded();
    return this.getSiblingRecords(parentId).map((record) => ({
      id: record.panel.id,
      title: record.panel.title,
      childCount: this.getSiblingRecords(record.panel.id).length,
      position: record.position,
    }));
  }

  async updatePanel(panelId: string, input: PanelStoreUpdateInput): Promise<void> {
    await this.ensureLoaded();
    const record = this.requireRecord(panelId);
    if (input.selectedChildId !== undefined) record.panel.selectedChildId = input.selectedChildId;
    if (input.snapshot !== undefined) record.panel.snapshot = input.snapshot;
    if (input.parentId !== undefined) record.parentId = input.parentId;
    await this.persist();
  }

  async setSelectedChild(panelId: string, childId: string | null): Promise<void> {
    await this.ensureLoaded();
    this.requireRecord(panelId).panel.selectedChildId = childId;
    await this.persist();
  }

  async updateSelectedPath(focusedPanelId: string): Promise<void> {
    await this.ensureLoaded();
    const visited = new Set<string>();
    let currentId: string | null = focusedPanelId;

    while (currentId) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const parentId = this.records.get(currentId)?.parentId ?? null;
      if (!parentId) break;
      this.requireRecord(parentId).panel.selectedChildId = currentId;
      currentId = parentId;
    }
    await this.persist();
  }

  async setTitle(panelId: string, title: string): Promise<void> {
    await this.ensureLoaded();
    this.requireRecord(panelId).panel.title = title;
    await this.persist();
  }

  async movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    await this.ensureLoaded();
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
    await this.persist();
  }

  async getFullTree(): Promise<Panel[]> {
    await this.ensureLoaded();
    const activeRecords = [...this.records.values()]
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

  async getCollapsedIds(): Promise<string[]> {
    await this.ensureLoaded();
    return [...this.records.values()]
      .filter((record) => record.collapsed && !record.archived)
      .map((record) => record.panel.id);
  }

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.ensureLoaded();
    this.requireRecord(panelId).collapsed = collapsed;
    await this.persist();
  }

  async setCollapsedBatch(panelIds: string[], collapsed: boolean): Promise<void> {
    await this.ensureLoaded();
    for (const panelId of panelIds) {
      this.requireRecord(panelId).collapsed = collapsed;
    }
    await this.persist();
  }

  async archivePanel(panelId: string): Promise<void> {
    await this.ensureLoaded();
    this.requireRecord(panelId).archived = true;
    await this.persist();
  }

  async isArchived(panelId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.records.get(panelId)?.archived ?? false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const result = await Keychain.getGenericPassword({ service: this.serviceName });
    if (!result) return;
    try {
      const parsed = JSON.parse(result.password) as PersistedState;
      this.records = new Map(Object.entries(parsed.records ?? {}));
    } catch {
      this.records = new Map();
    }
  }

  private async persist(): Promise<void> {
    const data: PersistedState = {
      records: Object.fromEntries(this.records.entries()),
    };
    await Keychain.setGenericPassword("_", JSON.stringify(data), {
      service: this.serviceName,
    });
  }

  private requireRecord(panelId: string): StoredPanelRecord {
    const record = this.records.get(panelId);
    if (!record) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    return record;
  }

  private getSiblingRecords(parentId: string | null): StoredPanelRecord[] {
    return [...this.records.values()]
      .filter((record) => record.parentId === parentId && !record.archived)
      .sort((a, b) => a.position - b.position);
  }

  private clonePanel(panel: Panel): Panel {
    return JSON.parse(JSON.stringify(panel)) as Panel;
  }
}
