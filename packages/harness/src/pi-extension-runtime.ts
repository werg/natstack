/**
 * PiExtensionRuntime
 *
 * NatStack-owned mini runtime that hosts NatStack extension factories
 * (approval-gate, channel-tools, ask-user) without depending on Pi's
 * full extension loader. The worker DO instantiates one runtime per chat
 * lifetime, binds a UI context that bridges to the channel, loads the
 * factories, and then dispatches `tool_call` / `session_start` /
 * `turn_start` events forwarded from Pi.
 *
 * Responsibilities:
 *   - Maintain the registered tool map (Map.set semantics: re-register
 *     overwrites by name).
 *   - Maintain the active tool name set so the worker can compute the
 *     final list of tools to hand to the agent.
 *   - Dispatch events in registration order, returning the first
 *     `{ block: true }` result if any handler blocks.
 *   - Provide an `ExtensionContext`-shaped object to handlers, backed by
 *     a UI bridge bound separately via `bindUI`.
 */

import type {
  AgentTool,
  PiExtensionAPI,
  PiExtensionContext,
  PiExtensionEventResult,
  PiExtensionFactory,
  PiExtensionHandler,
  PiToolInfo,
} from "./pi-extension-api.js";
import {
  NatStackExtensionUIContext,
  type NatStackScopedUiContext,
} from "./natstack-extension-context.js";

export class PiExtensionRuntime {
  private readonly handlers = new Map<string, PiExtensionHandler[]>();
  private readonly tools = new Map<string, AgentTool<any, any>>();
  private activeToolNames = new Set<string>();
  private uiContext: NatStackScopedUiContext | null = null;

  constructor(private readonly cwd: string) {}

  /**
   * Bind the UI bridge that handlers will use via `ctx.ui`. Must be called
   * before any event is dispatched. May be called multiple times to swap
   * the UI implementation (e.g. when the worker rotates the channel
   * connection).
   */
  bindUI(uiContext: NatStackScopedUiContext): void {
    this.uiContext = uiContext;
  }

  /**
   * Run all factories against this runtime's API. Factories register tools
   * and event handlers as a side-effect. The factories may be async; they
   * are awaited sequentially in registration order so any ordering
   * guarantees on tool registration are preserved.
   */
  async loadFactories(factories: PiExtensionFactory[]): Promise<void> {
    const api = this.buildApi();
    for (const factory of factories) {
      await factory(api);
    }
  }

  /**
   * Build the API surface a single factory consumes. Each factory gets the
   * same instance, so handlers added by one factory are visible to events
   * dispatched after another factory has loaded.
   */
  private buildApi(): PiExtensionAPI {
    return {
      on: (event, handler) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      registerTool: (tool) => {
        // Map.set semantics: re-registering with the same name overwrites
        // the previous definition. NatStack's channel-tools extension
        // intentionally relies on this for hot-swap.
        this.tools.set(tool.name, tool as AgentTool<any, any>);
      },
      setActiveTools: (names) => {
        this.activeToolNames = new Set(names);
      },
      getActiveTools: () => [...this.activeToolNames],
      getAllTools: (): PiToolInfo[] =>
        [...this.tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as unknown,
        })),
    };
  }

  /**
   * Compute the final list of tools to hand to the underlying agent for the
   * next turn. Built-in tools are always included; extension tools are
   * filtered to the current active set, and any built-in name appearing in
   * `activeToolNames` is skipped (the built-in version wins).
   */
  getActiveTools(builtinTools: AgentTool<any, any>[]): AgentTool<any, any>[] {
    const builtinNames = new Set(builtinTools.map((t) => t.name));
    const fromExtensions = [...this.activeToolNames]
      .filter((name) => !builtinNames.has(name))
      .map((name) => this.tools.get(name))
      .filter((t): t is AgentTool<any, any> => !!t);
    return [...builtinTools, ...fromExtensions];
  }

  /**
   * Dispatch an event to all registered handlers in order. Returns the
   * first `{ block: true }` result encountered (and stops processing
   * further handlers); otherwise returns `null` once all handlers have
   * run. Handlers that throw will propagate the error to the caller.
   */
  async dispatch(
    eventType: string,
    event: unknown,
  ): Promise<PiExtensionEventResult | null> {
    const handlers = this.handlers.get(eventType);
    if (!handlers || handlers.length === 0) return null;
    const ctx = this.buildContext(event);
    for (const h of handlers) {
      const result = await h(event, ctx);
      if (result && typeof result === "object" && result.block) {
        return result;
      }
    }
    return null;
  }

  /**
   * Snapshot helpers for tests / introspection. The runtime is the source
   * of truth for the active tool set; the worker should never reach into
   * the internal map directly.
   */
  getRegisteredToolNames(): string[] {
    return [...this.tools.keys()];
  }

  getActiveToolNames(): string[] {
    return [...this.activeToolNames];
  }

  /** Build a fresh `ExtensionContext` for a single dispatch call. */
  private buildContext(event: unknown): PiExtensionContext {
    if (!this.uiContext) {
      throw new Error(
        "PiExtensionRuntime: UI context not bound. Call bindUI() before dispatching events.",
      );
    }
    const toolCallId =
      typeof event === "object" &&
      event !== null &&
      "toolCallId" in event &&
      typeof (event as { toolCallId?: unknown }).toolCallId === "string"
        ? (event as { toolCallId: string }).toolCallId
        : undefined;
    const toolName =
      typeof event === "object" &&
      event !== null &&
      "toolName" in event &&
      typeof (event as { toolName?: unknown }).toolName === "string"
        ? (event as { toolName: string }).toolName
        : undefined;
    const toolInput =
      typeof event === "object" && event !== null && "input" in event
        ? (event as { input?: unknown }).input
        : undefined;
    return {
      ui: new NatStackExtensionUIContext(this.uiContext, {
        toolCallId,
        toolName,
        toolInput,
      }),
      hasUI: true,
      cwd: this.cwd,
    };
  }
}
