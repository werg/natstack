/**
 * View-state sidecar — private, per-viewer component state, kept OUT of the
 * co-edited canonical document (plan section E).
 *
 * `useDocState(key, initial)` (sliders, toggles, embedded-component state) used
 * to round-trip through the doc's `state:` frontmatter. That made every slider
 * nudge a canonical-byte change → a co-edit hunk → merge noise, and (worse) let
 * an agent's view of the doc churn on private UI fiddling. Here it lives in a
 * **panel-local store**, keyed by the document's vcs path, scoped to the vault
 * by the panel's storage partition (the panel runs under `ctx:vault-<hash>`).
 * It is therefore private per viewer, never written into the worktree, and so
 * never produces a commit. Canonical bytes stay pure prose.
 *
 * Backend is injectable so it is unit-testable without `localStorage`.
 */

import { parseFrontmatter, replaceFrontmatterState } from "../mdx/frontmatter.js";

export interface ViewStateBackend {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

const KEY_PREFIX = "spectrolite:viewstate:";

export class ViewStateStore {
  private readonly cache = new Map<string, Record<string, unknown>>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly backend: ViewStateBackend) {}

  private storageKey(path: string): string {
    return `${KEY_PREFIX}${path}`;
  }

  /** The full view-state map for a doc (empty if none). */
  state(path: string): Record<string, unknown> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    let parsed: Record<string, unknown> = {};
    const raw = this.backend.read(this.storageKey(path));
    if (raw) {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        // Corrupt entry → treat as empty (private state, safe to drop).
      }
    }
    this.cache.set(path, parsed);
    return parsed;
  }

  get<T>(path: string, key: string, initial: T): T {
    const state = this.state(path);
    return (key in state ? state[key] : initial) as T;
  }

  set(path: string, key: string, value: unknown): void {
    const next = { ...this.state(path), [key]: value };
    this.cache.set(path, next);
    this.persist(path, next);
    this.notify(path);
  }

  /** Seed migrated/legacy state — only when nothing is stored yet, so a real
   *  edit never gets clobbered by a stale frontmatter migration. */
  seedIfAbsent(path: string, state: Record<string, unknown>): boolean {
    if (this.backend.read(this.storageKey(path)) !== null) return false;
    if (!state || Object.keys(state).length === 0) return false;
    const seeded = { ...state };
    this.cache.set(path, seeded);
    this.persist(path, seeded);
    this.notify(path);
    return true;
  }

  /** Follow the doc on rename (the sidecar is keyed by path). */
  rename(oldPath: string, newPath: string): void {
    const state = this.state(oldPath);
    this.clear(oldPath);
    if (Object.keys(state).length > 0) {
      this.cache.set(newPath, { ...state });
      this.persist(newPath, state);
      this.notify(newPath);
    }
  }

  /** Clean up with the doc on delete (the private view-state sidecar). */
  clear(path: string): void {
    this.cache.delete(path);
    this.backend.remove(this.storageKey(path));
    this.notify(path);
  }

  subscribe(path: string, listener: () => void): () => void {
    let set = this.listeners.get(path);
    if (!set) {
      set = new Set();
      this.listeners.set(path, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private persist(path: string, state: Record<string, unknown>): void {
    try {
      this.backend.write(this.storageKey(path), JSON.stringify(state));
    } catch {
      // Storage full / unavailable — view-state is best-effort, never fatal.
    }
  }

  private notify(path: string): void {
    this.listeners.get(path)?.forEach((listener) => listener());
  }
}

/** A `localStorage`-backed view-state store (the panel partition is per-vault). */
export function createViewStateStore(
  backend: ViewStateBackend = localStorageBackend()
): ViewStateStore {
  return new ViewStateStore(backend);
}

export function localStorageBackend(): ViewStateBackend {
  return {
    read: (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // ignore
      }
    },
    remove: (key) => {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

/**
 * One-time migration: lift any legacy `state:` frontmatter out of a document
 * into the sidecar and strip it from the canonical bytes. Returns the parsed
 * view-state (or null) plus the canonical markdown with `state:` removed. The
 * DocController seeds the sidecar (seedIfAbsent) and, when `canonical` differs,
 * records the strip as a working `vcs.edit` once so the co-edited doc is pure
 * prose thereafter.
 */
export function liftLegacyViewState(markdown: string): {
  viewState: Record<string, unknown> | null;
  canonical: string;
  migrated: boolean;
} {
  const { state } = parseFrontmatter(markdown);
  if (!state || Object.keys(state).length === 0) {
    return { viewState: null, canonical: markdown, migrated: false };
  }
  const canonical = replaceFrontmatterState(markdown, {});
  return { viewState: state, canonical, migrated: canonical !== markdown };
}
