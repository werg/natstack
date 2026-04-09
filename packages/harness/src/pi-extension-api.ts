/**
 * NatStack-local Pi extension API surface.
 *
 * This file defines the slice of pi-coding-agent's `ExtensionAPI` that
 * NatStack's three built-in extension factories (approval-gate, channel-tools,
 * ask-user) actually consume. By targeting these local types instead of the
 * upstream `@mariozechner/pi-coding-agent` types, the factories become
 * decoupled from Pi's full extension surface and can be hosted by NatStack's
 * own runtime (`PiExtensionRuntime`).
 *
 * The shapes here are NatStack-owned, but they are designed to be structurally
 * compatible with Pi's types so the same factory can be passed to either
 * runtime if needed.
 */

import type { AgentTool as PiAgentTool } from "@mariozechner/pi-agent-core";

/** Re-export `AgentTool` from pi-agent-core for convenience. */
export type AgentTool<TParameters = any, TDetails = any> = PiAgentTool<any, TDetails>;

// ── UI surface ───────────────────────────────────────────────────────────────

export interface PiExtensionUIDialogOptions {
  /** AbortSignal to programmatically dismiss the dialog. */
  signal?: AbortSignal;
  /** Timeout in milliseconds. */
  timeout?: number;
}

export type PiExtensionWidgetPlacement = "aboveEditor" | "belowEditor";

export interface PiExtensionWidgetOptions {
  placement?: PiExtensionWidgetPlacement;
}

/**
 * Subset of Pi's `ExtensionUIContext` that NatStack mirrors. Methods that are
 * TUI-only on the Pi side are still listed (as no-ops) so that any factory
 * written against Pi's surface can be retargeted at this interface without
 * code changes.
 */
export interface PiExtensionUIContext {
  // Interactive primitives
  select(
    title: string,
    options: string[],
    opts?: PiExtensionUIDialogOptions,
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    opts?: PiExtensionUIDialogOptions,
  ): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: PiExtensionUIDialogOptions,
  ): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;

  // Status / widget surface
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | undefined,
    opts?: PiExtensionWidgetOptions,
  ): void;
  setWorkingMessage(message?: string): void;

  // TUI-only no-ops (kept on the interface for structural compatibility
  // with extensions written against Pi's full UI surface).
  setHeader(): void;
  setFooter(): void;
  setTitle(): void;
  pasteToEditor(): void;
  setEditorText(): void;
}

// ── Context passed to event handlers ────────────────────────────────────────

export interface PiExtensionContext {
  ui: PiExtensionUIContext;
  hasUI: boolean;
  cwd: string;
}

// ── Event payloads we forward ───────────────────────────────────────────────

export interface PiToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface PiSessionStartEvent {
  type: "session_start";
}

export interface PiTurnStartEvent {
  type: "turn_start";
  turnIndex: number;
  timestamp: number;
}

export type PiExtensionEvent =
  | PiToolCallEvent
  | PiSessionStartEvent
  | PiTurnStartEvent;

// ── Handler return shape ────────────────────────────────────────────────────

export interface PiExtensionEventResult {
  block?: boolean;
  reason?: string;
}

/**
 * Generic extension handler. Handlers receive an event and the bound context;
 * they can return either a result or void/undefined. Async results are
 * supported.
 */
export type PiExtensionHandler = (
  event: any,
  ctx: PiExtensionContext,
) =>
  | Promise<PiExtensionEventResult | undefined | void>
  | PiExtensionEventResult
  | undefined
  | void;

// ── Tool info shape returned by getAllTools() ───────────────────────────────

export interface PiToolInfo {
  name: string;
  description: string;
  parameters: unknown;
}

// ── The API itself ──────────────────────────────────────────────────────────

/**
 * The slice of Pi's `ExtensionAPI` that NatStack's factories use.
 *
 * Designed so that an `ExtensionAPI`-shaped object from Pi will satisfy
 * `PiExtensionAPI` structurally (assignment is one-way: Pi -> NatStack).
 */
export interface PiExtensionAPI {
  on(event: string, handler: PiExtensionHandler): void;
  registerTool(tool: AgentTool<any, any>): void;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  getAllTools(): PiToolInfo[];
}

/** Factory function passed to `PiExtensionRuntime.loadFactories()`. */
export type PiExtensionFactory = (api: PiExtensionAPI) => void | Promise<void>;
