/**
 * Types for @natstack/build-mdx
 */

import type { ComponentType } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComponent = ComponentType<any>;

export interface MDXOptions {
  /** Components available in MDX scope (without importing) */
  components?: Record<string, AnyComponent>;

  /** Variables/data available in MDX scope */
  scope?: Record<string, unknown>;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface MDXResult {
  /** The compiled React component */
  Component: ComponentType<{ components?: Record<string, AnyComponent> }>;

  /** Any named exports from the MDX file */
  exports: Record<string, unknown>;
}
