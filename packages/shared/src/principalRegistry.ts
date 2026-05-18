export type PrincipalKind = "panel" | "worker" | "do-service" | "shell" | "server";

export type ChangeKind = "register" | "unregister" | "source" | "context" | "parent";

export interface PrincipalSource {
  repoPath: string;
  effectiveVersion: string;
}

export interface PrincipalRecord {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly createdAt: number;
  source: PrincipalSource | null;
  context: { contextId: string } | null;
  parent: { parentId: string | null };
}

export class PrincipalRegistry {
  private readonly records = new Map<string, PrincipalRecord>();
  private readonly listeners = new Set<(id: string, change: ChangeKind) => void>();

  register(args: {
    id: string;
    kind: PrincipalKind;
    source?: PrincipalSource | null;
    context?: { contextId: string } | null;
    parent?: { parentId: string | null } | null;
  }): PrincipalRecord {
    const existing = this.records.get(args.id);
    if (existing) {
      if (existing.kind !== args.kind) {
        throw new Error(
          `Principal ${args.id} is already registered as ${existing.kind}, not ${args.kind}`,
        );
      }
      existing.source = args.source ?? existing.source;
      existing.context = args.context ?? existing.context;
      existing.parent = args.parent ?? existing.parent;
      this.emit(args.id, "register");
      return existing;
    }

    const record: PrincipalRecord = {
      id: args.id,
      kind: args.kind,
      createdAt: Date.now(),
      source: args.source ?? null,
      context: args.context ?? null,
      parent: args.parent ?? { parentId: null },
    };
    this.records.set(args.id, record);
    this.emit(args.id, "register");
    return record;
  }

  unregister(id: string): void {
    if (this.records.delete(id)) {
      this.emit(id, "unregister");
    }
  }

  unregisterSubtree(rootId: string): string[] {
    const removed: string[] = [];
    const visit = (id: string) => {
      if (!this.records.has(id)) return;
      removed.push(id);
      for (const record of this.records.values()) {
        if (record.parent.parentId === id) visit(record.id);
      }
    };
    visit(rootId);
    for (const id of removed) this.unregister(id);
    return removed;
  }

  bindSource(id: string, source: PrincipalSource): void {
    const record = this.require(id);
    record.source = source;
    this.emit(id, "source");
  }

  clearSource(id: string): void {
    const record = this.require(id);
    record.source = null;
    this.emit(id, "source");
  }

  bindContext(id: string, contextId: string): void {
    const record = this.require(id);
    record.context = { contextId };
    this.emit(id, "context");
  }

  clearContext(id: string): void {
    const record = this.require(id);
    record.context = null;
    this.emit(id, "context");
  }

  setParent(id: string, parentId: string | null): void {
    const record = this.require(id);
    record.parent = { parentId };
    this.emit(id, "parent");
  }

  resolveAlias(callerId: string): string {
    if (!callerId.startsWith("do:")) return callerId;
    const body = callerId.slice("do:".length);
    const slashIdx = body.indexOf("/");
    const colonAfterSlash = slashIdx === -1 ? -1 : body.indexOf(":", slashIdx);
    if (colonAfterSlash === -1) return callerId;
    const source = body.slice(0, colonAfterSlash);
    const rest = body.slice(colonAfterSlash + 1);
    const nextColon = rest.indexOf(":");
    if (nextColon === -1) return callerId;
    const className = rest.slice(0, nextColon);
    const objectKey = rest.slice(nextColon + 1);
    if (!source || !className || !objectKey) return callerId;
    return `do-service:${source}:${className}`;
  }

  resolve(callerId: string): PrincipalRecord | null {
    return this.records.get(this.resolveAlias(callerId)) ?? null;
  }

  resolveSource(callerId: string): PrincipalSource | null {
    return this.resolve(callerId)?.source ?? null;
  }

  resolveContext(callerId: string): string | null {
    return this.resolve(callerId)?.context?.contextId ?? null;
  }

  resolveParent(callerId: string): string | null | undefined {
    return this.resolve(callerId)?.parent.parentId;
  }

  isDescendantOf(callerId: string, ancestorId: string): boolean {
    const ancestor = this.resolveAlias(ancestorId);
    let current = this.resolveParent(callerId) ?? null;
    const visited = new Set<string>();
    while (current) {
      const currentAlias = this.resolveAlias(current);
      if (currentAlias === ancestor) return true;
      if (visited.has(currentAlias)) return false;
      visited.add(currentAlias);
      current = this.resolveParent(currentAlias) ?? null;
    }
    return false;
  }

  onChange(listener: (id: string, change: ChangeKind) => void): void {
    this.listeners.add(listener);
  }

  private require(id: string): PrincipalRecord {
    const record = this.records.get(this.resolveAlias(id));
    if (!record) throw new Error(`Principal not registered: ${id}`);
    return record;
  }

  private emit(id: string, change: ChangeKind): void {
    for (const listener of this.listeners) listener(id, change);
  }
}
