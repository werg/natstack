import type { RpcMessage, RpcResponse } from "@natstack/rpc";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";

export type RelayInboxMessage = {
  fromId: string;
  message: RpcMessage;
};

export type RelayCallContext = {
  callerId: string;
  connectionId: string;
};

export type SessionTtlMs = Partial<Record<CallerKind, number>>;

export type SessionRegistryOptions = {
  inboxCapacity?: number;
  ttlMs?: SessionTtlMs;
  onSessionExpire?: (callerId: string, callerKind: CallerKind) => void;
};

class CallerSession {
  readonly callerId: string;
  callerKind: CallerKind;
  readonly createdAt = Date.now();
  lastConnectedAt = Date.now();
  disconnectedAt: number | undefined;
  liveConnectionCount = 0;
  dirty = false;
  expireTimer: ReturnType<typeof setTimeout> | undefined;
  readonly inbox: RelayInboxMessage[] = [];
  readonly pendingResponses = new Map<string, RelayCallContext>();

  constructor(callerId: string, callerKind: CallerKind) {
    this.callerId = callerId;
    this.callerKind = callerKind;
  }
}

const DEFAULT_TTL_MS: Required<SessionTtlMs> = {
  panel: 5 * 60_000,
  app: 15 * 60_000,
  shell: 15 * 60_000,
  server: 30 * 60_000,
  worker: 5 * 60_000,
  do: 5 * 60_000,
  extension: 15 * 60_000,
};

export class SessionRegistry {
  private readonly sessions = new Map<string, CallerSession>();
  private readonly inboxCapacity: number;
  private readonly ttlMs: Required<SessionTtlMs>;
  private readonly onSessionExpire?: (callerId: string, callerKind: CallerKind) => void;

  constructor(options: SessionRegistryOptions = {}) {
    this.inboxCapacity = options.inboxCapacity ?? 256;
    this.ttlMs = { ...DEFAULT_TTL_MS, ...options.ttlMs };
    this.onSessionExpire = options.onSessionExpire;
  }

  hasSession(callerId: string): boolean {
    return this.sessions.has(callerId);
  }

  getOrCreate(callerId: string, callerKind: CallerKind): CallerSession {
    let session = this.sessions.get(callerId);
    if (!session) {
      session = new CallerSession(callerId, callerKind);
      this.sessions.set(callerId, session);
      return session;
    }
    session.callerKind = callerKind;
    return session;
  }

  markConnected(callerId: string, callerKind: CallerKind): { sessionDirty: boolean } {
    const session = this.getOrCreate(callerId, callerKind);
    if (session.expireTimer) {
      clearTimeout(session.expireTimer);
      session.expireTimer = undefined;
    }
    session.liveConnectionCount += 1;
    session.lastConnectedAt = Date.now();
    session.disconnectedAt = undefined;
    return { sessionDirty: session.dirty };
  }

  markDisconnected(callerId: string, callerKind: CallerKind): void {
    const session = this.getOrCreate(callerId, callerKind);
    session.liveConnectionCount = Math.max(0, session.liveConnectionCount - 1);
    if (session.liveConnectionCount > 0) return;

    session.disconnectedAt = Date.now();
    if (session.expireTimer) clearTimeout(session.expireTimer);
    session.expireTimer = setTimeout(() => {
      const current = this.sessions.get(callerId);
      if (!current || current.liveConnectionCount > 0) return;
      this.sessions.delete(callerId);
      this.onSessionExpire?.(callerId, current.callerKind);
    }, this.ttlMs[callerKind]);
  }

  enqueue(callerId: string, fromId: string, message: RpcMessage): boolean {
    const session = this.sessions.get(callerId);
    if (!session) return false;
    if (session.inbox.length >= this.inboxCapacity) {
      session.inbox.shift();
      session.dirty = true;
      return false;
    }
    session.inbox.push({ fromId, message });
    return true;
  }

  enqueueResponse(callerId: string, fromId: string, response: RpcResponse): boolean {
    return this.enqueue(callerId, fromId, response);
  }

  takeInbox(callerId: string): RelayInboxMessage[] {
    const session = this.sessions.get(callerId);
    if (!session || session.inbox.length === 0) return [];
    return session.inbox.splice(0, session.inbox.length);
  }

  clearInbox(callerId: string): void {
    const session = this.sessions.get(callerId);
    if (!session) return;
    session.inbox.length = 0;
    session.dirty = false;
  }

  recordPendingResponse(
    callerId: string,
    callerKind: CallerKind,
    requestId: string,
    origin: RelayCallContext
  ): void {
    const session = this.getOrCreate(callerId, callerKind);
    session.pendingResponses.set(requestId, origin);
  }

  takePendingResponse(callerId: string, requestId: string): RelayCallContext | undefined {
    const session = this.sessions.get(callerId);
    const origin = session?.pendingResponses.get(requestId);
    if (origin) session?.pendingResponses.delete(requestId);
    return origin;
  }

  clear(): void {
    for (const session of this.sessions.values()) {
      if (session.expireTimer) clearTimeout(session.expireTimer);
    }
    this.sessions.clear();
  }
}
