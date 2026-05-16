import { randomBytes, timingSafeEqual } from "crypto";
import type { CallerKind } from "./serviceDispatcher.js";

export type EphemeralConnectionId = string & { readonly __ephemeralConnectionId: unique symbol };

export function ephemeralConnectionId(value: string): EphemeralConnectionId {
  return value as EphemeralConnectionId;
}

export interface PersistedPanelTokenRecord {
  panelId: string;
  token: string;
  callerKind: "panel";
  parentId?: string | null;
  ownerCallerId?: string;
}

export interface PanelTokenRecord extends PersistedPanelTokenRecord {
  ownerConnectionId?: EphemeralConnectionId;
}

/**
 * Constant-time string comparison.
 *
 * Compare two strings without leaking length-or-value information through
 * timing side-channels. Uses Node's `crypto.timingSafeEqual` once the inputs
 * have been encoded to equal-length buffers. A length mismatch returns false
 * directly — `timingSafeEqual` itself throws on length mismatch, and the
 * length of an admin token is not itself a secret in this codebase (all
 * admin tokens are 64-char hex), so the early-out does not leak.
 *
 * Use this for every admin-token / management-token / bearer-token compare
 * where the right-hand operand is server-side state. Plain `===` /
 * `!==` is forbidden for such compares (audit finding #33).
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Global token manager for panel/worker/shell authentication.
 * Provides unified token management for all services (Git, CDP, etc.)
 *
 * Each caller ID gets one token. Services can use this manager
 * to authenticate requests from panels/workers/shell.
 */
export class TokenManager {
  // token -> { callerId, callerKind }
  private tokenToEntry = new Map<
    string,
    { callerId: string; callerKind: CallerKind }
  >();
  // callerId -> token
  private callerIdToToken = new Map<string, string>();
  // panelId -> parent panel id (null for roots)
  private panelParentIds = new Map<string, string | null>();
  // panelId -> authenticated shell/client caller id that owns browser handoff
  private panelOwnerCallerIds = new Map<string, string>();
  private panelOwnerConnectionIds = new Map<string, EphemeralConnectionId>();
  // revocation listeners
  private revokeListeners: ((callerId: string) => void)[] = [];
  private panelTokenListeners: ((record: PanelTokenRecord | null, panelId: string) => void)[] = [];
  // admin token for privileged operations
  private adminToken: string | null = null;

  /**
   * Create a new token for a caller. Throws if a token already exists for this callerId.
   */
  createToken(callerId: string, callerKind: CallerKind): string {
    if (this.callerIdToToken.has(callerId)) {
      throw new Error(`Token already exists for caller "${callerId}"`);
    }

    const token = randomBytes(32).toString("hex");
    this.tokenToEntry.set(token, { callerId, callerKind });
    this.callerIdToToken.set(callerId, token);
    if (callerKind === "panel") this.emitPanelTokenRecord(callerId);
    return token;
  }

  /**
   * Ensure a token exists for a caller. If one already exists, return it.
   * If not, create a new one. Used by rebuild/restore paths where the token
   * may or may not have been revoked.
   */
  ensureToken(callerId: string, callerKind: CallerKind): string {
    const existing = this.callerIdToToken.get(callerId);
    if (existing) return existing;
    return this.createToken(callerId, callerKind);
  }

  /**
   * Re-register a token that was issued in a previous process lifetime and
   * persisted by the shell/panel token store. Without this, the token would be
   * unknown to the fresh in-memory TokenManager after restart.
   *
   * Idempotent: returns true if the registration took effect, false if a
   * binding already exists for the callerId or the token is already mapped
   * to a different caller (collision; should be vanishingly rare with 256
   * bits of entropy, but we refuse silently rather than overwrite).
   */
  registerExistingToken(token: string, callerId: string, callerKind: CallerKind): boolean {
    if (this.callerIdToToken.has(callerId)) return false;
    if (this.tokenToEntry.has(token)) return false;
    this.tokenToEntry.set(token, { callerId, callerKind });
    this.callerIdToToken.set(callerId, token);
    if (callerKind === "panel") this.emitPanelTokenRecord(callerId);
    return true;
  }

  /**
   * Get the existing token for a caller. Throws if no token exists.
   */
  getToken(callerId: string): string {
    const token = this.callerIdToToken.get(callerId);
    if (!token) {
      throw new Error(`No token exists for caller "${callerId}"`);
    }
    return token;
  }

  /**
   * Validate a bearer token.
   * Returns the entry { callerId, callerKind } if valid, null otherwise.
   */
  validateToken(
    token: string
  ): { callerId: string; callerKind: CallerKind } | null {
    return this.tokenToEntry.get(token) ?? null;
  }

  /**
   * Convenience: get the caller ID (panel ID) associated with a token.
   */
  getPanelIdFromToken(token: string): string | null {
    const entry = this.tokenToEntry.get(token);
    return entry?.callerId ?? null;
  }

  /**
   * Revoke token for a caller (e.g., when panel is closed).
   * Notifies all revocation listeners.
   */
  revokeToken(callerId: string): boolean {
    const token = this.callerIdToToken.get(callerId);
    if (!token) return false;

    this.callerIdToToken.delete(callerId);
    this.tokenToEntry.delete(token);
    this.panelParentIds.delete(callerId);
    this.panelOwnerCallerIds.delete(callerId);
    this.panelOwnerConnectionIds.delete(callerId);
    this.emitPanelTokenRecord(callerId);

    for (const listener of this.revokeListeners) {
      listener(callerId);
    }

    return true;
  }

  /**
   * Register a listener that is called when a token is revoked.
   */
  onRevoke(listener: (callerId: string) => void): void {
    this.revokeListeners.push(listener);
  }

  /**
   * Clear all tokens and notify listeners for each.
   */
  clear(): void {
    const callerIds = [...this.callerIdToToken.keys()];
    this.tokenToEntry.clear();
    this.callerIdToToken.clear();
    this.panelParentIds.clear();
    this.panelOwnerCallerIds.clear();
    this.panelOwnerConnectionIds.clear();

    for (const callerId of callerIds) {
      this.emitPanelTokenRecord(callerId);
      for (const listener of this.revokeListeners) {
        listener(callerId);
      }
    }
  }

  /**
   * Set the admin token for privileged operations.
   */
  setAdminToken(token: string): void {
    this.adminToken = token;
  }

  /**
   * Validate an admin token.
   *
   * Default-deny when no admin token is configured (audit finding #25):
   * we used to return false here too, but only when `token` was set; now we
   * also reject empty/missing presented tokens explicitly.
   *
   * Comparison is constant-time (audit finding #33).
   */
  validateAdminToken(token: string): boolean {
    if (this.adminToken === null) return false;
    if (typeof token !== "string" || token.length === 0) return false;
    return constantTimeStringEqual(token, this.adminToken);
  }

  setPanelParent(panelId: string, parentId: string | null): void {
    this.panelParentIds.set(panelId, parentId);
    this.emitPanelTokenRecord(panelId);
  }

  getPanelParent(panelId: string): string | null | undefined {
    return this.panelParentIds.get(panelId);
  }

  setPanelOwner(
    panelId: string,
    ownerCallerId: string,
    ownerConnectionId?: EphemeralConnectionId | string,
  ): void {
    this.panelOwnerCallerIds.set(panelId, ownerCallerId);
    if (ownerConnectionId) {
      this.panelOwnerConnectionIds.set(panelId, ephemeralConnectionId(ownerConnectionId));
    } else {
      this.panelOwnerConnectionIds.delete(panelId);
    }
    this.emitPanelTokenRecord(panelId);
  }

  getPanelOwner(panelId: string): string | undefined {
    return this.panelOwnerCallerIds.get(panelId);
  }

  getPanelOwnerConnection(panelId: string): EphemeralConnectionId | undefined {
    return this.panelOwnerConnectionIds.get(panelId);
  }

  getPanelTokenRecord(panelId: string): PanelTokenRecord | null {
    const token = this.callerIdToToken.get(panelId);
    const entry = token ? this.tokenToEntry.get(token) : undefined;
    if (!token || entry?.callerKind !== "panel") return null;
    return {
      panelId,
      token,
      callerKind: "panel",
      parentId: this.panelParentIds.get(panelId),
      ownerCallerId: this.panelOwnerCallerIds.get(panelId),
      ownerConnectionId: this.panelOwnerConnectionIds.get(panelId),
    };
  }

  listPanelTokenRecords(): PanelTokenRecord[] {
    const records: PanelTokenRecord[] = [];
    for (const callerId of this.callerIdToToken.keys()) {
      const record = this.getPanelTokenRecord(callerId);
      if (record) records.push(record);
    }
    return records;
  }

  onPanelTokenRecordChanged(
    listener: (record: PanelTokenRecord | null, panelId: string) => void,
  ): void {
    this.panelTokenListeners.push(listener);
  }

  isPanelDescendantOf(panelId: string, ancestorId: string): boolean {
    let current = this.panelParentIds.get(panelId);
    const visited = new Set<string>();
    while (current) {
      if (current === ancestorId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      current = this.panelParentIds.get(current) ?? null;
    }
    return false;
  }

  private emitPanelTokenRecord(panelId: string): void {
    const record = this.getPanelTokenRecord(panelId);
    for (const listener of this.panelTokenListeners) {
      listener(record, panelId);
    }
  }

}
