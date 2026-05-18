import { randomBytes, timingSafeEqual } from "crypto";
import type { CallerKind } from "./serviceDispatcher.js";

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
 * Global token manager for admin and non-panel bearer authentication.
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
  // revocation listeners
  private revokeListeners: ((callerId: string) => void)[] = [];
  // admin token for privileged operations
  private adminToken: string | null = null;

  /**
   * Create a new token for a caller. Throws if a token already exists for this callerId.
   */
  createToken(callerId: string, callerKind: CallerKind): string {
    if (callerKind === "panel") {
      throw new Error("Panel bearer tokens have been removed; use connection grants");
    }
    if (this.callerIdToToken.has(callerId)) {
      throw new Error(`Token already exists for caller "${callerId}"`);
    }

    const token = randomBytes(32).toString("hex");
    this.tokenToEntry.set(token, { callerId, callerKind });
    this.callerIdToToken.set(callerId, token);
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
   * persisted by the caller. Without this, the token would be unknown to the
   * fresh in-memory TokenManager and inbound RPC from that caller would 401.
   *
   * Idempotent: returns true if the registration took effect, false if a
   * binding already exists for the callerId or the token is already mapped
   * to a different caller (collision; should be vanishingly rare with 256
   * bits of entropy, but we refuse silently rather than overwrite).
   */
  registerExistingToken(token: string, callerId: string, callerKind: CallerKind): boolean {
    if (callerKind === "panel") return false;
    if (this.callerIdToToken.has(callerId)) return false;
    if (this.tokenToEntry.has(token)) return false;
    this.tokenToEntry.set(token, { callerId, callerKind });
    this.callerIdToToken.set(callerId, token);
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

  ensureWorkerBearer(callerId: string): string {
    return this.ensureToken(callerId, "worker");
  }

  validateWorkerBearer(token: string): { callerId: string } | null {
    const entry = this.validateToken(token);
    if (!entry || entry.callerKind !== "worker") return null;
    return { callerId: entry.callerId };
  }

  revokeWorkerBearer(callerId: string): boolean {
    return this.revokeToken(callerId);
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

    for (const callerId of callerIds) {
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

}
