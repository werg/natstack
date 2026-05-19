/**
 * Node-side hot cache for WorkspaceDO active-entity reads.
 *
 * WorkspaceDO is the source of truth, but synchronous reads happen on every
 * RPC call (policy check, source/context resolution). The cache
 * is updated by `runtimeService` after each successful `entityActivate` /
 * `entityRetire`. On boot, `hydrate()` loads the initial set from
 * `entityListActive()`.
 *
 * Reads are synchronous and never trigger a DO dispatch. Writes are internal:
 * only `runtimeService` (and tests) call the `_*` methods.
 *
 * Replaces the old PrincipalRegistry, which conflated identity ownership
 * with the cache layer. Here, this object only mirrors; it has no
 * authority over identity.
 */

import type { EntityKind, EntityRecord, EntitySource } from "./entitySpec.js";

export type EntityChangeKind = "activate" | "retire" | "delete";

export class EntityCache {
  private readonly records = new Map<string, EntityRecord>();
  private readonly listeners = new Set<(id: string, change: EntityChangeKind) => void>();

  hydrate(records: EntityRecord[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  /** Internal: called by runtimeService after WorkspaceDO commits an activate. */
  _onActivate(record: EntityRecord): void {
    this.records.set(record.id, record);
    this.emit(record.id, "activate");
  }

  /** Internal: called after entity is retired (kept in cache as 'retired' for grace window). */
  _onRetire(record: EntityRecord): void {
    this.records.set(record.id, record);
    this.emit(record.id, "retire");
  }

  /** Internal: called after entityGc hard-deletes a row. */
  _onDelete(id: string): void {
    if (this.records.delete(id)) {
      this.emit(id, "delete");
    }
  }

  resolve(id: string): EntityRecord | null {
    return this.records.get(id) ?? null;
  }

  resolveActive(id: string): EntityRecord | null {
    const record = this.records.get(id);
    if (!record || record.status !== "active") return null;
    return record;
  }

  resolveContext(id: string): string | null {
    return this.resolveActive(id)?.contextId ?? null;
  }

  resolveSource(id: string): EntitySource | null {
    const record = this.resolveActive(id);
    return record ? record.source : null;
  }

  resolveKind(id: string): EntityKind | null {
    return this.resolveActive(id)?.kind ?? null;
  }

  listActive(): EntityRecord[] {
    return Array.from(this.records.values()).filter((r) => r.status === "active");
  }

  /** Bootstrap entries that don't have a WorkspaceDO row (server, shell). */
  registerBootstrap(record: {
    id: string;
    kind: "server" | "shell";
    source?: EntitySource;
    contextId?: string;
  }): void {
    const entry: EntityRecord = {
      id: record.id,
      kind: record.kind,
      source: record.source ?? { repoPath: "", effectiveVersion: "" },
      contextId: record.contextId ?? "",
      key: record.id,
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    this.records.set(record.id, entry);
    this.emit(record.id, "activate");
  }

  onChange(listener: (id: string, change: EntityChangeKind) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Clear the cache. Tests only. */
  _clear(): void {
    this.records.clear();
  }

  private emit(id: string, change: EntityChangeKind): void {
    for (const listener of this.listeners) listener(id, change);
  }
}
