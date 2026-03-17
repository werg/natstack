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
        input: {
            content: string;
            senderId: string;
            attachments?: unknown[];
        };
        triggerMessageId: string;
        triggerPubsubId: number;
    };
}
export interface HarnessCommand {
    type: string;
    [key: string]: unknown;
}
export declare class ServerDOClient extends HttpClient {
    constructor(baseUrl: string, authToken: string);
    spawnHarness(opts: SpawnOpts): Promise<{
        harnessId: string;
    }>;
    sendHarnessCommand(harnessId: string, command: HarnessCommand): Promise<void>;
    stopHarness(harnessId: string): Promise<void>;
    forkChannel(doRef: DORef, sourceChannel: string, forkPointId: number): Promise<{
        forkedChannelId: string;
    }>;
}
//# sourceMappingURL=server-client.d.ts.map