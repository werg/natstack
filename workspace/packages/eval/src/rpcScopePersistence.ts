import type { ScopeEntry, ScopeListEntry, ScopePersistence } from "./scopePersistence.js";

interface ScopeRpc {
  call(targetId: string, method: string, ...args: unknown[]): Promise<unknown>;
}

export class RpcScopePersistence implements ScopePersistence {
  constructor(private readonly rpc: ScopeRpc) {}

  upsert(entry: ScopeEntry): Promise<void> {
    return this.rpc.call("main", "scope.upsert", entry) as Promise<void>;
  }

  loadCurrent(channelId: string, panelId: string): Promise<ScopeEntry | null> {
    return this.rpc.call("main", "scope.loadCurrent", channelId, panelId) as Promise<ScopeEntry | null>;
  }

  get(id: string): Promise<ScopeEntry | null> {
    return this.rpc.call("main", "scope.get", id) as Promise<ScopeEntry | null>;
  }

  list(channelId: string): Promise<ScopeListEntry[]> {
    return this.rpc.call("main", "scope.list", channelId) as Promise<ScopeListEntry[]>;
  }
}
