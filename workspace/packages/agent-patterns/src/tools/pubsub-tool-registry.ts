/**
 * PubsubToolRegistry - Pure discovery layer for pubsub tools.
 *
 * Transforms discoverMethodDefs() output into normalized PubsubTool objects
 * with canonical names and wire names.
 *
 * This is pure data - no approval logic, no execution, no action tracking.
 * SDK adapters compose these concerns on top.
 */

import type { AgenticClient, DiscoveredMethod } from "@workspace/agentic-messaging";
import { getCanonicalToolName } from "@workspace/agentic-messaging/utils";

/**
 * A normalized tool discovered via pubsub.
 * Pure data - no execute function, no approval state.
 */
export interface PubsubTool {
  /** Provider's client ID */
  providerId: string;
  /** Provider's display name */
  providerName: string;
  /** Original pubsub method name (snake_case, e.g., "file_read") */
  methodName: string;
  /** Claude-style canonical name (PascalCase, e.g., "Read") */
  canonicalName: string;
  /** Prefixed wire name for SDK uniqueness (e.g., "pubsub_abc_file_read") */
  wireName: string;
  /** Tool description (may include provider prefix) */
  description?: string;
  /** JSON Schema for tool parameters */
  parameters: Record<string, unknown>;
  /** Whether this is a menu-only method (not an AI tool) */
  menu: boolean;
}

/**
 * Immutable registry of discovered pubsub tools.
 * Provides multiple lookup strategies.
 */
export interface PubsubToolRegistry {
  /** All discovered tools */
  readonly tools: readonly PubsubTool[];
  /** Lookup by canonical name (e.g., "Read") */
  readonly byCanonical: ReadonlyMap<string, PubsubTool>;
  /** Lookup by original method name (e.g., "file_read") */
  readonly byMethod: ReadonlyMap<string, PubsubTool>;
  /** Lookup by wire name (e.g., "pubsub_abc_file_read") */
  readonly byWire: ReadonlyMap<string, PubsubTool>;
  /** Try all lookups in order: wire -> canonical -> method */
  get(name: string): PubsubTool | undefined;
}

export interface BuildRegistryOptions {
  /** Include tools from the client itself (default: false) */
  includeSelf?: boolean;
  /** Include menu-only methods (default: false) */
  includeMenu?: boolean;
  /** Custom filter applied after includeSelf/includeMenu checks */
  filter?: (method: DiscoveredMethod) => boolean;
  /** Prefix for wire names (default: "pubsub") */
  namePrefix?: string;
}

export interface DiscoverPubsubToolsOptions extends BuildRegistryOptions {
  /** Method names that must be available before building (optional) */
  required?: readonly string[];
  /** Limit registry to this allowlist of method names (optional) */
  allowlist?: readonly string[];
  /** Maximum time to wait for required tools (default: 5000ms) */
  timeoutMs?: number;
  /** Polling interval (default: 100ms) */
  pollIntervalMs?: number;
  /** Logger */
  log?: (msg: string) => void;
}

/**
 * Build a PubsubToolRegistry from all discovered methods on the client.
 *
 * @example
 * ```typescript
 * const registry = buildPubsubToolRegistry(client, {
 *   filter: (m) => m.providerId !== client.clientId && !m.menu,
 * });
 * console.log(registry.tools.length); // number of tools
 * const readTool = registry.get("Read"); // lookup by canonical name
 * ```
 */
export function buildPubsubToolRegistry(
  client: AgenticClient,
  options?: BuildRegistryOptions
): PubsubToolRegistry {
  const {
    includeSelf = false,
    includeMenu = false,
    filter,
    namePrefix = "pubsub",
  } = options ?? {};

  let methods = client.discoverMethodDefs();

  // Apply built-in filters
  if (!includeSelf) {
    methods = methods.filter((m) => m.providerId !== client.clientId);
  }
  if (!includeMenu) {
    methods = methods.filter((m) => !m.menu);
  }

  // Apply custom filter
  if (filter) {
    methods = methods.filter(filter);
  }

  const tools: PubsubTool[] = [];
  const byCanonical = new Map<string, PubsubTool>();
  const byMethod = new Map<string, PubsubTool>();
  const byWire = new Map<string, PubsubTool>();

  for (const method of methods) {
    const wireName = `${namePrefix}_${method.providerId}_${method.name}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );
    const canonicalName = getCanonicalToolName(method.name);

    const tool: PubsubTool = {
      providerId: method.providerId,
      providerName: method.providerName,
      methodName: method.name,
      canonicalName,
      wireName,
      description: method.description
        ? `[${method.providerName}] ${method.description}`
        : undefined,
      parameters: method.parameters as Record<string, unknown>,
      menu: method.menu ?? false,
    };

    tools.push(tool);
    // First tool wins for each lookup key
    if (!byCanonical.has(canonicalName)) byCanonical.set(canonicalName, tool);
    if (!byMethod.has(method.name)) byMethod.set(method.name, tool);
    byWire.set(wireName, tool);
  }

  return {
    tools,
    byCanonical,
    byMethod,
    byWire,
    get(name: string): PubsubTool | undefined {
      return byWire.get(name) ?? byCanonical.get(name) ?? byMethod.get(name);
    },
  };
}

/**
 * Discover pubsub tools with optional waiting and allowlist filtering.
 *
 * If `required` is provided, waits until those methods are available.
 * If `allowlist` is provided, the registry is filtered to those methods.
 */
export async function discoverPubsubTools(
  client: AgenticClient,
  options?: DiscoverPubsubToolsOptions
): Promise<PubsubToolRegistry> {
  const required = options?.required ?? [];
  const allowlist = options?.allowlist ?? [];
  const log = options?.log;

  if (required.length > 0) {
    await waitForTools(client, {
      required,
      timeoutMs: options?.timeoutMs,
      pollIntervalMs: options?.pollIntervalMs,
      log,
    });
  } else if (allowlist.length > 0) {
    await waitForTools(client, {
      required: allowlist,
      timeoutMs: options?.timeoutMs,
      pollIntervalMs: options?.pollIntervalMs,
      log,
    });
  }

  const allowSet = allowlist.length > 0 ? new Set(allowlist) : undefined;
  const userFilter = options?.filter;

  return buildPubsubToolRegistry(client, {
    includeSelf: options?.includeSelf,
    includeMenu: options?.includeMenu,
    namePrefix: options?.namePrefix,
    filter: (method) => {
      if (allowSet && !allowSet.has(method.name)) return false;
      return userFilter ? userFilter(method) : true;
    },
  });
}

/**
 * Wait for required tools to be advertised by panel participants.
 * Polls until all required methods are available in the roster.
 *
 * Addresses the race condition where panels advertise methods after
 * the agent has already connected.
 *
 * @example
 * ```typescript
 * const registry = await waitForTools(client, {
 *   required: ["feedback_form"],
 *   timeoutMs: 5000,
 * });
 * ```
 */
export async function waitForTools(
  client: AgenticClient,
  options: {
    /** Method names that must be available */
    required: readonly string[];
    /** Maximum time to wait (default: 5000ms) */
    timeoutMs?: number;
    /** Polling interval (default: 100ms) */
    pollIntervalMs?: number;
    /** Logger */
    log?: (msg: string) => void;
  }
): Promise<PubsubToolRegistry> {
  const { required, timeoutMs = 5000, pollIntervalMs = 100, log } = options;
  const start = Date.now();

  function getMissing(): string[] {
    const available = new Set(client.discoverMethodDefs().map((m) => m.name));
    return required.filter((name) => !available.has(name));
  }

  let missing = getMissing();
  if (missing.length === 0) {
    return buildPubsubToolRegistry(client);
  }

  log?.(`Waiting for tools: ${missing.join(", ")}`);

  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    missing = getMissing();
    if (missing.length === 0) {
      log?.("All required tools available");
      return buildPubsubToolRegistry(client);
    }
  }

  log?.(
    `Tools still missing after ${timeoutMs}ms: ${missing.join(", ")}`
  );

  // Return registry with whatever is available
  return buildPubsubToolRegistry(client);
}

/**
 * Create an execute function for a specific pubsub tool.
 * Uses client.callMethod() to invoke the tool on its provider.
 *
 * @example
 * ```typescript
 * const readTool = registry.get("Read")!;
 * const executor = createToolExecutor(client, readTool);
 * const result = await executor({ file_path: "/foo/bar.ts" });
 * ```
 */
export function createToolExecutor(
  client: AgenticClient,
  tool: PubsubTool
): (args: unknown, signal?: AbortSignal) => Promise<unknown> {
  return async (args: unknown, signal?: AbortSignal): Promise<unknown> => {
    const handle = client.callMethod(tool.providerId, tool.methodName, args, {
      signal,
    });
    return (await handle.result).content;
  };
}
