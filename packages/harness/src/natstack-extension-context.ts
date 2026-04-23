/**
 * NatStackExtensionUIContext
 *
 * Bridges NatStack's local `PiExtensionUIContext` interface to channel
 * operations. Interactive primitives are only valid during a `tool_call`
 * dispatch, where the runtime binds the active `toolCallId` into a fresh
 * per-event wrapper. Non-interactive methods remain available for all events.
 */

import type {
  PiExtensionUIContext,
  PiExtensionUIDialogOptions as ExtensionUIDialogOptions,
  PiExtensionWidgetOptions as ExtensionWidgetOptions,
} from "./pi-extension-api.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export class DispatchedError extends Error {
  constructor(public readonly placeholderResult: AgentToolResult<any>) {
    super("DISPATCHED");
  }
}

export interface NatStackToolDispatchMeta {
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  mode?: "approval" | "ui-prompt";
}

/**
 * NatStack-internal UI bridge interface. The public Pi UI surface stays
 * toolCallId-free; the runtime binds the current toolCallId per event.
 */
export interface NatStackScopedUiContext {
  selectForTool(
    toolCallId: string,
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
    meta?: NatStackToolDispatchMeta,
  ): Promise<string | undefined>;
  confirmForTool(
    toolCallId: string,
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
    meta?: NatStackToolDispatchMeta,
  ): Promise<boolean>;
  inputForTool(
    toolCallId: string,
    title: string,
    placeholder: string | undefined,
    opts?: ExtensionUIDialogOptions,
    meta?: NatStackToolDispatchMeta,
  ): Promise<string | undefined>;
  editorForTool(
    toolCallId: string,
    title: string,
    prefill?: string,
    meta?: NatStackToolDispatchMeta,
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | undefined,
    opts?: ExtensionWidgetOptions,
  ): void;
  setWorkingMessage(message: string | undefined): void;
  requestProviderOAuth(providerId: string, displayName: string): void;
  requestProviderConfig?(providerId: string, displayName: string): void;
  requestConsentGrant?(providerId: string, displayName: string): void;
}

export class NatStackExtensionUIContext implements PiExtensionUIContext {
  constructor(
    private readonly scopedUi: NatStackScopedUiContext,
    private readonly dispatchMeta?: NatStackToolDispatchMeta,
  ) {}

  private requireToolDispatch(): Required<Pick<NatStackToolDispatchMeta, "toolCallId">> &
    NatStackToolDispatchMeta {
    if (!this.dispatchMeta?.toolCallId) {
      throw new Error("UI not available outside tool_call dispatch");
    }
    return this.dispatchMeta as Required<Pick<NatStackToolDispatchMeta, "toolCallId">> &
      NatStackToolDispatchMeta;
  }

  async select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    const meta = this.requireToolDispatch();
    return this.scopedUi.selectForTool(meta.toolCallId, title, options, opts, meta);
  }

  async confirm(
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<boolean> {
    const meta = this.requireToolDispatch();
    return this.scopedUi.confirmForTool(meta.toolCallId, title, message, opts, meta);
  }

  async dispatchApproval(title: string, message: string): Promise<boolean> {
    const meta = { ...this.requireToolDispatch(), mode: "approval" as const };
    return this.scopedUi.confirmForTool(meta.toolCallId, title, message, undefined, meta);
  }

  async input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    const meta = this.requireToolDispatch();
    return this.scopedUi.inputForTool(
      meta.toolCallId,
      title,
      placeholder,
      opts,
      meta,
    );
  }

  async editor(title: string, prefill?: string): Promise<string | undefined> {
    const meta = this.requireToolDispatch();
    return this.scopedUi.editorForTool(meta.toolCallId, title, prefill, meta);
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.scopedUi.notify(message, type);
  }

  setStatus(key: string, text: string | undefined): void {
    this.scopedUi.setStatus(key, text);
  }

  setWorkingMessage(message?: string): void {
    this.scopedUi.setWorkingMessage(message);
  }

  requestProviderOAuth(providerId: string, displayName: string): void {
    this.scopedUi.requestProviderOAuth(providerId, displayName);
  }

  requestProviderConfig(providerId: string, displayName: string): void {
    this.scopedUi.requestProviderConfig?.(providerId, displayName);
  }

  requestConsentGrant(providerId: string, displayName: string): void {
    this.scopedUi.requestConsentGrant?.(providerId, displayName);
  }

  setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    if (Array.isArray(content) || content === undefined) {
      this.scopedUi.setWidget(key, content as string[] | undefined, options);
    }
  }

  onTerminalInput(): () => void {
    return () => {};
  }

  setFooter(): void {
    /* TUI-only */
  }

  setHeader(): void {
    /* TUI-only */
  }

  setTitle(): void {
    /* TUI-only */
  }

  async custom<T>(): Promise<T> {
    throw new Error(
      "ExtensionUIContext.custom() is not supported in NatStack headless mode",
    );
  }

  pasteToEditor(): void {
    /* TUI-only */
  }

  setEditorText(): void {
    /* TUI-only */
  }

  getEditorText(): string {
    return "";
  }

  setEditorComponent(): void {
    /* TUI-only */
  }

  get theme(): never {
    return {} as never;
  }

  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }

  getTheme(): undefined {
    return undefined;
  }

  setTheme(): { success: boolean; error?: string } {
    return { success: false, error: "Themes unsupported in NatStack headless mode" };
  }

  getToolsExpanded(): boolean {
    return true;
  }

  setToolsExpanded(): void {
    /* TUI-only */
  }
}
