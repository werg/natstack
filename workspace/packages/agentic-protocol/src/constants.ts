export const AGENTIC_PROTOCOL_VERSION = "agentic.trajectory.v1" as const;

export const AGENTIC_EVENT_PAYLOAD_KIND = "agentic.trajectory.v1/event" as const;

export const GENESIS_EVENT_HASH = "0".repeat(64);

export const TERMINAL_MESSAGE_KINDS = [
  "message.completed",
  "message.failed",
] as const;

export const TERMINAL_INVOCATION_KINDS = [
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
] as const;

export const TERMINAL_APPROVAL_KINDS = ["approval.resolved"] as const;

export const TURN_SCOPED_OWNER_KINDS = [
  "message.started",
  "message.delta",
  "message.completed",
  "message.failed",
  "invocation.started",
  "invocation.progress",
  "invocation.output",
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
  "approval.requested",
  "approval.resolved",
  "turn.opened",
  "turn.closed",
] as const;
