/**
 * Portable authoring helpers — pure, target-independent utilities that are
 * IDENTICAL on panel · worker · eval. Both runtime barrels (`panel/index.ts`,
 * `worker/index.ts`) `export * from "./portable.js"` instead of re-declaring
 * these scattered re-exports, so "portable" is a single declared contract rather
 * than a per-barrel accident.
 *
 * Everything here is import-free / SSR-safe (verified): pure string/path/context
 * helpers, the zod schema lib, the contract-definition helper, and the gateway
 * fetch factory. NO panel globals, DOM, or RPC singletons.
 */

// Contract / schema authoring tools
export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract } from "../core/defineContract.js";

// Pure context-id / path helpers
export { parseContextId, isValidContextId, getInstanceId } from "../core/context.js";
export { normalizePath, getFileName, resolvePath } from "./pathUtils.js";

// Panel-link builder (SSR-guarded) + gateway fetch factory
export { buildPanelLink } from "../core/panelLinks.js";
export { createGatewayFetch } from "./gatewayFetch.js";
export type { GatewayFetch, GatewayFetchConfig } from "./gatewayFetch.js";
