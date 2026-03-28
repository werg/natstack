/**
 * ShellClient -- Manages PanelShell instance for React Native.
 *
 * Creates and owns the MobileTransport and PanelShell instances.
 * Exposes panel operations to React components and handles
 * initialization, teardown, and connection lifecycle.
 */

import { PanelShell } from "@shared/shell/panelShell";
import { WorkspaceClient } from "@shared/shell/workspaceClient";
import { SettingsClient } from "@shared/shell/settingsClient";
import { EventsClient } from "@shared/shell/eventsClient";
import { MobileTransport, type ConnectionStatus } from "./mobileTransport";
import type { Panel } from "@shared/types";

export interface ShellClientConfig {
  serverUrl: string;
  shellToken: string;
  /** Called whenever the panel tree changes */
  onTreeUpdated?: (tree: Panel[]) => void;
  /** Called when connection status changes */
  onStatusChange?: (status: ConnectionStatus) => void;
}

/**
 * ShellClient manages the connection to a NatStack server and provides
 * access to PanelShell, WorkspaceClient, SettingsClient, and EventsClient.
 *
 * Usage:
 *   const client = new ShellClient(config);
 *   await client.init();     // connect + load panel tree
 *   client.startPeriodicSync();
 *   // ... use client.panels, client.workspaces, etc.
 *   client.dispose();        // teardown on unmount
 */
export class ShellClient {
  readonly transport: MobileTransport;
  readonly panels: PanelShell;
  readonly workspaces: WorkspaceClient;
  readonly settings: SettingsClient;
  readonly events: EventsClient;
  /** The shell token used to authenticate with the server */
  readonly shellToken: string;
  /** The server URL this client is connected to */
  readonly serverUrl: string;

  private statusUnsub: (() => void) | null = null;

  constructor(config: ShellClientConfig) {
    this.shellToken = config.shellToken;
    this.serverUrl = config.serverUrl;

    this.transport = new MobileTransport({
      serverUrl: config.serverUrl,
      shellToken: config.shellToken,
    });

    // Wire status changes
    if (config.onStatusChange) {
      this.statusUnsub = this.transport.onStatusChange(config.onStatusChange);
    }

    // Create shared client instances backed by the transport's RPC bridge
    this.panels = new PanelShell(this.transport, config.onTreeUpdated);
    this.workspaces = new WorkspaceClient(this.transport);
    this.settings = new SettingsClient(this.transport);
    this.events = new EventsClient(this.transport);
  }

  /**
   * Connect to the server and load the initial panel tree.
   * Throws if the connection or initial load fails.
   */
  async init(): Promise<void> {
    // Connect the WebSocket transport
    this.transport.connect();

    // Wait for the connection to be established
    await this.waitForConnection(10_000);

    // Load the panel tree from the server
    await this.panels.init();
  }

  /**
   * Start periodic sync to catch external mutations (panels creating
   * children via window.open, other clients modifying the tree, etc.).
   * Mobile needs this since it doesn't have in-process tree updates
   * like Electron does.
   */
  startPeriodicSync(intervalMs = 30_000): void {
    this.panels.startPeriodicSync(intervalMs);
  }

  /**
   * Stop periodic sync (e.g., when app goes to background).
   */
  stopPeriodicSync(): void {
    this.panels.stopPeriodicSync();
  }

  /**
   * Reconnect the transport (e.g., after app returns to foreground).
   */
  reconnect(): void {
    this.transport.reconnect();
  }

  /**
   * Full teardown -- disconnect transport, stop sync, clean up listeners.
   */
  dispose(): void {
    this.panels.dispose();
    this.transport.disconnect();
    this.statusUnsub?.();
    this.statusUnsub = null;
  }

  /**
   * Wait for the WebSocket connection to reach "connected" status.
   * Rejects after timeoutMs if not connected.
   */
  private waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.transport.status === "connected") {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        unsub();
        reject(new Error(`Connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsub = this.transport.onStatusChange((status) => {
        if (status === "connected") {
          clearTimeout(timeout);
          unsub();
          resolve();
        } else if (status === "disconnected") {
          // If we go straight to disconnected (e.g., auth failure), don't wait
          clearTimeout(timeout);
          unsub();
          reject(new Error("Connection failed"));
        }
      });
    });
  }
}
