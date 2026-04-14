/**
 * ConnectionManager — Headless PubSub connection lifecycle.
 *
 * PubSub connection lifecycle — connect, disconnect, event loop, roster.
 * Manages connect/disconnect, event loop, roster, reconnect.
 */

import { connectViaRpc, isAggregatedEvent } from "@natstack/pubsub";
import type {
  PubSubClient,
  RosterUpdate,
  IncomingEvent,
  AggregatedEvent,
  MethodDefinition,
  ChannelConfig,
} from "@natstack/pubsub";
import type { ChatParticipantMetadata, ConnectionConfig } from "./types.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionCallbacks {
  onEvent?: (event: IncomingEvent) => void;
  onAggregatedEvent?: (event: AggregatedEvent) => void;
  onRoster?: (roster: RosterUpdate<ChatParticipantMetadata>) => void;
  onError?: (error: Error) => void;
  onReconnect?: () => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface ConnectionConnectOptions {
  channelId: string;
  methods: Record<string, MethodDefinition>;
  channelConfig?: ChannelConfig;
  contextId?: string;
}

export class ConnectionManager {
  private config: ConnectionConfig;
  private metadata: ChatParticipantMetadata;
  private callbacks: ConnectionCallbacks;
  private _client: PubSubClient<ChatParticipantMetadata> | null = null;
  private _status: ConnectionStatus = "disconnected";
  private _clientId: string | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(opts: {
    config: ConnectionConfig;
    metadata: ChatParticipantMetadata;
    callbacks: ConnectionCallbacks;
  }) {
    this.config = opts.config;
    this.metadata = opts.metadata;
    this.callbacks = opts.callbacks;
  }

  get client(): PubSubClient<ChatParticipantMetadata> | null {
    return this._client;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get connected(): boolean {
    return this._status === "connected";
  }

  get clientId(): string | null {
    return this._clientId;
  }

  async connect(options: ConnectionConnectOptions): Promise<PubSubClient<ChatParticipantMetadata>> {
    const { channelId, methods, channelConfig, contextId } = options;

    if (!this.config.rpc) {
      const error = new Error("PubSub RPC configuration not available");
      this.callbacks.onError?.(error);
      this.setStatus("error");
      throw error;
    }

    // Close existing connection if any
    this.disconnect();
    this.setStatus("connecting");

    try {
      const newClient = connectViaRpc<ChatParticipantMetadata>({
        rpc: this.config.rpc,
        channel: channelId,
        contextId,
        channelConfig,
        handle: this.metadata.handle,
        name: this.metadata.name,
        type: this.metadata.type,
        reconnect: true,
        clientId: this.config.clientId,
        methods,
        replayMode: "stream",
      });

      // Wait for the initial replay to complete
      await newClient.ready();

      this._client = newClient;
      this._clientId = newClient.clientId ?? null;

      const unsubs: Array<() => void> = [];

      // Set up unified event handling
      const eventIterator = newClient.events({ includeReplay: true, includeEphemeral: true });
      let eventLoopRunning = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let eventIteratorRef: AsyncIterableIterator<any> | null = eventIterator;

      void (async () => {
        try {
          for await (const event of eventIterator) {
            if (!eventLoopRunning) break;
            try {
              if (isAggregatedEvent(event)) {
                this.callbacks.onAggregatedEvent?.(event);
              } else {
                this.callbacks.onEvent?.(event as IncomingEvent);
              }
            } catch (callbackError) {
              console.error("[ConnectionManager] Event callback error:", callbackError);
            }
          }
        } catch (streamError) {
          console.error("[ConnectionManager] Event stream error:", streamError);
          this.callbacks.onError?.(
            streamError instanceof Error ? streamError : new Error(String(streamError))
          );
        } finally {
          eventIteratorRef = null;
        }
      })();
      unsubs.push(() => {
        eventLoopRunning = false;
        eventIteratorRef?.return?.();
        eventIteratorRef = null;
      });

      // Set up roster handler
      unsubs.push(
        newClient.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
          try {
            this.callbacks.onRoster?.(roster);
          } catch (rosterError) {
            console.error("[ConnectionManager] Roster callback error:", rosterError);
          }
        })
      );

      // Set up reconnect handler
      unsubs.push(
        newClient.onReconnect(() => {
          try {
            this.callbacks.onReconnect?.();
          } catch (reconnectError) {
            console.error("[ConnectionManager] Reconnect callback error:", reconnectError);
          }
        })
      );

      this.unsubscribers = unsubs;
      this.setStatus("connected");
      return newClient;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.callbacks.onError?.(error);
      this.setStatus("error");
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    if (this._client) {
      this._client.close();
    }
    this._client = null;
    this._clientId = null;
    this.setStatus("disconnected");
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
