/**
 * Shell-facing client surfaces for the server-side `workspace-state` and
 * `runtime` services.
 *
 * These describe what the shell (Electron main / mobile main) sends over RPC.
 * They are pure type contracts — the concrete RPC client is wired separately
 * by each shell. `panelManager` consumes these via dependency injection.
 */

import type {
  EntityRecord,
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "../runtime/entitySpec.js";
import type { PanelEntityId, PanelSlotId } from "../panel/ids.js";

export interface SlotHistoryEntryInput {
  entryKey: string;
  entityId: PanelEntityId;
  source: string;
  contextId: string;
  stateArgs?: unknown;
  /** Per-entry navigation options (env/ref), persisted so any client reconstructs them. */
  options?: unknown;
}

export interface SlotCreateInput {
  slotId: PanelSlotId;
  parentSlotId: PanelSlotId | null;
  positionId: string;
  initialEntry?: SlotHistoryEntryInput;
}

export interface SlotRow {
  slot_id: PanelSlotId;
  parent_slot_id: PanelSlotId | null;
  current_entity_id: PanelEntityId | null;
  current_entity_title?: string | null;
  current_entry_key: string | null;
  position_id: string;
  created_at: number;
  closed_at: number | null;
}

export interface SlotHistoryRow {
  slot_id: PanelSlotId;
  cursor: number;
  entry_key: string;
  entity_id: PanelEntityId;
  source: string;
  context_id: string;
  state_args: string | null;
  options?: string | null;
  recorded_at: number;
}

/**
 * Client surface mirroring the `workspace-state` server service.
 * Read methods (slot list/get/history, entity.resolveActive) are available to
 * any kind; write methods (everything starting with `slot` other than reads)
 * are only routable from shell/server callers.
 */
export interface WorkspaceStateClient {
  listSlots(): Promise<SlotRow[]>;
  getSlot(slotId: PanelSlotId): Promise<SlotRow | null>;
  getSlotHistory(slotId: PanelSlotId): Promise<SlotHistoryRow[]>;
  resolveActiveEntity(id: string): Promise<EntityRecord | null>;
  /**
   * Durable nav→slot: the OPEN slot id whose current runtime entity is `entityId`, or null.
   * Returns a raw string; callers brand it via `asPanelSlotId` (validated) at the use site.
   */
  resolveSlotByEntity(entityId: string): Promise<string | null>;

  createSlot(input: SlotCreateInput): Promise<void>;
  appendSlotHistory(slotId: PanelSlotId, entry: SlotHistoryEntryInput): Promise<number>;
  setSlotCurrent(slotId: PanelSlotId, entryKey: string): Promise<void>;
  updateCurrentStateArgs(slotId: PanelSlotId, stateArgs: unknown): Promise<void>;
  replaceSlotHistory(
    slotId: PanelSlotId,
    entries: SlotHistoryEntryInput[],
    cursor: number
  ): Promise<void>;
  setSlotParent(slotId: PanelSlotId, parentSlotId: PanelSlotId | null): Promise<void>;
  setSlotPosition(slotId: PanelSlotId, positionId: string): Promise<void>;
  moveSlot(
    slotId: PanelSlotId,
    parentSlotId: PanelSlotId | null,
    positionId: string
  ): Promise<void>;
  closeSlot(slotId: PanelSlotId): Promise<void>;
}

/**
 * Client surface mirroring the `runtime` server service. Used by panelManager
 * (and any other code that creates panels/workers/DOs) to mint entities.
 */
export interface RuntimeClient {
  createEntity(spec: RuntimeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  retireEntity(id: string): Promise<void>;
}
