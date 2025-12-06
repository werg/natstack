/**
 * Types for @natstack/build-mdx
 */

import type { ComponentType } from "react";
import type { PackageRegistry } from "@natstack/build";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComponent = ComponentType<any>;

/**
 * Context for dependency resolution during MDX compilation.
 */
export interface MDXContext {
  /** Filesystem path to the project root (for package.json lookup) */
  projectRoot: string;

  /**
   * Source root for resolving relative imports (e.g., "./utils", "../lib").
   * If not provided, defaults to projectRoot.
   */
  sourceRoot?: string;

  /** Package registry (includes project + workspace deps) */
  registry?: PackageRegistry;

  /** Pre-parsed dependencies (alternative to registry) */
  dependencies?: Record<string, string>;
}

export interface MDXOptions {
  /** Components available in MDX scope (without importing) */
  components?: Record<string, AnyComponent>;

  /** Variables/data available in MDX scope */
  scope?: Record<string, unknown>;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;

  /** Context for dependency resolution */
  context?: MDXContext;
}

export interface MDXResult {
  /** The compiled React component */
  Component: ComponentType<{ components?: Record<string, AnyComponent> }>;

  /** Any named exports from the MDX file */
  exports: Record<string, unknown>;
}
