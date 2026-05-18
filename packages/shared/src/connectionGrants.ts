import { randomBytes } from "node:crypto";
import type { PrincipalRegistry } from "./principalRegistry.js";

export interface ConnectionGrant {
  token: string;
  principalId: string;
  issuedBy: string;
  expiresAt: number;
}

export class ConnectionGrantService {
  private readonly registry: PrincipalRegistry;
  private readonly grants = new Map<string, ConnectionGrant>();
  private readonly gcTimer: ReturnType<typeof setInterval>;

  constructor(deps: { registry: PrincipalRegistry }) {
    this.registry = deps.registry;
    this.gcTimer = setInterval(() => this.gcExpired(), 30_000);
    this.gcTimer.unref?.();
  }

  grant(
    principalId: string,
    issuedBy: string,
    ttlMs: number = 60_000,
  ): { token: string; expiresAt: number } {
    if (!this.registry.resolve(principalId)) {
      throw new Error(`Cannot grant connection for unregistered principal: ${principalId}`);
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    this.grants.set(token, { token, principalId, issuedBy, expiresAt });
    return { token, expiresAt };
  }

  redeem(token: string): { principalId: string; issuedBy: string } | null {
    const grant = this.grants.get(token);
    if (!grant) return null;
    this.grants.delete(token);
    if (grant.expiresAt <= Date.now()) return null;
    return { principalId: grant.principalId, issuedBy: grant.issuedBy };
  }

  stop(): void {
    clearInterval(this.gcTimer);
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }
}
