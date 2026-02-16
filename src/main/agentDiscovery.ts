/**
 * Agent Discovery - provides agent manifests from the in-process responder registry.
 *
 * Previously scanned workspace/agents/ directory for agent packages.
 * Now reads from the hardcoded RESPONDER_REGISTRY since agents run in-process.
 *
 * The interface is preserved so all consumers (agentSettings.ts, agentSettingsHandlers.ts,
 * headlessBridge.ts, bridgeHandlers.ts) continue to work unchanged.
 */

import { EventEmitter } from "events";
import type { AgentManifest as CoreAgentManifest } from "@natstack/types";
import { RESPONDER_REGISTRY } from "./responders/index.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("AgentDiscovery");

// ===========================================================================
// Types
// ===========================================================================

/**
 * Discovered agent with validation status.
 */
export interface DiscoveredAgent {
  /** Parsed manifest (id = agent ID) */
  manifest: CoreAgentManifest;
  /** Source path (empty for in-process agents) */
  sourcePath: string;
  /** Package name */
  packageName: string;
  /** Whether manifest is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
}

export type AgentDiscoveryEvent = "added" | "removed" | "changed" | "scan-complete";

/**
 * Event callback signatures.
 */
export interface AgentDiscoveryCallbacks {
  added: (agent: DiscoveredAgent) => void;
  removed: (agent: DiscoveredAgent) => void;
  changed: (agent: DiscoveredAgent) => void;
  "scan-complete": (agents: DiscoveredAgent[]) => void;
}

export interface AgentDiscovery {
  /** Initial scan - call before other methods */
  scan(): Promise<DiscoveredAgent[]>;
  /** Get agent by ID */
  get(agentId: string): DiscoveredAgent | null;
  /** List all discovered agents */
  list(): DiscoveredAgent[];
  /** List only valid agents */
  listValid(): DiscoveredAgent[];
  /** Start watching for changes (no-op for in-process agents) */
  startWatching(): void;
  /** Stop watching (no-op for in-process agents) */
  stopWatching(): void;
  /** Subscribe to events */
  on<E extends AgentDiscoveryEvent>(event: E, callback: AgentDiscoveryCallbacks[E]): () => void;
  /** Check if watching */
  isWatching(): boolean;
}

// ===========================================================================
// Implementation
// ===========================================================================

export function createAgentDiscovery(_workspacePath: string): AgentDiscovery {
  const emitter = new EventEmitter();
  const agents = new Map<string, DiscoveredAgent>();

  async function scan(): Promise<DiscoveredAgent[]> {
    agents.clear();

    // Populate from the in-process responder registry
    for (const [agentId, registered] of RESPONDER_REGISTRY) {
      const discovered: DiscoveredAgent = {
        manifest: registered.manifest,
        sourcePath: "", // In-process, no source path
        packageName: `@workspace-agents/${agentId}`,
        valid: true,
      };
      agents.set(agentId, discovered);
      log.verbose(`Registered in-process agent: ${agentId}`);
    }

    const result = [...agents.values()];
    emitter.emit("scan-complete", result);
    return result;
  }

  return {
    scan,
    get: (agentId) => agents.get(agentId) ?? null,
    list: () => [...agents.values()],
    listValid: () => [...agents.values()].filter((a) => a.valid),
    startWatching: () => {
      // No-op: in-process agents don't need filesystem watching
    },
    stopWatching: () => {
      // No-op
    },
    on: (event, callback) => {
      emitter.on(event, callback);
      return () => emitter.off(event, callback);
    },
    isWatching: () => false,
  };
}

// ===========================================================================
// Singleton Management
// ===========================================================================

let discoveryInstance: AgentDiscovery | null = null;

/**
 * Get the current discovery instance (null if not initialized).
 */
export function getAgentDiscovery(): AgentDiscovery | null {
  return discoveryInstance;
}

/**
 * Initialize agent discovery.
 * Populates agents from the in-process responder registry.
 */
export async function initAgentDiscovery(workspacePath: string): Promise<AgentDiscovery> {
  if (discoveryInstance) {
    discoveryInstance.stopWatching();
  }

  discoveryInstance = createAgentDiscovery(workspacePath);
  await discoveryInstance.scan();

  log.verbose(`Initialized with ${discoveryInstance.listValid().length} in-process agents`);
  return discoveryInstance;
}

/**
 * Shutdown discovery (clear instance).
 */
export function shutdownAgentDiscovery(): void {
  if (discoveryInstance) {
    discoveryInstance.stopWatching();
    discoveryInstance = null;
    log.verbose("Shutdown complete");
  }
}
