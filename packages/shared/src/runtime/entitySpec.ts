/**
 * Unified runtime-entity model. Replaces the old PrincipalRegistry record shape.
 *
 * Every runtime principal (panel, app, worker, DO, shell, server) has the same identity
 * shape: { source, contextId, key } (+ className for DOs). Identity columns are
 * write-once; lifecycle (status, retiredAt, cleanupComplete, error) is mutable.
 */

export type EntityKind = "panel" | "app" | "worker" | "do" | "shell" | "server";

export interface EntitySource {
  repoPath: string;
  effectiveVersion: string;
}

export type EntityStatus = "active" | "retired";

export interface EntityRecord {
  // ── Identity (immutable after first write) ──
  id: string;
  kind: EntityKind;
  source: EntitySource;
  contextId: string;
  className?: string;
  key: string;
  stateArgs?: unknown;
  createdAt: number;

  // ── Lifecycle (mutable) ──
  status: EntityStatus;
  retiredAt?: number;
  cleanupComplete: boolean;
  error?: string;
}

export type RuntimeEntityCreateSpec =
  | {
      kind: "panel";
      source: string;
      ref?: string;
      contextId?: string | null;
      key?: string;
      stateArgs?: unknown;
    }
  | {
      kind: "app";
      source: string;
      ref?: string;
      contextId?: string | null;
      key?: string;
      stateArgs?: unknown;
    }
  | {
      kind: "worker";
      source: string;
      ref?: string;
      contextId?: string | null;
      key?: string;
      stateArgs?: unknown;
      env?: Record<string, string>;
    }
  | {
      kind: "do";
      source: string;
      ref?: string;
      className: string;
      key?: string;
      contextId?: string | null;
    };

export interface RuntimeEntityHandle {
  id: string;
  kind: "panel" | "app" | "worker" | "do";
  source: EntitySource;
  contextId: string;
  targetId: string;
}

/**
 * Build canonical entity id from identity components.
 * - panel: `panel:<key>` (key is historyEntryKey)
 * - app: `app:<source>:<key>`
 * - worker: `worker:<source>:<key>`
 * - do: `do:<source>:<className>:<key>`
 */
export function canonicalEntityId(args: {
  kind: EntityKind;
  source?: string;
  className?: string;
  key: string;
}): string {
  switch (args.kind) {
    case "panel":
      return `panel:${args.key}`;
    case "app":
      if (!args.source) throw new Error("app entity requires source");
      return `app:${args.source}:${args.key}`;
    case "worker":
      if (!args.source) throw new Error("worker entity requires source");
      return `worker:${args.source}:${args.key}`;
    case "do":
      if (!args.source) throw new Error("do entity requires source");
      if (!args.className) throw new Error("do entity requires className");
      return `do:${args.source}:${args.className}:${args.key}`;
    case "shell":
      return `shell:${args.key}`;
    case "server":
      return `server:${args.key}`;
  }
}

export class IdentityCollisionError extends Error {
  readonly code = "IDENTITY_COLLISION" as const;
  constructor(
    readonly id: string,
    readonly conflict: { field: string; existing: unknown; attempted: unknown },
  ) {
    super(
      `Identity collision on ${id}: ${conflict.field} existing=${JSON.stringify(
        conflict.existing,
      )} attempted=${JSON.stringify(conflict.attempted)}`,
    );
  }
}

export class EntityNotCreatedError extends Error {
  readonly code = "DO_NOT_CREATED" as const;
  constructor(readonly id: string) {
    super(
      `Entity ${id} is not registered as an active runtime entity. Call runtime.createEntity first.`,
    );
  }
}
