export type RuntimeSurfaceTarget = "panel" | "workerRuntime";

export interface RuntimeSurfaceEntry {
  kind: "value" | "namespace";
  description?: string;
  members?: string[];
}

export interface RuntimeSurface {
  target: RuntimeSurfaceTarget;
  description: string;
  exports: Record<string, RuntimeSurfaceEntry>;
}

export function valueEntry(description?: string): RuntimeSurfaceEntry {
  return { kind: "value", ...(description ? { description } : {}) };
}

export function namespaceEntry(members: string[], description?: string): RuntimeSurfaceEntry {
  return { kind: "namespace", members, ...(description ? { description } : {}) };
}
