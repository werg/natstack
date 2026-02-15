/**
 * Runtime Types - Core type definitions used by the app from @workspace/runtime.
 *
 * eventSchemas is typed as `unknown` here to avoid a zod dependency.
 * The app never uses this field directly.
 */

import type { RepoArgSpec } from "./git-types.js";

export interface CreateChildOptions {
  name?: string;
  env?: Record<string, string>;
  repoArgs?: Record<string, RepoArgSpec>;
  /** Typed as unknown to avoid zod dependency. At runtime this is EventSchemaMap (Record<string, ZodType>). */
  eventSchemas?: unknown;
  focus?: boolean;
  templateSpec?: string;
  contextId?: string;
}

export interface ChildCreationResult {
  id: string;
  type: "app" | "browser";
}

interface ChildSpecBase {
  name?: string;
  env?: Record<string, string>;
  source: string;
  eventSchemas?: unknown;
}

export interface ChildSpecCommon extends ChildSpecBase {
  type: "app" | "browser";
}

export interface AppChildSpec extends ChildSpecBase {
  type: "app";
  repoArgs?: Record<string, RepoArgSpec>;
}

export interface BrowserChildSpec extends ChildSpecBase {
  type: "browser";
  title?: string;
}

export type ChildSpec = AppChildSpec | BrowserChildSpec;
