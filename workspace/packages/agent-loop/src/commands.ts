/**
 * Commands + incoming union (WS1 §1.3). Commands are the only way external
 * intent enters the loop; everything else arrives as appended events or
 * effect failures.
 */

import type { LogEnvelope, ParticipantRef } from "@workspace/agentic-protocol";
import type { AgentLoopConfig } from "./state.js";
import type { EffectKind } from "./effects.js";

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}

export type UserContent = unknown;

export type Command =
  | {
      kind: "prompt";
      channelId: string;
      /** the triggering channel envelope. */
      source: { envelopeId: string };
      content: UserContent;
      senderRef: ParticipantRef;
      agentHops?: number;
    }
  | {
      kind: "steer";
      channelId: string;
      source: { envelopeId: string };
      content: UserContent;
      senderRef: ParticipantRef;
      agentHops?: number;
    }
  | { kind: "interrupt" }
  | { kind: "abort"; reason?: string }
  | { kind: "setConfig"; patch: Partial<AgentLoopConfig> }
  | { kind: "compact" }
  | { kind: "resumeAfterReset"; messageId: string; resetAt: string }
  | { kind: "wake" };

export type Incoming =
  | { type: "command"; command: Command }
  | { type: "event-appended"; envelope: LogEnvelope }
  | {
      type: "effect-failed";
      effectId: string;
      kind: EffectKind;
      error: SerializedError;
      attempts: number;
    };

export interface StepContext {
  /** ISO timestamp chosen by the driver; logged via appendedAt (P4). */
  now: string;
  /** seeded/recorded randomness; only for envelope-less turn salts. */
  random: () => string;
  selfRef: ParticipantRef;
}
