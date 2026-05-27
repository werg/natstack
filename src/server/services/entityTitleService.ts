/**
 * Server-controlled display titles for runtime entities (panels, workers, DOs).
 *
 * Architecture: titles live on the `entities.display_title` column in the
 * WorkspaceDO — alongside the rest of the entity's identity. This module is
 * a thin server-side adapter: it owns an in-memory cache for synchronous
 * lookups on the hot path (e.g. building a `PendingApproval`) and writes
 * through to the DO on every change.
 *
 * Population:
 * - Panels: `workspace-state.panel.index` and `panel.updateTitle` route
 *   through the WorkspaceDO, which writes both `entities.display_title`
 *   (canonical) and `panel_search_metadata.searchable_title` (FTS
 *   denormalization) in one transaction. The service is notified via
 *   `mirrorCachedTitle` so the cache stays consistent with the DO.
 * - Workers / DOs: the runtime service exposes `runtime.setTitle(title)`
 *   which calls `setTitle` here. We dispatch the write to the DO and
 *   update the cache eagerly.
 */

import type { DODispatch, DORef } from "../doDispatch.js";

export type { DODispatch, DORef };

export type EntityTitleChangeOrigin = "set" | "mirror" | "clear";

export interface EntityTitleService {
  /** Authoritative write: dispatches to WorkspaceDO and refreshes the cache. */
  setTitle(entityId: string, title: string | undefined | null): Promise<void>;
  /** Synchronous read against the in-memory cache. */
  getTitle(entityId: string): string | undefined;
  /**
   * Local cache refresh for writes that already landed in the DO via another
   * path (e.g. `workspace-state.panel.updateTitle`). Does NOT re-dispatch.
   */
  mirrorCachedTitle(entityId: string, title: string | undefined | null): void;
  /** Subscribe to cache changes (used to refresh in-flight approvals). */
  onChanged(
    listener: (entityId: string, title: string | undefined, origin: EntityTitleChangeOrigin) => void
  ): () => void;
  /** Drop a title — called when an entity retires. Writes through to the DO. */
  clear(entityId: string): Promise<void>;
  /**
   * Hydrate the cache from the WorkspaceDO. Idempotent; safe to call at
   * boot and after a workspace switch.
   */
  hydrate(): Promise<void>;
}

const MAX_TITLE_LENGTH = 120;

function sanitizeTitle(input: string | undefined | null): string | undefined {
  if (input === undefined || input === null) return undefined;
  // Strip C0/C1 control bytes by codepoint and collapse whitespace.
  const cleaned = input
    .split("")
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_TITLE_LENGTH ? cleaned.slice(0, MAX_TITLE_LENGTH) : cleaned;
}

export interface EntityTitleServiceOptions {
  /**
   * Lazy resolver for the workspace dispatcher. `doDispatch` is registered
   * deep in the bootstrap sequence (after workerd is up), but consumers of
   * the title cache exist much earlier. The resolver pattern lets us share
   * a single instance whose getter-side reads are immediately useful and
   * whose setter-side writes start landing in the DO once dispatch comes
   * online.
   */
  getDoDispatch: () => DODispatch | null | undefined;
  workspaceRef: DORef;
}

export function createEntityTitleService(options: EntityTitleServiceOptions): EntityTitleService {
  const { getDoDispatch, workspaceRef } = options;
  const titles = new Map<string, string>();
  const listeners = new Set<
    (entityId: string, title: string | undefined, origin: EntityTitleChangeOrigin) => void
  >();

  function notify(
    entityId: string,
    title: string | undefined,
    origin: EntityTitleChangeOrigin
  ): void {
    for (const listener of listeners) {
      try {
        listener(entityId, title, origin);
      } catch (error) {
        console.warn("[entityTitleService] listener failed:", error);
      }
    }
  }

  function applyToCache(
    entityId: string,
    title: string | undefined,
    origin: EntityTitleChangeOrigin
  ): boolean {
    const prev = titles.get(entityId);
    if (title === prev) return false;
    if (title === undefined) {
      titles.delete(entityId);
    } else {
      titles.set(entityId, title);
    }
    notify(entityId, title, origin);
    return true;
  }

  async function writeThrough(entityId: string, title: string | null): Promise<void> {
    const dispatch = getDoDispatch();
    if (!dispatch) {
      // Bootstrap hasn't wired the workspace dispatcher yet. The cache is
      // still updated by the caller, so an early-boot setter just delays
      // persistence — a subsequent setter for the same entity will land in
      // the DO once dispatch is online.
      return;
    }
    try {
      await dispatch.dispatch(workspaceRef, "entitySetDisplayTitle", entityId, title);
    } catch (error) {
      console.warn("[entityTitleService] DO write failed:", error);
    }
  }

  return {
    async setTitle(entityId, title) {
      const next = sanitizeTitle(title);
      applyToCache(entityId, next, "set");
      await writeThrough(entityId, next ?? null);
    },

    getTitle(entityId) {
      return titles.get(entityId);
    },

    mirrorCachedTitle(entityId, title) {
      const next = sanitizeTitle(title);
      applyToCache(entityId, next, "mirror");
    },

    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async clear(entityId) {
      if (titles.delete(entityId)) {
        notify(entityId, undefined, "clear");
      }
      await writeThrough(entityId, null);
    },

    async hydrate() {
      const dispatch = getDoDispatch();
      if (!dispatch) return;
      try {
        const rows = (await dispatch.dispatch(workspaceRef, "entityListDisplayTitles")) as
          | Array<{ id: string; title: string }>
          | undefined;
        if (!Array.isArray(rows)) return;
        for (const row of rows) {
          if (
            row &&
            typeof row.id === "string" &&
            typeof row.title === "string" &&
            row.title.length > 0
          ) {
            // Don't notify on hydrate — listeners haven't been wired yet
            // when this runs at boot, and even if they were, this isn't a
            // semantic change. Just seed the cache.
            titles.set(row.id, row.title);
          }
        }
      } catch (error) {
        console.warn("[entityTitleService] hydrate failed:", error);
      }
    },
  };
}
