export type LogRootKind = "chat" | "method" | "presence" | "system";

export interface LogWriteClassification {
  isRoot: boolean;
  rootKind?: LogRootKind;
  rootMessageId?: string;
}

function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("durable log payload must be an object");
  }
  return payload as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`durable log payload missing string ${field}`);
  }
  return value;
}

export function classifyLogWrite(type: string, payload: unknown): LogWriteClassification {
  switch (type) {
    case "message":
      return { isRoot: true, rootKind: "chat" };
    case "presence":
      return { isRoot: true, rootKind: "presence" };
    case "method-call":
      return { isRoot: true, rootKind: "method" };
    case "config-update":
      return { isRoot: true, rootKind: "system" };
    case "update-message":
    case "error":
    case "execution-pause":
      return { isRoot: false, rootMessageId: stringField(objectPayload(payload), "id") };
    case "method-result":
    case "method-cancel":
    case "method-timeout":
      return { isRoot: false, rootMessageId: stringField(objectPayload(payload), "callId") };
    default:
      return { isRoot: true, rootKind: "system" };
  }
}
