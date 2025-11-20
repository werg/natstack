// Global type definitions for NatStack panels
// This file provides browser-safe types without requiring @types/node

declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
};
