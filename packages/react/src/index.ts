/**
 * @natstack/react
 *
 * React bindings for NatStack panels. This provides:
 * - React hooks for panel state and RPC
 * - Auto-mount utilities for React panels
 * - React panel mounting helpers
 *
 * Use alongside @natstack/runtime for full functionality.
 */

// Export React-specific functionality only
export * from './hooks.js';
export { autoMountReactPanel, shouldAutoMount } from './autoMount.js';
export { createReactPanelMount, type ReactPanelOptions, type ReactPanelInstance } from './reactPanel.js';
