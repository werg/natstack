/**
 * ServerDOClient — HTTP client for Durable Objects to call the Node.js
 * server's harness management API directly.
 *
 * Replaces the action-return pattern for all server-side operations.
 * The DO calls these directly via fetch() instead of returning WorkerActions.
 */

import type { DORef } from "./durable-base.js";
import type { HarnessConfig } from "@natstack/harness/types";
import { HttpClient } from "./http-client.js";

export interface SpawnOpts {
  doRef: DORef;
  harnessId: string;
  type: string;
  channelId: string;
  contextId: string;
  config?: HarnessConfig;
  senderParticipantId?: string;
  initialTurn?: {
    input: { content: string; senderId: string; attachments?: unknown[] };
    triggerMessageId: string;
    triggerPubsubId: number;
  };
}

export interface HarnessCommand {
  type: string;
  [key: string]: unknown;
}

export class ServerDOClient extends HttpClient {
  constructor(baseUrl: string, authToken: string) {
    super(baseUrl, authToken, "Server HTTP");
  }

  async spawnHarness(opts: SpawnOpts): Promise<{ harnessId: string }> {
    return this.post("/harness/spawn", opts) as Promise<{ harnessId: string }>;
  }

  async sendHarnessCommand(harnessId: string, command: HarnessCommand): Promise<void> {
    await this.post(`/harness/${enc(harnessId)}/command`, { command });
  }

  async stopHarness(harnessId: string): Promise<void> {
    await this.post(`/harness/${enc(harnessId)}/stop`, {});
  }

  async forkChannel(
    doRef: DORef,
    sourceChannel: string,
    forkPointId: number,
  ): Promise<{ forkedChannelId: string }> {
    return this.post("/harness/fork-channel", {
      doRef,
      sourceChannel,
      forkPointId,
    }) as Promise<{ forkedChannelId: string }>;
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
