/**
 * useAgenticChat — Thin composer hook.
 *
 * Composes useChatCore + feature hooks (pending agents, feedback, tools,
 * debug, inline UI) into the full ChatContextValue.
 *
 * Roster tracking, pending agents, debug events, dirty repo warnings, and
 * transcript projection are owned by useChatCore. Feature hooks here handle
 * the remaining domain UX: feedback, tools, inline UI, action bars, and debug
 * presentation.
 *
 * For minimal chat (no tools, no feedback, no debug), use useChatCore directly.
 */
import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { z } from "zod";
import type { ChannelConfig, MethodDefinition, MethodExecutionContext } from "@workspace/pubsub";
import { executeSandbox, ScopeManager, RpcScopePersistence } from "@workspace/eval";
import type { SandboxOptions, SandboxResult, HydrateResult } from "@workspace/eval";
import type { ActiveFeedbackSchema, FeedbackResult } from "@workspace/tool-ui";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type ActorKind,
  type AgenticEvent,
  type SandboxSourcePayload,
} from "@workspace/agentic-protocol";
import { useChatCore } from "./core/useChatCore";
import { useChatFeedback } from "./features/useChatFeedback";
import { useChatTools } from "./features/useChatTools";
import { useChatDebug } from "./features/useChatDebug";
import { useInlineUi } from "./features/useInlineUi";
import { useActionBar } from "./features/useActionBar";
import { useMessageTypeRegistry } from "./features/useMessageTypeRegistry";
import type {
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  SandboxConfig,
  ChatSandboxValue,
  ChatParticipantMetadata,
  ChatContextValue,
  ChatInputContextValue,
  ActionBarData,
} from "../types";
import { unwrapChatMethodResult } from "@workspace/agentic-core";
import type { ChatMethodResult, AgentSubscriptionConfig } from "@workspace/agentic-core";
/** Pending agent info passed from launcher */
interface PendingAgentInfo {
  agentId: string;
  handle: string;
}
function actionBarLoadKey(
  path: string,
  props: Record<string, unknown> | undefined,
  maxHeight: number | undefined
): string {
  let propsKey = "";
  try {
    propsKey = JSON.stringify(props ?? null);
  } catch {
    propsKey = "[unserializable-props]";
  }
  return `${path}\n${propsKey}\n${maxHeight ?? ""}`;
}

function actorKindFromMetadata(type: string | undefined): ActorKind {
  if (type === "agent" || type === "system" || type === "panel" || type === "external") return type;
  return "user";
}

function actorForClient(clientId: string | undefined, metadata: ChatParticipantMetadata) {
  const id = clientId ?? metadata.handle ?? "panel";
  return {
    kind: actorKindFromMetadata(metadata.type),
    id,
    displayName: metadata.name ?? id,
    metadata: { ...metadata },
  };
}

const SANDBOX_METHOD_TIMEOUT_MS = 20 * 60 * 1000;

async function waitForMethodHandle<T>(
  handle: { result: Promise<T>; cancel?: () => Promise<void> },
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? SANDBOX_METHOD_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortCleanup: (() => void) | undefined;
  const cancel = () => {
    void handle.cancel?.().catch((err) => {
      console.warn("[useAgenticChat] Failed to cancel method handle:", err);
    });
  };
  try {
    const blockers: Array<Promise<never>> = [];
    if (timeoutMs > 0) {
      blockers.push(
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            cancel();
            reject(new Error(`Method call timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      );
    }
    if (options?.signal) {
      if (options.signal.aborted) {
        cancel();
        throw new Error("Method call aborted");
      }
      blockers.push(
        new Promise<never>((_, reject) => {
          const onAbort = () => {
            cancel();
            reject(new Error("Method call aborted"));
          };
          options.signal!.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => options.signal!.removeEventListener("abort", onAbort);
        })
      );
    }
    return await Promise.race([handle.result, ...blockers]);
  } finally {
    if (timeout) clearTimeout(timeout);
    abortCleanup?.();
  }
}

function parseInlineUiPayload(content: string): {
  id: string;
  source: SandboxSourcePayload;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
} | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const source = parsed["source"];
    if (typeof parsed["id"] !== "string" || !source || typeof source !== "object") return null;
    const sourceRecord = source as Record<string, unknown>;
    const normalizedSource =
      sourceRecord["type"] === "file" && typeof sourceRecord["path"] === "string"
        ? { type: "file" as const, path: sourceRecord["path"] }
        : sourceRecord["type"] === "code" && typeof sourceRecord["code"] === "string"
          ? { type: "code" as const, code: sourceRecord["code"] }
          : null;
    if (!normalizedSource) return null;
    const result: {
      id: string;
      source: SandboxSourcePayload;
      imports?: Record<string, string>;
      props?: Record<string, unknown>;
    } = { id: parsed["id"], source: normalizedSource };
    if (
      parsed["imports"] &&
      typeof parsed["imports"] === "object" &&
      !Array.isArray(parsed["imports"])
    ) {
      result.imports = parsed["imports"] as Record<string, string>;
    }
    if (parsed["props"] && typeof parsed["props"] === "object" && !Array.isArray(parsed["props"])) {
      result.props = parsed["props"] as Record<string, unknown>;
    }
    return result;
  } catch {
    return null;
  }
}
export interface UseAgenticChatOptions {
  config: ConnectionConfig;
  channelName: string;
  channelConfig?: ChannelConfig;
  contextId?: string;
  metadata?: ChatParticipantMetadata;
  tools?: ToolProvider;
  actions?: AgenticChatActions;
  theme?: "light" | "dark";
  pendingAgentInfos?: PendingAgentInfo[];
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** Sandbox config — provides RPC and import loading (keeps agentic-chat runtime-agnostic) */
  sandbox: SandboxConfig;
  /** Context-relative TSX file to load into the panel-local action bar on mount */
  initialActionBarFile?: string;
  /** Props for initialActionBarFile */
  initialActionBarProps?: Record<string, unknown>;
  /** Preferred max height for initialActionBarFile */
  initialActionBarMaxHeight?: number;
  /** Called when load_action_bar changes the panel-local action bar file */
  onActionBarFileChange?: (value: {
    path: string | null;
    props?: Record<string, unknown>;
    maxHeight?: number;
  }) => void | Promise<void>;
}
export function useAgenticChat({
  config,
  channelName,
  channelConfig,
  contextId,
  metadata = { name: "Chat Panel", type: "panel", handle: "user" },
  tools,
  actions,
  theme = "dark",
  pendingAgentInfos,
  initialPrompt,
  sandbox,
  initialActionBarFile,
  initialActionBarProps,
  initialActionBarMaxHeight,
  onActionBarFileChange,
}: UseAgenticChatOptions): {
  contextValue: ChatContextValue;
  inputContextValue: ChatInputContextValue;
} {
  // --- Sandbox config ref (stable access in callbacks) ---
  const sandboxRef = useRef(sandbox);
  sandboxRef.current = sandbox;
  // --- Scope manager (REPL-style persistent scope) ---
  const scopeManagerRef = useRef<ScopeManager | null>(null);
  const hydratePromiseRef = useRef<Promise<HydrateResult> | null>(null);
  if (!scopeManagerRef.current && channelName) {
    scopeManagerRef.current = new ScopeManager({
      channelId: channelName,
      panelId: config.clientId,
      persistence: new RpcScopePersistence(sandbox.rpc),
    });
  }
  // Hydration + lifecycle hooks (declared BEFORE connect effect so it fires first)
  useEffect(() => {
    const mgr = scopeManagerRef.current;
    if (!mgr) return;
    hydratePromiseRef.current = mgr.hydrate();
    const onUnload = () => {
      if (mgr.isDirty)
        mgr.persist().catch((err) => console.warn("[Chat] Scope persist on unload failed:", err));
    };
    const onHidden = () => {
      if (document.hidden && mgr.isDirty)
        mgr.persist().catch((err) => console.warn("[Chat] Scope persist on hidden failed:", err));
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onHidden);
      mgr.dispose();
    };
  }, []);
  // --- Core (Pi-native: messages from snapshots, no event reducer) ---
  const core = useChatCore({
    config,
    channelName,
    channelConfig,
    contextId,
    metadata,
    theme,
    initialPrompt,
  });
  const publishTypedAgenticEvent = useCallback(
    async (
      event: AgenticEvent,
      options?: { idempotencyKey?: string }
    ): Promise<number | undefined> => {
      const client = core.clientRef.current;
      if (!client) return undefined;
      return client.publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
        idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
      });
    },
    [core.clientRef]
  );
  // --- Mirror session-owned pending agents when provided ---
  useEffect(() => {
    if (pendingAgentInfos === undefined) return;
    core.setPendingAgentInfos(pendingAgentInfos);
  }, [pendingAgentInfos, core.setPendingAgentInfos]);
  // --- Build chat sandbox value (stale-ref safe — dereferences clientRef at call time) ---
  const chat: ChatSandboxValue = useMemo(
    () => ({
      send: (content: string, opts?: { idempotencyKey?: string }) => {
        return core.clientRef
          .current!.send(content, {
            idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID(),
          })
          .then((result) => result.pubsubId) as Promise<unknown>;
      },
      publish: (
        eventType: string,
        payload: unknown,
        opts?: {
          idempotencyKey?: string;
        }
      ) => {
        return core.clientRef.current!.publish(eventType, payload, {
          ...opts,
          idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID(),
        }) as Promise<unknown>;
      },
      publishCustomMessage: (input, opts) => {
        return core.clientRef.current!.publishCustomMessage(input, {
          idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID(),
        });
      },
      updateCustomMessage: (messageId, update, opts) => {
        return core.clientRef.current!.updateCustomMessage(messageId, update, {
          idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID(),
        });
      },
      callMethod: async (
        pid: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = core.clientRef.current!.callMethod(pid, method, callArgs, options);
        const result = await waitForMethodHandle(
          handle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
        return unwrapChatMethodResult(result);
      },
      callMethodResult: async (
        pid: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = core.clientRef.current!.callMethod(pid, method, callArgs, options);
        return waitForMethodHandle(
          handle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
      },
      participantByHandle: (rawHandle: string) => {
        const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
        const roster = core.clientRef.current?.roster ?? {};
        return (
          Object.values(roster).find((participant) => {
            const metadataHandle = participant.metadata?.handle;
            return typeof metadataHandle === "string" && metadataHandle === handle;
          }) ?? null
        );
      },
      callMethodByHandle: async (
        rawHandle: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
        const roster = core.clientRef.current?.roster ?? {};
        const participant = Object.values(roster).find((item) => item.metadata?.handle === handle);
        if (!participant) throw new Error(`No participant with handle @${handle}`);
        const methodHandle = core.clientRef.current!.callMethod(
          participant.id,
          method,
          callArgs,
          options
        );
        const result = await waitForMethodHandle(
          methodHandle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
        return unwrapChatMethodResult(result);
      },
      callMethodResultByHandle: async (
        rawHandle: string,
        method: string,
        callArgs: unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal }
      ) => {
        const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
        const roster = core.clientRef.current?.roster ?? {};
        const participant = Object.values(roster).find((item) => item.metadata?.handle === handle);
        if (!participant) throw new Error(`No participant with handle @${handle}`);
        const methodHandle = core.clientRef.current!.callMethod(
          participant.id,
          method,
          callArgs,
          options
        );
        return waitForMethodHandle(
          methodHandle as {
            result: Promise<ChatMethodResult>;
            cancel?: () => Promise<void>;
          },
          options
        );
      },
      contextId: contextId ?? "",
      channelId: channelName,
      rpc: sandbox.rpc,
    }),
    [contextId, channelName, sandbox.rpc, core.clientRef, metadata, publishTypedAgenticEvent]
  );
  // --- Bound executeSandbox with loadImport wired + scope enter/exit ---
  const boundExecuteSandbox = useCallback(
    async (code: string, opts: SandboxOptions = {}): Promise<SandboxResult> => {
      const mgr = scopeManagerRef.current;
      mgr?.enterEval();
      try {
        return await executeSandbox(code, {
          ...opts,
          loadImport: opts.loadImport ?? sandboxRef.current.loadImport,
          bindings: {
            ...opts.bindings,
            scope: mgr?.current ?? {},
            scopes: mgr?.api ?? {},
          },
        });
      } finally {
        await mgr?.exitEval();
      }
    },
    []
  );
  const loadSourceFile = useCallback(
    (path: string) =>
      sandboxRef.current.rpc.call("main", "fs.readFile", [path, "utf8"]) as Promise<string>,
    []
  );
  const loadImport = useCallback<NonNullable<SandboxOptions["loadImport"]>>(
    (specifier, ref, externals) => sandboxRef.current.loadImport(specifier, ref, externals),
    []
  );
  const feedback = useChatFeedback({
    chat,
    loadImport,
    clientRef: core.clientRef,
    connected: core.connected,
  });
  const scopeProxy = scopeManagerRef.current?.current ?? {};
  const scopesApi = scopeManagerRef.current?.api ?? {
    currentId: "",
    push: async () => "",
    get: async () => null,
    list: async () => [],
    save: async () => {},
  };
  const chatTools = useChatTools({
    clientRef: core.clientRef,
    tools,
    contextId: contextId ?? "",
    executeSandbox: boundExecuteSandbox,
    chat,
    scope: scopeProxy,
    scopes: scopesApi,
  });
  const debug = useChatDebug();
  const inlineUi = useInlineUi({ messages: core.messages, loadSourceFile, loadImport });
  const messageTypes = useMessageTypeRegistry({
    client: core.client,
    messages: core.messages,
    definitions: core.messageTypes,
    loadSourceFile,
    loadImport,
  });
  const [actionBarData, setActionBarData] = useState<ActionBarData | null>(null);
  const actionBar = useActionBar({ data: actionBarData, loadSourceFile, loadImport });
  const lastLoadedActionBarKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const canonical = core.canonicalActionBar;
    if (!canonical?.source) return;
    const next: ActionBarData = {
      id: canonical.id ?? "canonical-action-bar",
      source: canonical.source,
    };
    if (canonical.imports !== undefined) next.imports = canonical.imports;
    if (canonical.props !== undefined) next.props = canonical.props;
    if (canonical.maxHeight !== undefined) next.maxHeight = canonical.maxHeight;
    setActionBarData(next);
    if (canonical.source.type === "file") {
      lastLoadedActionBarKeyRef.current = actionBarLoadKey(
        canonical.source.path,
        canonical.props,
        canonical.maxHeight
      );
    }
  }, [core.canonicalActionBar]);
  const publishActionBarContext = useCallback(
    async (
      action: "loaded" | "cleared",
      payload: {
        id?: string;
        path?: string;
        imports?: Record<string, string>;
        props?: Record<string, unknown>;
        maxHeight?: number;
        ok: boolean;
        error?: string;
        idempotencyKey?: string;
      }
    ) => {
      const client = core.clientRef.current;
      if (!client) return;
      const eventPayload: AgenticEvent<"ui.action_bar.updated">["payload"] = {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        cleared: action === "cleared",
        result: payload.ok ? { ok: true } : { ok: false, error: payload.error },
      };
      if (payload.id !== undefined) eventPayload.id = payload.id;
      if (payload.path !== undefined) eventPayload.source = { type: "file", path: payload.path };
      if (payload.imports !== undefined) eventPayload.imports = payload.imports;
      if (payload.props !== undefined) eventPayload.props = payload.props;
      if (payload.maxHeight !== undefined) eventPayload.maxHeight = payload.maxHeight;
      await publishTypedAgenticEvent(
        {
          kind: "ui.action_bar.updated",
          actor: actorForClient(client.clientId, metadata),
          payload: eventPayload,
          createdAt: new Date().toISOString(),
        },
        {
          idempotencyKey: payload.idempotencyKey ?? `ui:action-bar:${crypto.randomUUID()}`,
        }
      );
    },
    [core.clientRef, metadata, publishTypedAgenticEvent]
  );
  const loadActionBarFromFile = useCallback(
    async ({
      path,
      props,
      maxHeight,
      imports,
      persistStateArgs = true,
      idempotencyKey,
    }: {
      path: string;
      props?: Record<string, unknown>;
      maxHeight?: number;
      imports?: Record<string, string>;
      persistStateArgs?: boolean;
      idempotencyKey?: string;
    }): Promise<
      | {
          ok: true;
          id: string;
        }
      | {
          ok: false;
          error: string;
        }
    > => {
      const trimmedPath = path.trim();
      if (!trimmedPath) return { ok: false, error: "Missing path" };
      try {
        await loadSourceFile(trimmedPath);
        const id = crypto.randomUUID();
        setActionBarData({
          id,
          source: { type: "file", path: trimmedPath },
          imports,
          props,
          maxHeight,
        });
        lastLoadedActionBarKeyRef.current = actionBarLoadKey(trimmedPath, props, maxHeight);
        if (persistStateArgs) {
          await onActionBarFileChange?.({ path: trimmedPath, props, maxHeight });
        }
        await publishActionBarContext("loaded", {
          id,
          path: trimmedPath,
          imports,
          props,
          maxHeight,
          ok: true,
          idempotencyKey,
        });
        return { ok: true, id };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await publishActionBarContext("loaded", {
          path: trimmedPath,
          imports,
          props,
          maxHeight,
          ok: false,
          error,
          idempotencyKey,
        });
        return { ok: false, error };
      }
    },
    [loadSourceFile, onActionBarFileChange, publishActionBarContext]
  );
  const clearActionBar = useCallback(
    async ({
      persistStateArgs = true,
      idempotencyKey,
    }: {
      persistStateArgs?: boolean;
      idempotencyKey?: string;
    } = {}) => {
      setActionBarData(null);
      lastLoadedActionBarKeyRef.current = null;
      if (persistStateArgs) {
        await onActionBarFileChange?.({ path: null });
      }
      await publishActionBarContext("cleared", { ok: true, idempotencyKey });
    },
    [onActionBarFileChange, publishActionBarContext]
  );
  const updateActionBarMaxHeight = useCallback(
    (
      maxHeight: number,
      options?: {
        saveState?: boolean;
      }
    ) => {
      setActionBarData((current) => {
        if (!current) return current;
        const next = { ...current, maxHeight };
        if (options?.saveState !== false && current.source.type === "file") {
          void onActionBarFileChange?.({
            path: current.source.path,
            props: current.props,
            maxHeight,
          });
        }
        return next;
      });
    },
    [onActionBarFileChange]
  );
  useEffect(() => {
    if (!core.connected || !initialActionBarFile) return;
    const loadKey = actionBarLoadKey(
      initialActionBarFile,
      initialActionBarProps,
      initialActionBarMaxHeight
    );
    if (lastLoadedActionBarKeyRef.current === loadKey) return;
    void loadActionBarFromFile({
      path: initialActionBarFile,
      props: initialActionBarProps,
      maxHeight: initialActionBarMaxHeight,
      persistStateArgs: false,
      idempotencyKey: `ui:initial-action-bar:${channelName}:${loadKey}`,
    });
  }, [
    channelName,
    core.connected,
    initialActionBarFile,
    initialActionBarProps,
    initialActionBarMaxHeight,
    loadActionBarFromFile,
  ]);
  // --- Stable refs for connection effect (avoids unstable object deps) ---
  const feedbackRef = useRef(feedback);
  const chatToolsRef = useRef(chatTools);
  feedbackRef.current = feedback;
  chatToolsRef.current = chatTools;
  // --- Connect to channel on mount ---
  useEffect(() => {
    if (!channelName || !config.rpc) return;
    if (core.hasConnectedRef.current) return;
    core.hasConnectedRef.current = true;
    async function doConnect() {
      try {
        const feedbackMethods = feedbackRef.current.buildFeedbackMethods();
        const toolMethods = chatToolsRef.current.buildToolMethods();
        const methods: Record<string, MethodDefinition> = {
          ...feedbackMethods,
          ...toolMethods,
          set_title: {
            description: "Set the conversation title",
            parameters: z.object({ title: z.string().describe("The new title") }),
            execute: async (args: unknown) => {
              const { title } = args as {
                title: string;
              };
              if (!title) return { ok: false, error: "Missing title" };
              document.title = title;
              const warnings: string[] = [];
              try {
                await config.rpc.call("main", "runtime.setTitle", [title, { explicit: true }]);
              } catch (err) {
                warnings.push(err instanceof Error ? err.message : String(err));
                console.warn("[useAgenticChat] runtime.setTitle failed:", err);
              }
              const client = core.clientRef.current;
              if (client) {
                try {
                  // The explicit panel title is set through runtime.setTitle above. Keep the
                  // channel title as shared metadata, but do not let the channel entity drive
                  // the context-based panel-title mirror path.
                  await client.updateChannelConfig({ title, titleExplicit: false });
                } catch (err) {
                  warnings.push(err instanceof Error ? err.message : String(err));
                  console.warn("[useAgenticChat] channel title config update failed:", err);
                }
              }
              return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
            },
          },
          inline_ui: {
            description: `Render a persistent interactive UI component inline in the chat.

**Contrast with other tools:**
- \`eval\`: Agent-triggered side-effects. Runs code immediately, returns result.
- \`inline_ui\`: User-triggered side-effects + rich data presentation. Renders controls/visualizations. Users interact when they choose. Non-blocking.
- \`feedback_form\`/\`feedback_custom\`: Blocks until user responds. Returns data to agent.

**The component receives { props, chat, scope, scopes }:**
- props: data you pass via the props parameter
- scope: REPL scope — shared read+write state that persists across eval calls
- scopes: scope management API — call scopes.save() after modifying scope from component handlers
- chat: full chat API for interacting with the conversation:
  - chat.send(content, options?) — send a visible message to the conversation.
    Example: chat.send("User clicked Deploy")
  - chat.publish(type, payload, options?) — publish a typed non-message event.
  - chat.rpc.call(target, method, ...args) — call runtime services directly.
    Example: chat.rpc.call("main", "fs.readFile", "/src/config.ts")
  - chat.contextId, chat.channelId — current identifiers

**Side effects users can trigger from inline UI:**
- Send messages back to chat (triggers new agent turns)
- Read/write files, query databases, manage workers via chat.rpc
- Copy to clipboard, open links, any browser API

**Lifecycle:** Component starts expanded. Auto-collapses if taller than 400px.
Users can expand/collapse at any time. Persists in chat history.

**Available imports:** react, @radix-ui/themes, @radix-ui/react-icons
You may provide either \`code\` or \`path\`. \`path\` reads a context-relative TSX file, supports static relative imports, and infers bare package imports from the nearest package.json when possible. Use \`imports\` for explicit package versions.
**Must use** \`export default\`

**Example:**
\`\`\`tsx
import { useState } from "react";
import { Button, Flex, Text, Table } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";

export default function App({ props, chat }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(props.data, null, 2));
    setCopied(true);
  };
  return (
    <Flex direction="column" gap="2">
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            {props.columns.map(c => <Table.ColumnHeaderCell key={c}>{c}</Table.ColumnHeaderCell>)}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {props.data.map((row, i) => (
            <Table.Row key={i}>
              {props.columns.map(c => <Table.Cell key={c}>{row[c]}</Table.Cell>)}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Flex gap="2">
        <Button size="1" variant="soft" onClick={handleCopy}>
          {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy as JSON</>}
        </Button>
        <Button size="1" variant="soft" onClick={() => chat.send("User requested data refresh")}>
          Refresh
        </Button>
      </Flex>
    </Flex>
  );
}
\`\`\``,
            parameters: z.object({
              code: z
                .string()
                .optional()
                .describe("TSX source code for the component. Provide either code or path."),
              path: z
                .string()
                .optional()
                .describe(
                  "Context-relative TSX file to render instead of inline code. Supports static relative imports."
                ),
              imports: z
                .record(z.string(), z.string())
                .optional()
                .describe("On-demand package builds. Same semantics as eval imports."),
              props: z
                .record(z.unknown())
                .optional()
                .describe("Props passed to the component as { props }"),
            }),
            execute: async (args: unknown) => {
              const { code, path, imports, props } = args as {
                code?: string;
                path?: string;
                imports?: Record<string, string>;
                props?: Record<string, unknown>;
              };
              const trimmedPath = path?.trim();
              if (trimmedPath) {
                await loadSourceFile(trimmedPath);
              } else if (!code) {
                return { ok: false, error: "Missing code or path" };
              }
              if (imports && Object.keys(imports).length > 0) {
                await executeSandbox("", { imports, loadImport });
              }
              const client = core.clientRef.current;
              if (!client) return { ok: false, error: "Not connected" };
              const id = crypto.randomUUID();
              const source = trimmedPath
                ? { type: "file" as const, path: trimmedPath }
                : { type: "code" as const, code: code! };
              const eventPayload: AgenticEvent<"ui.inline_rendered">["payload"] = {
                protocol: AGENTIC_PROTOCOL_VERSION,
                uiType: "inline",
                id,
                source,
              };
              if (imports !== undefined) eventPayload.imports = imports;
              if (props !== undefined) eventPayload.props = props;
              await publishTypedAgenticEvent(
                {
                  kind: "ui.inline_rendered",
                  actor: actorForClient(client.clientId, metadata),
                  payload: eventPayload,
                  createdAt: new Date().toISOString(),
                },
                { idempotencyKey: `ui:inline:${id}` }
              );
              return { ok: true, id };
            },
          },
          load_action_bar: {
            description: `Load, replace, or clear a compact persistent action bar at the top of this chat panel.

Use this for small always-available controls or status for the current workflow.
The TSX source is read from a file in this panel's current filesystem context.
The loaded component receives { props, chat, scope, scopes }, supports the same
imports as inline_ui, supports static relative imports from the loaded file,
infers bare package imports from the nearest package.json when possible, and
must export default.

Unlike inline_ui, load_action_bar does not add visible chat history. The latest
loaded file replaces any previous action bar for this panel only. Other panels
connected to this channel may be in different filesystem contexts.
Keep it compact; the panel clamps the rendered height to a small scrollable area.
Use package imports available to inline_ui plus relative imports for local helper files.`,
            parameters: z.object({
              path: z
                .string()
                .optional()
                .describe("Context-relative TSX file to load. Required unless clear is true."),
              imports: z
                .record(z.string(), z.string())
                .optional()
                .describe("On-demand package builds. Same semantics as eval imports."),
              props: z
                .record(z.unknown())
                .optional()
                .describe("Props passed to the component as { props }"),
              maxHeight: z
                .number()
                .optional()
                .describe(
                  "Preferred maximum height in pixels. Defaults to 180 and is clamped between 64 and 360."
                ),
              clear: z.boolean().optional().describe("When true, remove the current action bar."),
            }),
            execute: async (args: unknown) => {
              const { path, imports, props, maxHeight, clear } = args as {
                path?: string;
                imports?: Record<string, string>;
                props?: Record<string, unknown>;
                maxHeight?: number;
                clear?: boolean;
              };
              if (clear) {
                await clearActionBar();
                return { ok: true, cleared: true };
              }
              if (!path) return { ok: false, error: "Missing path" };
              return loadActionBarFromFile({ path, imports, props, maxHeight });
            },
          },
          // ui_prompt — serves NatStackExtensionUIContext (select/confirm/input/editor)
          // from workspace/packages/harness. The agent worker forwards extension UI calls
          // via ui_prompt { kind, ...params }; we render them through the
          // existing feedback_form (ActiveFeedbackSchema) machinery and return
          // primitive results (string | boolean | undefined) directly.
          ui_prompt: {
            description:
              "Prompt the panel user for a select/confirm/input/editor response (used by NatStack extension UI bridge).",
            parameters: z
              .object({
                kind: z.enum(["select", "confirm", "input", "editor"]),
                title: z.string(),
                message: z.string().optional(),
                options: z.array(z.string()).optional(),
                placeholder: z.string().optional(),
                prefill: z.string().optional(),
              })
              .passthrough(),
            execute: async (args: unknown, ctx: MethodExecutionContext) => {
              const { kind, title, message, options, placeholder, prefill } = args as {
                kind: "select" | "confirm" | "input" | "editor";
                title: string;
                message?: string;
                options?: string[];
                placeholder?: string;
                prefill?: string;
              };
              // Build FieldDefinition[] and an initial values map based on kind.
              let fields: ActiveFeedbackSchema["fields"];
              let initialValues: ActiveFeedbackSchema["values"] = {};
              let resolveKey: "choice" | "answer" | "value";
              let hideSubmit = false;
              if (kind === "select") {
                const opts = options ?? [];
                resolveKey = "choice";
                fields = [
                  {
                    key: "choice",
                    type: "select",
                    label: title,
                    required: true,
                    options: opts.map((o) => ({ value: o, label: o })),
                    submitOnSelect: true,
                  },
                ];
                hideSubmit = true;
              } else if (kind === "confirm") {
                resolveKey = "answer";
                fields = [
                  ...(message
                    ? ([
                        { key: "__msg", type: "readonly", label: "", default: message },
                      ] as ActiveFeedbackSchema["fields"])
                    : []),
                  {
                    key: "answer",
                    type: "buttonGroup",
                    submitOnSelect: true,
                    buttons: [
                      { value: "no", label: "No", color: "gray" },
                      { value: "yes", label: "Yes", color: "green" },
                    ],
                  },
                ];
                hideSubmit = true;
              } else if (kind === "input") {
                resolveKey = "value";
                fields = [
                  {
                    key: "value",
                    type: "string",
                    label: title,
                    placeholder: placeholder ?? "",
                  },
                ];
              } else {
                // editor — no textarea field type exists in FormRenderer; fall
                // back to a single-line string field. Prefill via default value.
                resolveKey = "value";
                fields = [
                  {
                    key: "value",
                    type: "string",
                    label: title,
                    default: prefill ?? "",
                  },
                ];
              }
              void ctx;
              const fb = feedbackRef.current;
              return new Promise<string | boolean | undefined>((resolve) => {
                let settled = false;
                const finish = (value: string | boolean | undefined, historyResult: unknown) => {
                  if (settled) return;
                  settled = true;
                  fb.removeFeedback(ctx.callId);
                  void historyResult;
                  resolve(value);
                };
                const entry: ActiveFeedbackSchema = {
                  type: "schema",
                  callId: ctx.callId,
                  title,
                  fields,
                  values: initialValues,
                  hideSubmit,
                  createdAt: Date.now(),
                  complete: (result: FeedbackResult) => {
                    if (result.type === "submit") {
                      const values = (result.value ?? {}) as Record<string, unknown>;
                      const raw = values[resolveKey];
                      if (kind === "confirm") {
                        finish(raw === "yes" || raw === true, raw);
                      } else if (kind === "select") {
                        finish(typeof raw === "string" ? raw : undefined, raw);
                      } else {
                        // input or editor
                        finish(typeof raw === "string" ? raw : undefined, raw);
                      }
                    } else if (result.type === "cancel") {
                      finish(kind === "confirm" ? false : undefined, null);
                    } else {
                      finish(kind === "confirm" ? false : undefined, null);
                    }
                  },
                };
                fb.addFeedback(entry);
              });
            },
          },
        };
        await core.connectToChannel({ channelId: channelName, methods, channelConfig, contextId });
        // Scope hydration system message (best-effort — must not poison chat startup)
        let hr: HydrateResult | null = null;
        try {
          hr = await hydratePromiseRef.current;
        } catch (err) {
          console.warn("[Chat] Scope hydration failed:", err);
        }
        if (hr && (hr.restored.length || hr.lost.length || hr.partial.length)) {
          const parts: string[] = [];
          if (hr.restored.length) parts.push(`Restored: [${hr.restored.join(", ")}]`);
          if (hr.partial.length)
            parts.push(`Partially restored (some properties lost): [${hr.partial.join(", ")}]`);
          if (hr.lost.length) parts.push(`Lost (must be re-created): [${hr.lost.join(", ")}]`);
          const hasDegradation = hr.partial.length > 0 || hr.lost.length > 0;
          const hint = hasDegradation
            ? " Functions and class instances don't survive reload — re-create them with eval if needed."
            : "";
          const scopeMsgId = crypto.randomUUID();
          const client = core.clientRef.current!;
          await publishTypedAgenticEvent(
            {
              kind: "message.completed",
              actor: {
                kind: "system",
                id: client.clientId ?? "system",
                displayName: "System",
              },
              causality: { messageId: scopeMsgId as never },
              payload: {
                protocol: AGENTIC_PROTOCOL_VERSION,
                role: "system",
                content: `Scope refreshed (panel session restarted). ${parts.join(". ")}.${hint}`,
              },
              createdAt: new Date().toISOString(),
            },
            { idempotencyKey: `scope_hydrate:${scopeMsgId}` }
          );
        }
      } catch (err) {
        console.error("[Chat] Connection error:", err);
        core.hasConnectedRef.current = false;
      }
    }
    void doConnect();
  }, [
    channelName,
    channelConfig,
    contextId,
    core.connectToChannel,
    config.rpc,
    core.hasConnectedRef,
    core.selfIdRef,
    core.clientRef,
    clearActionBar,
    loadActionBarFromFile,
    metadata,
    publishTypedAgenticEvent,
  ]);
  // --- Wrap platform actions ---
  const handleAddAgent = useCallback(
    async (agentId?: string, config?: AgentSubscriptionConfig) => {
      if (!actions?.onAddAgent) return;
      const launcherContextId = core.clientRef.current?.contextId;
      await actions.onAddAgent(channelName, launcherContextId, agentId, config);
    },
    [channelName, core.clientRef, actions]
  );
  const handleReplaceAgent = useCallback(
    async (participantId: string, agentId?: string, config?: AgentSubscriptionConfig) => {
      if (!actions?.onReplaceAgent) return;
      await actions.onReplaceAgent(channelName, participantId, agentId, config);
    },
    [channelName, actions]
  );
  const handleRemoveAgent = useCallback(
    async (handle: string) => {
      if (!actions?.onRemoveAgent) return;
      await actions.onRemoveAgent(channelName, handle);
    },
    [channelName, actions]
  );
  const handleConnectProvider = useCallback(
    async (
      providerId: string,
      modelBaseUrl: string,
      opts?: { browser?: "internal" | "external" }
    ) => {
      if (!actions?.onConnectProvider) return { ok: false, error: "Connect is not available" };
      return actions.onConnectProvider(providerId, modelBaseUrl, opts);
    },
    [actions]
  );
  const sessionEnabled = true; // Always persistent: transcript state is projected from the durable PubSub log.
  const onAddAgent = actions?.onAddAgent ? handleAddAgent : undefined;
  const onReplaceAgent = actions?.onReplaceAgent ? handleReplaceAgent : undefined;
  const onConnectProvider = actions?.onConnectProvider ? handleConnectProvider : undefined;
  const availableAgents = actions?.availableAgents;
  const modelCatalog = actions?.modelCatalog;
  const connectedModelRefs = actions?.connectedModelRefs;
  const onRemoveAgent = actions?.onRemoveAgent ? handleRemoveAgent : undefined;
  const onFocusPanel = actions?.onFocusPanel;
  const onReloadPanel = actions?.onReloadPanel;
  // --- Assemble context values ---
  const contextValue: ChatContextValue = useMemo(
    () => ({
      connected: core.connected,
      status: core.status,
      channelId: channelName,
      sessionEnabled,
      connectionError: core.connectionError,
      dismissConnectionError: core.dismissConnectionError,
      chat,
      clientRef: core.clientRef,
      scope: scopeProxy,
      scopes: scopesApi,
      scopeManager: scopeManagerRef.current,
      messages: core.messages,
      inlineUiComponents: inlineUi.inlineUiComponents,
      messageTypeComponents: messageTypes.messageTypeComponents,
      actionBar: actionBar.actionBar,
      onActionBarMaxHeightChange: updateActionBarMaxHeight,
      hasMoreHistory: core.hasMoreHistory,
      loadingMore: core.loadingMore,
      selfId: core.selfId,
      participants: core.participants,
      allParticipants: core.allParticipants,
      debugEvents: core.debugEvents,
      debugConsoleAgent: debug.debugConsoleAgent,
      dirtyRepoWarnings: core.dirtyRepoWarnings,
      pendingAgents: core.pendingAgents,
      activeFeedbacks: feedback.activeFeedbacks,
      theme,
      onLoadEarlierMessages: core.loadEarlierMessages,
      onInterrupt: core.handleInterruptAgent,
      onCancelInvocation: core.handleCancelInvocation,
      onCallMethod: core.handleCallMethod,
      onCallMethodResult: core.handleCallMethodResult,
      onFeedbackDismiss: feedback.onFeedbackDismiss,
      onFeedbackError: feedback.onFeedbackError,
      onDebugConsoleChange: debug.setDebugConsoleAgent,
      onDismissDirtyWarning: core.onDismissDirtyWarning,
      onAddAgent,
      onReplaceAgent,
      onConnectProvider,
      availableAgents,
      modelCatalog,
      connectedModelRefs,
      onRemoveAgent,
      onFocusPanel,
      onReloadPanel,
      toolApproval: chatTools.toolApprovalValue,
    }),
    [
      core.connected,
      core.status,
      core.connectionError,
      core.dismissConnectionError,
      channelName,
      sessionEnabled,
      chat,
      core.clientRef,
      core.messages,
      inlineUi.inlineUiComponents,
      messageTypes.messageTypeComponents,
      actionBar.actionBar,
      updateActionBarMaxHeight,
      core.hasMoreHistory,
      core.loadingMore,
      core.participants,
      core.allParticipants,
      core.debugEvents,
      debug.debugConsoleAgent,
      core.dirtyRepoWarnings,
      core.pendingAgents,
      feedback.activeFeedbacks,
      theme,
      core.loadEarlierMessages,
      core.handleInterruptAgent,
      core.handleCallMethod,
      core.handleCallMethodResult,
      feedback.onFeedbackDismiss,
      feedback.onFeedbackError,
      debug.setDebugConsoleAgent,
      core.onDismissDirtyWarning,
      onAddAgent,
      onReplaceAgent,
      onConnectProvider,
      availableAgents,
      modelCatalog,
      connectedModelRefs,
      onRemoveAgent,
      onFocusPanel,
      onReloadPanel,
      chatTools.toolApprovalValue,
    ]
  );
  return { contextValue, inputContextValue: core.inputContextValue };
}
