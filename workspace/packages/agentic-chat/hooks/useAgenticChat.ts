/**
 * useAgenticChat — Thin composer hook.
 *
 * Composes useChatCore + feature hooks (pending agents, feedback, tools,
 * debug, inline UI) into the full ChatContextValue.
 *
 * Roster tracking, pending agent timeouts, debug events, and dirty repo
 * warnings are now handled by SessionManager via useChatCore — the feature
 * hooks are retained as stubs for backward compatibility only.
 *
 * For minimal chat (no tools, no feedback, no debug), use useChatCore directly.
 */

import { useCallback, useMemo, useRef, useEffect } from "react";
import { z } from "zod";
import type { ChannelConfig, MethodDefinition, MethodExecutionContext } from "@natstack/pubsub";
import { executeSandbox, ScopeManager, DbScopePersistence } from "@workspace/eval";
import type { SandboxOptions, SandboxResult, HydrateResult } from "@workspace/eval";
import type { ActiveFeedbackSchema, FeedbackResult } from "@workspace/tool-ui";
import { useChatCore } from "./core/useChatCore";
import { useChatFeedback } from "./features/useChatFeedback";
import { useChatTools } from "./features/useChatTools";
import { useChatDebug } from "./features/useChatDebug";
import { useInlineUi } from "./features/useInlineUi";
import type {
  ConnectionConfig,
  AgenticChatActions,
  ToolProvider,
  SandboxConfig,
  ChatSandboxValue,
  ChatParticipantMetadata,
  ChatContextValue,
  ChatInputContextValue,
} from "../types";

/** Pending agent info passed from launcher */
interface PendingAgentInfo {
  agentId: string;
  handle: string;
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
}: UseAgenticChatOptions): { contextValue: ChatContextValue; inputContextValue: ChatInputContextValue } {
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
      persistence: new DbScopePersistence(() => sandbox.db.open("repl-scopes")),
    });
  }

  // Hydration + lifecycle hooks (declared BEFORE connect effect so it fires first)
  useEffect(() => {
    const mgr = scopeManagerRef.current;
    if (!mgr) return;
    hydratePromiseRef.current = mgr.hydrate();
    const onUnload = () => { if (mgr.isDirty) mgr.persist().catch((err) => console.warn("[Chat] Scope persist on unload failed:", err)); };
    const onHidden = () => { if (document.hidden && mgr.isDirty) mgr.persist().catch((err) => console.warn("[Chat] Scope persist on hidden failed:", err)); };
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

  // --- Seed pending agents into SessionManager when they arrive ---
  useEffect(() => {
    if (!pendingAgentInfos?.length) return;
    for (const agent of pendingAgentInfos) {
      core.addPendingAgent(agent.handle, agent.agentId);
    }
  }, [pendingAgentInfos, core.addPendingAgent]);

  // --- Build chat sandbox value (stale-ref safe — dereferences clientRef at call time) ---
  const chat: ChatSandboxValue = useMemo(() => ({
    publish: (eventType: string, payload: unknown, opts?: { persist?: boolean; idempotencyKey?: string }) => {
      // Auto-generate id for message payloads (required by PubSub protocol)
      if (eventType === "message" && typeof payload === "object" && payload !== null && !("id" in payload)) {
        (payload as Record<string, unknown>)["id"] = crypto.randomUUID();
      }
      return core.clientRef.current!.publish(eventType, payload, {
        ...opts,
        idempotencyKey: opts?.idempotencyKey ?? crypto.randomUUID(),
      }) as Promise<unknown>;
    },
    callMethod: async (pid: string, method: string, callArgs: unknown) => {
      const handle = core.clientRef.current!.callMethod(pid, method, callArgs);
      return (handle as { result: Promise<unknown> }).result;
    },
    contextId: contextId ?? "",
    channelId: channelName,
    rpc: sandbox.rpc,
  }), [contextId, channelName, sandbox.rpc]);

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
    [],
  );

  const feedback = useChatFeedback({
    addMethodHistoryEntry: core.addMethodHistoryEntry,
    updateMethodHistoryEntry: core.updateMethodHistoryEntry,
    chat,
  });

  const scopeProxy = scopeManagerRef.current?.current ?? {};
  const scopesApi = scopeManagerRef.current?.api ?? { currentId: "", push: async () => "", get: async () => null, list: async () => [], save: async () => {} };

  const chatTools = useChatTools({
    clientRef: core.clientRef,
    tools,
    addFeedback: feedback.addFeedback,
    removeFeedback: feedback.removeFeedback,
    contextId: contextId ?? "",
    executeSandbox: boundExecuteSandbox,
    chat,
    scope: scopeProxy,
    scopes: scopesApi,
  });

  const debug = useChatDebug();

  const inlineUi = useInlineUi({ messages: core.messages });

  // --- Stable refs for connection effect (avoids unstable object deps) ---
  const feedbackRef = useRef(feedback);
  const chatToolsRef = useRef(chatTools);
  feedbackRef.current = feedback;
  chatToolsRef.current = chatTools;

  // --- Connect to channel on mount ---
  useEffect(() => {
    if (!channelName || !config.serverUrl) return;
    if (core.hasConnectedRef.current) return;
    core.hasConnectedRef.current = true;

    async function doConnect() {
      try {
        const feedbackMethods = feedbackRef.current.buildFeedbackMethods();
        const toolMethods = chatToolsRef.current.buildToolMethods();
        const approvalMethod = chatToolsRef.current.buildApprovalMethod();

        const methods: Record<string, MethodDefinition> = {
          ...feedbackMethods,
          ...toolMethods,
          ...approvalMethod,
          set_title: {
            description: "Set the conversation title",
            parameters: z.object({ title: z.string().describe("The new title") }),
            execute: async (args: unknown) => {
              const { title } = args as { title: string };
              if (!title) return { ok: false, error: "Missing title" };
              document.title = title;
              const client = core.clientRef.current;
              if (client) {
                try { await client.updateChannelConfig({ title }); } catch { /* best-effort */ }
              }
              return { ok: true };
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
  - chat.publish(type, payload, options?) — send a message to the conversation.
    Example: chat.publish("message", { content: "User clicked Deploy" })
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
    setTimeout(() => setCopied(false), 2000);
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
        <Button size="1" variant="soft" onClick={() => chat.publish("message", { content: "User requested data refresh" })}>
          Refresh
        </Button>
      </Flex>
    </Flex>
  );
}
\`\`\``,
            parameters: z.object({
              code: z.string().describe("TSX source code for the component"),
              props: z.record(z.unknown()).optional().describe("Props passed to the component as { props }"),
            }),
            execute: async (args: unknown) => {
              const { code, props } = args as { code: string; props?: Record<string, unknown> };
              if (!code) return { ok: false, error: "Missing code" };
              const client = core.clientRef.current;
              if (!client) return { ok: false, error: "Not connected" };
              const id = crypto.randomUUID();
              const data = JSON.stringify({ id, code, props });
              await client.publish("message", { id, content: data, contentType: "inline_ui" }, { persist: true, idempotencyKey: `inline_ui:${id}` });
              return { ok: true, id };
            },
          },
          // ui_prompt — serves NatStackExtensionUIContext (select/confirm/input/editor)
          // from packages/harness. The agent worker forwards extension UI calls
          // via ui_prompt { kind, ...params }; we render them through the
          // existing feedback_form (ActiveFeedbackSchema) machinery and return
          // primitive results (string | boolean | undefined) directly.
          ui_prompt: {
            description: "Prompt the panel user for a select/confirm/input/editor response (used by NatStack extension UI bridge).",
            parameters: z.object({
              kind: z.enum(["select", "confirm", "input", "editor"]),
              title: z.string(),
              message: z.string().optional(),
              options: z.array(z.string()).optional(),
              placeholder: z.string().optional(),
              prefill: z.string().optional(),
            }).passthrough(),
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
                    ? ([{ key: "__msg", type: "readonly", label: "", default: message }] as ActiveFeedbackSchema["fields"])
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

              // Track in method history (best-effort, for observability).
              const coreRef = core;
              coreRef.addMethodHistoryEntry({
                callId: ctx.callId,
                methodName: "ui_prompt",
                description: `Extension UI prompt (${kind})`,
                args,
                status: "pending",
                startedAt: Date.now(),
                callerId: ctx.callerId,
                handledLocally: true,
              });

              const fb = feedbackRef.current;

              return new Promise<string | boolean | undefined>((resolve) => {
                let settled = false;
                const finish = (value: string | boolean | undefined, historyResult: unknown) => {
                  if (settled) return;
                  settled = true;
                  fb.removeFeedback(ctx.callId);
                  coreRef.updateMethodHistoryEntry(ctx.callId, {
                    status: "success",
                    result: historyResult,
                    completedAt: Date.now(),
                  });
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
        core.selfIdRef.current = core.clientRef.current?.clientId ?? null;

        // Scope hydration system message (best-effort — must not poison chat startup)
        let hr: HydrateResult | null = null;
        try { hr = await hydratePromiseRef.current; }
        catch (err) { console.warn("[Chat] Scope hydration failed:", err); }
        if (hr && (hr.restored.length || hr.lost.length || hr.partial.length)) {
          const parts: string[] = [];
          if (hr.restored.length) parts.push(`Restored: [${hr.restored.join(", ")}]`);
          if (hr.partial.length) parts.push(`Partially restored (some properties lost): [${hr.partial.join(", ")}]`);
          if (hr.lost.length) parts.push(`Lost (must be re-created): [${hr.lost.join(", ")}]`);
          const hasDegradation = hr.partial.length > 0 || hr.lost.length > 0;
          const hint = hasDegradation ? " Functions and class instances don't survive reload — re-create them with eval if needed." : "";
          const scopeMsgId = crypto.randomUUID();
          core.clientRef.current!.publish("message", {
            id: scopeMsgId,
            content: `Scope refreshed (panel session restarted). ${parts.join(". ")}.${hint}`,
            kind: "system",
          }, { persist: true, idempotencyKey: `scope_hydrate:${scopeMsgId}` });
        }
      } catch (err) {
        console.error("[Chat] Connection error:", err);
        core.hasConnectedRef.current = false;
      }
    }

    void doConnect();
  }, [channelName, channelConfig, contextId, core.connectToChannel, config.serverUrl, core.hasConnectedRef, core.selfIdRef, core.clientRef]);

  // --- Wrap platform actions ---
  const handleAddAgent = useCallback(async (agentId?: string) => {
    if (!actions?.onAddAgent) return;
    const launcherContextId = core.clientRef.current?.contextId;
    const result = await actions.onAddAgent(channelName, launcherContextId, agentId);
    // If the callback returns agent info, track it as pending via SessionManager
    if (result?.agentId && result?.handle) {
      core.addPendingAgent(result.handle, result.agentId);
    }
  }, [channelName, core.clientRef, actions, core.addPendingAgent]);

  const handleRemoveAgent = useCallback(async (handle: string) => {
    if (!actions?.onRemoveAgent) return;
    await actions.onRemoveAgent(channelName, handle);
  }, [channelName, actions]);

  const sessionEnabled = true; // Always persistent — messages stored in PubSub messageStore
  const onAddAgent = actions?.onAddAgent ? handleAddAgent : undefined;
  const availableAgents = actions?.availableAgents;
  const onRemoveAgent = actions?.onRemoveAgent ? handleRemoveAgent : undefined;
  const onFocusPanel = actions?.onFocusPanel;
  const onReloadPanel = actions?.onReloadPanel;

  // --- Assemble context values ---
  const contextValue: ChatContextValue = useMemo(() => ({
    connected: core.connected,
    status: core.status,
    channelId: channelName,
    sessionEnabled,
    chat,
    scope: scopeProxy,
    scopes: scopesApi,
    scopeManager: scopeManagerRef.current,
    messages: core.messages,
    methodEntries: core.methodEntries,
    inlineUiComponents: inlineUi.inlineUiComponents,
    hasMoreHistory: core.hasMoreHistory,
    loadingMore: core.loadingMore,
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
    onCallMethod: core.handleCallMethod,
    onFeedbackDismiss: feedback.onFeedbackDismiss,
    onFeedbackError: feedback.onFeedbackError,
    onDebugConsoleChange: debug.setDebugConsoleAgent,
    onDismissDirtyWarning: core.onDismissDirtyWarning,
    onAddAgent,
    availableAgents,
    onRemoveAgent,
    onFocusPanel,
    onReloadPanel,
    toolApproval: chatTools.toolApprovalValue,
  }), [
    core.connected, core.status, channelName, sessionEnabled, chat,
    core.messages, core.methodEntries, inlineUi.inlineUiComponents, core.hasMoreHistory, core.loadingMore,
    core.participants, core.allParticipants,
    core.debugEvents, debug.debugConsoleAgent, core.dirtyRepoWarnings, core.pendingAgents,
    feedback.activeFeedbacks, theme,
    core.loadEarlierMessages, core.handleInterruptAgent, core.handleCallMethod,
    feedback.onFeedbackDismiss, feedback.onFeedbackError, debug.setDebugConsoleAgent, core.onDismissDirtyWarning,
    onAddAgent, availableAgents, onRemoveAgent, onFocusPanel, onReloadPanel,
    chatTools.toolApprovalValue,
  ]);

  return { contextValue, inputContextValue: core.inputContextValue };
}
