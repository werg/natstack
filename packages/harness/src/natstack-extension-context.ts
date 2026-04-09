/**
 * NatStackExtensionUIContext
 *
 * Bridges NatStack's local `PiExtensionUIContext` interface to channel
 * operations. Extensions call `ctx.ui.confirm/select/notify/...` and the
 * bridge forwards each call to a worker-supplied callback that turns the
 * request into a channel feedback_form, ephemeral message, or
 * metadata-update event.
 *
 * Many UI primitives are TUI-only (theme manipulation, custom editors,
 * raw terminal input). Those are no-ops in the headless NatStack context;
 * they are still defined as methods so extensions written for Pi's full
 * surface can target the bridge without compile errors.
 */

import type {
  PiExtensionUIContext,
  PiExtensionUIDialogOptions as ExtensionUIDialogOptions,
  PiExtensionWidgetOptions as ExtensionWidgetOptions,
} from "./pi-extension-api.js";

export interface NatStackUIBridgeCallbacks {
  /** Show a single-choice select; return the chosen option's label or undefined if cancelled. */
  showSelect(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
  /** Show a yes/no confirm; return true for yes. */
  showConfirm(
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<boolean>;
  /** Show a free-text input; return the entered value or undefined if cancelled. */
  showInput(
    title: string,
    placeholder: string | undefined,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
  /** Show a multi-line editor; return the entered value or undefined if cancelled. */
  showEditor(title: string, prefill?: string): Promise<string | undefined>;
  /** Push a notification to the channel as an ephemeral message. */
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** Set or clear a status entry by key. */
  setStatus(key: string, text: string | undefined): void;
  /** Set or clear a widget by key. */
  setWidget(
    key: string,
    content: string[] | undefined,
    opts?: ExtensionWidgetOptions,
  ): void;
  /** Set the working/loading message shown during streaming. */
  setWorkingMessage(message: string | undefined): void;
  /**
   * Push an OAuth Connect affordance into the chat (e.g., when the agent's
   * model provider is not yet logged in).
   *
   * Implementations typically render an inline_ui card with a Connect button
   * that calls `auth.startOAuthLogin(providerId)` from the panel context.
   *
   * Fire-and-forget on the agent side: the actual unblock signal comes from
   * `auth.waitForProvider`, which the agent worker awaits separately. This
   * method only needs to **show** the affordance — it does not need to wait
   * for the user click.
   *
   * @param providerId  Pi-AI provider id (e.g. `"openai-codex"`).
   * @param displayName Human-readable provider name shown in the card.
   */
  requestProviderOAuth(providerId: string, displayName: string): void;
}

export class NatStackExtensionUIContext implements PiExtensionUIContext {
  constructor(private readonly callbacks: NatStackUIBridgeCallbacks) {}

  // ── Interactive primitives ──────────────────────────────────────────────

  async select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return this.callbacks.showSelect(title, options, opts);
  }

  async confirm(
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<boolean> {
    return this.callbacks.showConfirm(title, message, opts);
  }

  async input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return this.callbacks.showInput(title, placeholder, opts);
  }

  async editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.callbacks.showEditor(title, prefill);
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.callbacks.notify(message, type);
  }

  setStatus(key: string, text: string | undefined): void {
    this.callbacks.setStatus(key, text);
  }

  setWorkingMessage(message?: string): void {
    this.callbacks.setWorkingMessage(message);
  }

  /**
   * Push an OAuth Connect card into the chat. PiRunner calls this from inside
   * its `getApiKey` callback when the model provider has no valid token. The
   * actual unblock signal comes from `auth.waitForProvider`, not from the
   * promise returned here — this method is fire-and-forget on the agent side.
   */
  requestProviderOAuth(providerId: string, displayName: string): void {
    this.callbacks.requestProviderOAuth(providerId, displayName);
  }

  setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
    // Pi's interface overloads accept either string[] (TUI-friendly) or a
    // component factory function. In headless mode we only forward the
    // string-array variant; component factories are TUI-specific and silently
    // dropped here. The signature is `unknown` to satisfy both overload arms.
    if (Array.isArray(content) || content === undefined) {
      this.callbacks.setWidget(key, content as string[] | undefined, options);
    }
  }

  // ── No-ops in headless mode ─────────────────────────────────────────────
  // These are TUI-specific surfaces (terminal, theme, editor component, etc.)
  // that have no NatStack equivalent. We accept the calls and discard them.

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

  // ── Theme accessors (return empty defaults) ─────────────────────────────

  // The Theme type is opaque to NatStack; we return a minimal stub object
  // that satisfies the structural type. Extensions that actually use theme
  // styling are TUI-only and won't be loaded in headless mode.
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
