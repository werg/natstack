/**
 * Agent Discovery - scans workspace agents/ directory for agent manifests.
 *
 * DIRECTORY STRUCTURE:
 *   agents/{agentId}/package.json
 *   - agentId = directory name (e.g., "claude-responder")
 *   - package.json must have natstack.type === "agent"
 *   - Nested structures NOT supported (strictly 1-level)
 *
 * IDENTIFIERS:
 *   - manifest.id = directory name (for AgentBuilder/AgentHost lookup)
 *   - package.json name = can be scoped (for Verdaccio publishing)
 */

import * as fs from "fs";
import * as path from "path";
import chokidar from "chokidar";
import { EventEmitter } from "events";
import type { AgentManifest as CoreAgentManifest } from "@natstack/types";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("AgentDiscovery");

// ===========================================================================
// Types
// ===========================================================================

/**
 * Discovered agent with validation status.
 */
export interface DiscoveredAgent {
  /** Parsed manifest (id = directory name) */
  manifest: CoreAgentManifest;
  /** Absolute path to agent directory */
  sourcePath: string;
  /** Package name from package.json (may be scoped) */
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
  /** Get agent by ID (directory name) */
  get(agentId: string): DiscoveredAgent | null;
  /** List all discovered agents */
  list(): DiscoveredAgent[];
  /** List only valid agents */
  listValid(): DiscoveredAgent[];
  /** Start watching for changes */
  startWatching(): void;
  /** Stop watching */
  stopWatching(): void;
  /** Subscribe to events */
  on<E extends AgentDiscoveryEvent>(event: E, callback: AgentDiscoveryCallbacks[E]): () => void;
  /** Check if watching */
  isWatching(): boolean;
}

// ===========================================================================
// Implementation
// ===========================================================================

export function createAgentDiscovery(workspacePath: string): AgentDiscovery {
  const agentsDir = path.join(workspacePath, "agents");
  const emitter = new EventEmitter();
  const agents = new Map<string, DiscoveredAgent>();
  let watcher: ReturnType<typeof chokidar.watch> | null = null;

  /**
   * Load manifest from agent directory.
   * Returns null if not a valid agent (no package.json or wrong type).
   */
  function loadAgentManifest(agentDir: string): DiscoveredAgent | null {
    const pkgJsonPath = path.join(agentDir, "package.json");
    const agentId = path.basename(agentDir); // Directory name = agent ID

    if (!fs.existsSync(pkgJsonPath)) {
      return null;
    }

    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        name?: string;
        version?: string;
        natstack?: {
          type?: string;
          title?: string;
          description?: string;
          tags?: string[];
          channels?: string[];
          proposedHandle?: string;
          singleton?: boolean;
          parameters?: unknown[];
          providesMethods?: unknown[];
          requiresMethods?: unknown[];
          capabilities?: string[];
          permissions?: string[];
        };
      };

      // Must have natstack.type === "agent"
      if (pkgJson.natstack?.type !== "agent") {
        return null;
      }

      const natstack = pkgJson.natstack;
      const manifest: CoreAgentManifest = {
        // ID = directory name (NOT package.json name)
        id: agentId,
        name: natstack.title || agentId,
        version: pkgJson.version || "0.0.0",
        title: natstack.title,
        description: natstack.description,
        tags: natstack.tags,
        channels: natstack.channels,
        proposedHandle: natstack.proposedHandle,
        singleton: natstack.singleton,
        parameters: natstack.parameters as CoreAgentManifest["parameters"],
        providesMethods: natstack.providesMethods as CoreAgentManifest["providesMethods"],
        requiresMethods: natstack.requiresMethods as CoreAgentManifest["requiresMethods"],
        capabilities: natstack.capabilities,
        permissions: natstack.permissions,
      };

      return {
        manifest,
        sourcePath: agentDir,
        packageName: pkgJson.name || agentId, // May be scoped
        valid: true,
      };
    } catch (err) {
      log.verbose(`Failed to load agent manifest from ${agentDir}: ${err}`);
      return {
        manifest: {
          id: agentId,
          name: agentId,
          version: "0.0.0",
        },
        sourcePath: agentDir,
        packageName: agentId,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function scan(): Promise<DiscoveredAgent[]> {
    agents.clear();

    if (!fs.existsSync(agentsDir)) {
      log.verbose(`Agents directory does not exist: ${agentsDir}`);
      const result: DiscoveredAgent[] = [];
      emitter.emit("scan-complete", result);
      return result;
    }

    const entries = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));

    for (const entry of entries) {
      const agentDir = path.join(agentsDir, entry.name);
      const discovered = loadAgentManifest(agentDir);

      if (discovered) {
        agents.set(discovered.manifest.id, discovered);
        log.verbose(`Discovered agent: ${discovered.manifest.id} (package: ${discovered.packageName})`);
      }
    }

    const result = [...agents.values()];
    emitter.emit("scan-complete", result);
    return result;
  }

  function startWatching(): void {
    if (watcher) return;

    // Watch for package.json changes in immediate subdirectories only
    // Using explicit glob pattern - no depth option needed
    watcher = chokidar.watch(
      [
        path.join(agentsDir, "*/package.json"),
        agentsDir, // Watch for new directories
      ],
      {
        ignoreInitial: true,
        ignored: (filePath: string) => {
          // Function-based ignore to correctly exclude directories (not just contents)
          return filePath.includes("/node_modules") || filePath.includes("/.git/");
        },
      }
    );

    watcher.on("add", (filePath) => {
      if (path.basename(filePath) === "package.json") {
        const agentDir = path.dirname(filePath);
        // Verify this is an immediate child of agentsDir (1-level constraint)
        if (path.dirname(agentDir) !== agentsDir) return;

        const discovered = loadAgentManifest(agentDir);
        if (discovered) {
          const existing = agents.get(discovered.manifest.id);
          agents.set(discovered.manifest.id, discovered);
          emitter.emit(existing ? "changed" : "added", discovered);
          log.verbose(`Agent ${existing ? "changed" : "added"}: ${discovered.manifest.id}`);
        }
      }
    });

    watcher.on("change", (filePath) => {
      if (path.basename(filePath) === "package.json") {
        const agentDir = path.dirname(filePath);
        if (path.dirname(agentDir) !== agentsDir) return;

        const agentId = path.basename(agentDir);
        const discovered = loadAgentManifest(agentDir);

        if (discovered) {
          agents.set(agentId, discovered);
          emitter.emit("changed", discovered);
          log.verbose(`Agent changed: ${agentId}`);
        } else {
          // Became invalid or type changed
          const existing = agents.get(agentId);
          if (existing) {
            agents.delete(agentId);
            emitter.emit("removed", existing);
            log.verbose(`Agent removed (invalid): ${agentId}`);
          }
        }
      }
    });

    watcher.on("unlink", (filePath) => {
      if (path.basename(filePath) === "package.json") {
        const agentDir = path.dirname(filePath);
        if (path.dirname(agentDir) !== agentsDir) return;

        const agentId = path.basename(agentDir);
        const existing = agents.get(agentId);
        if (existing) {
          agents.delete(agentId);
          emitter.emit("removed", existing);
          log.verbose(`Agent removed: ${agentId}`);
        }
      }
    });

    watcher.on("unlinkDir", (dirPath) => {
      if (path.dirname(dirPath) !== agentsDir) return;

      const agentId = path.basename(dirPath);
      const existing = agents.get(agentId);
      if (existing) {
        agents.delete(agentId);
        emitter.emit("removed", existing);
        log.verbose(`Agent removed (dir deleted): ${agentId}`);
      }
    });

    log.verbose(`Started watching: ${agentsDir}`);
  }

  function stopWatching(): void {
    if (watcher) {
      watcher.close();
      watcher = null;
      log.verbose("Stopped watching");
    }
  }

  return {
    scan,
    get: (agentId) => agents.get(agentId) ?? null,
    list: () => [...agents.values()],
    listValid: () => [...agents.values()].filter((a) => a.valid),
    startWatching,
    stopWatching,
    on: (event, callback) => {
      emitter.on(event, callback);
      return () => emitter.off(event, callback);
    },
    isWatching: () => watcher !== null,
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
 * Initialize agent discovery for a workspace.
 * Performs initial scan and starts file watching.
 */
export async function initAgentDiscovery(workspacePath: string): Promise<AgentDiscovery> {
  if (discoveryInstance) {
    discoveryInstance.stopWatching();
  }

  discoveryInstance = createAgentDiscovery(workspacePath);
  await discoveryInstance.scan();
  discoveryInstance.startWatching();

  log.verbose(`Initialized for workspace: ${workspacePath}`);
  return discoveryInstance;
}

/**
 * Shutdown discovery (stop watching, clear instance).
 */
export function shutdownAgentDiscovery(): void {
  if (discoveryInstance) {
    discoveryInstance.stopWatching();
    discoveryInstance = null;
    log.verbose("Shutdown complete");
  }
}
