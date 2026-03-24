/**
 * @workspace/svelte
 *
 * Svelte bindings for NatStack panels. This provides:
 * - Auto-mount utilities for Svelte panels
 * - Svelte stores for panel state and RPC
 *
 * Use alongside @workspace/runtime for full functionality.
 */

export { autoMountSveltePanel, shouldAutoMount } from "./autoMount.js";
export { theme, panelId, contextId, connectionError } from "./stores.js";
