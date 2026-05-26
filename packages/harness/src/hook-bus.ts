/**
 * HookBus - NatStack's typed event fan-out around AgentHarness.
 *
 * AgentHarness owns all upstream lifecycle events. NatStack only adds events
 * that upstream does not model, such as local recovery banners.
 */

import type {
  AgentHarnessEvent,
  AgentHarnessStreamOptionsPatch,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface OrphanFileMutationIntentEvent {
  type: "system_event";
  kind: "orphan_file_mutation_intent";
  intentEntryId: string;
  path: string | null;
}

export type NatStackRunnerEvent = OrphanFileMutationIntentEvent;
export type RunnerEvent = AgentHarnessEvent | NatStackRunnerEvent;

export interface HookListenerContext {
  signal?: AbortSignal;
}

export interface HookBusActiveListener {
  hook: HookName;
  listenerIndex: number;
  listenerCount: number;
  eventType?: string;
  startedAt: string;
  aborted: boolean;
}

export interface HookBusDebugState {
  listenerCounts: Record<HookName, number>;
  active: HookBusActiveListener | null;
}

export type EventListener = (
  event: RunnerEvent,
  context?: HookListenerContext,
) => Promise<void> | void;
export type TransformContextListener = (
  messages: AgentMessage[],
  context?: HookListenerContext,
) => Promise<AgentMessage[]> | AgentMessage[];
export type BeforeProviderRequestListener = (
  event: Extract<AgentHarnessEvent, { type: "before_provider_request" }>,
  context?: HookListenerContext,
) =>
  | Promise<{ streamOptions?: AgentHarnessStreamOptionsPatch } | undefined>
  | { streamOptions?: AgentHarnessStreamOptionsPatch }
  | undefined;

export interface HookListenerMap {
  event: EventListener;
  transform_context: TransformContextListener;
  before_provider_request: BeforeProviderRequestListener;
}

export type HookName = keyof HookListenerMap;

export class HookBus {
  private readonly eventListeners: EventListener[] = [];
  private readonly transformContextListeners: TransformContextListener[] = [];
  private readonly beforeProviderRequestListeners: BeforeProviderRequestListener[] = [];
  private active: HookBusActiveListener | null = null;

  on<TName extends HookName>(name: TName, listener: HookListenerMap[TName]): () => void {
    const list = this.bucket(name);
    list.push(listener as never);
    return () => {
      const idx = list.indexOf(listener as never);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async emitEvent(event: RunnerEvent, context: HookListenerContext = {}): Promise<void> {
    const listeners = [...this.eventListeners];
    for (const [idx, listener] of listeners.entries()) {
      if (context.signal?.aborted) throw createAbortError();
      await this.awaitListener(
        "event",
        idx,
        listeners.length,
        event.type,
        listener(event, context),
        context.signal,
      );
    }
  }

  async emitTransformContext(
    messages: AgentMessage[],
    context: HookListenerContext = {},
  ): Promise<AgentMessage[]> {
    let current = messages;
    const listeners = [...this.transformContextListeners];
    for (const [idx, listener] of listeners.entries()) {
      if (context.signal?.aborted) throw createAbortError();
      const result = await this.awaitListener(
        "transform_context",
        idx,
        listeners.length,
        undefined,
        listener(current, context),
        context.signal,
      );
      if (Array.isArray(result)) current = result;
    }
    return current;
  }

  async emitBeforeProviderRequest(
    event: Extract<AgentHarnessEvent, { type: "before_provider_request" }>,
    context: HookListenerContext = {},
  ): Promise<{ streamOptions?: AgentHarnessStreamOptionsPatch } | undefined> {
    let streamOptions: AgentHarnessStreamOptionsPatch | undefined;
    const listeners = [...this.beforeProviderRequestListeners];
    for (const [idx, listener] of listeners.entries()) {
      if (context.signal?.aborted) throw createAbortError();
      const result = await this.awaitListener(
        "before_provider_request",
        idx,
        listeners.length,
        event.type,
        listener(event, context),
        context.signal,
      );
      if (result?.streamOptions) {
        streamOptions = mergeStreamOptionPatch(streamOptions, result.streamOptions);
      }
    }
    return streamOptions ? { streamOptions } : undefined;
  }

  clear(): void {
    this.eventListeners.length = 0;
    this.transformContextListeners.length = 0;
    this.beforeProviderRequestListeners.length = 0;
    this.active = null;
  }

  getDebugState(): HookBusDebugState {
    return {
      listenerCounts: {
        event: this.eventListeners.length,
        transform_context: this.transformContextListeners.length,
        before_provider_request: this.beforeProviderRequestListeners.length,
      },
      active: this.active ? { ...this.active } : null,
    };
  }

  private bucket<TName extends HookName>(name: TName): HookListenerMap[TName][] {
    if (name === "event") return this.eventListeners as never;
    if (name === "transform_context") return this.transformContextListeners as never;
    if (name === "before_provider_request") {
      return this.beforeProviderRequestListeners as never;
    }
    throw new Error(`[HookBus] unknown hook: ${String(name)}`);
  }

  private async awaitListener<T>(
    hook: HookName,
    listenerIndex: number,
    listenerCount: number,
    eventType: string | undefined,
    value: Promise<T> | T,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    this.active = {
      hook,
      listenerIndex,
      listenerCount,
      ...(eventType ? { eventType } : {}),
      startedAt: new Date().toISOString(),
      aborted: signal?.aborted ?? false,
    };
    const markAborted = (): void => {
      if (this.active?.hook === hook && this.active.listenerIndex === listenerIndex) {
        this.active = { ...this.active, aborted: true };
      }
    };
    try {
      return await abortable(value, signal, markAborted);
    } finally {
      signal?.removeEventListener("abort", markAborted);
      if (this.active?.hook === hook && this.active.listenerIndex === listenerIndex) {
        this.active = null;
      }
    }
  }
}

function abortable<T>(
  value: Promise<T> | T,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) {
    onAbort();
    return Promise.reject(createAbortError());
  }
  const promise = Promise.resolve(value);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort();
      reject(createAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener("abort", abort);
        reject(err);
      },
    );
  });
}

function createAbortError(): Error {
  const err = new Error("Hook listener aborted");
  err.name = "AbortError";
  return err;
}

function mergeStreamOptionPatch(
  previous: AgentHarnessStreamOptionsPatch | undefined,
  next: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptionsPatch {
  return {
    ...(previous ?? {}),
    ...next,
    headers: mergeRecordPatch(previous?.headers, next.headers),
    metadata: mergeRecordPatch(previous?.metadata, next.metadata),
  };
}

function mergeRecordPatch<T>(
  previous: Record<string, T | undefined> | undefined,
  next: Record<string, T | undefined> | undefined,
): Record<string, T | undefined> | undefined {
  if (next === undefined) return previous;
  return { ...(previous ?? {}), ...next };
}
