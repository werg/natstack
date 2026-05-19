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

export interface SlotHistoryEntryInput {
  entryKey: string;
  entityId: string;
  source: string;
  contextId: string;
  stateArgs?: unknown;
}

export interface SlotCreateInput {
  slotId: string;
  parentSlotId: string | null;
  positionId: string;
  initialEntry?: SlotHistoryEntryInput;
}

export interface SlotRow {
  slot_id: string;
  parent_slot_id: string | null;
  current_entity_id: string | null;
  current_entry_key: string | null;
  position_id: string;
  created_at: number;
  closed_at: number | null;
}

export interface SlotHistoryRow {
  slot_id: string;
  cursor: number;
  entry_key: string;
  entity_id: string;
  source: string;
  context_id: string;
  state_args: string | null;
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
  getSlot(slotId: string): Promise<SlotRow | null>;
  getSlotHistory(slotId: string): Promise<SlotHistoryRow[]>;
  resolveActiveEntity(id: string): Promise<EntityRecord | null>;

  createSlot(input: SlotCreateInput): Promise<void>;
  appendSlotHistory(slotId: string, entry: SlotHistoryEntryInput): Promise<number>;
  setSlotCurrent(slotId: string, entryKey: string): Promise<void>;
  updateCurrentStateArgs(slotId: string, stateArgs: unknown): Promise<void>;
  replaceSlotHistory(
    slotId: string,
    entries: SlotHistoryEntryInput[],
    cursor: number
  ): Promise<void>;
  setSlotParent(slotId: string, parentSlotId: string | null): Promise<void>;
  setSlotPosition(slotId: string, positionId: string): Promise<void>;
  moveSlot(
    slotId: string,
    parentSlotId: string | null,
    positionId: string,
  ): Promise<void>;
  closeSlot(slotId: string): Promise<void>;
}

/**
 * Client surface mirroring the `runtime` server service. Used by panelManager
 * (and any other code that creates panels/workers/DOs) to mint entities.
 */
export interface RuntimeClient {
  createEntity(spec: RuntimeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  retireEntity(id: string): Promise<void>;
}
