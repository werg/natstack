// Re-export everything from @natstack/core
export * from '@natstack/core';

// Export React-specific functionality
export * from './hooks.js';
export { autoMountReactPanel, shouldAutoMount } from './autoMount.js';
export { createReactPanelMount, type ReactPanelOptions, type ReactPanelInstance } from './reactPanel.js';
