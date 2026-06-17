/**
 * Panel-side `eval` tool — the method Spectrolite advertises on the
 * channel so resident agents can execute sandboxed JS with channel access.
 *
 * Extracted from the old Workspace component: the sandbox config, scope
 * manager, and ChatSandboxValue are built ONCE per session here, with
 * live values (client, frontmatter deps) read through getters so the
 * tool never needs rebuilding — and therefore never forces a channel
 * reconnect — while the panel runs.
 */

import { rpc } from "@workspace/runtime";
import type { PubSubClient } from "@workspace/pubsub";
import {
  buildEvalTool,
  createPanelSandboxConfig,
  unwrapChatMethodResult,
  type ChatParticipantMetadata,
  type ChatMethodResult,
  type ChatSandboxValue,
  type SandboxConfig,
} from "@workspace/agentic-core";
import {
  executeSandbox,
  RpcScopePersistence,
  ScopeManager,
  type SandboxOptions,
  type SandboxResult,
} from "@workspace/eval";
import { prefetchDependencies } from "../mdx/depPrefetch";

export interface EvalRuntime {
  evalTool: ReturnType<typeof buildEvalTool>;
  sandbox: SandboxConfig;
  /** Prefetch frontmatter-declared deps into the sandbox module map. */
  prefetch(deps: Record<string, string>): Promise<void>;
  dispose(): void;
}

export interface EvalRuntimeOptions {
  channelName: string;
  contextId: string;
  panelId: string;
  getClient(): PubSubClient<ChatParticipantMetadata> | null;
  /** Active doc's frontmatter deps, merged into every eval call's imports. */
  getDeps(): Record<string, string>;
}

type MethodHandle = { result: Promise<ChatMethodResult> };

export function createEvalRuntime(opts: EvalRuntimeOptions): EvalRuntime {
  const sandbox: SandboxConfig = createPanelSandboxConfig(rpc);
  const scopeManager = new ScopeManager({
    channelId: opts.channelName,
    panelId: opts.panelId,
    persistence: new RpcScopePersistence(
      rpc as unknown as { call(targetId: string, method: string, ...args: unknown[]): Promise<unknown> },
    ),
  });

  const requireClient = (): PubSubClient<ChatParticipantMetadata> => {
    const client = opts.getClient();
    if (!client) throw new Error("Channel client not ready");
    return client;
  };

  const callMethod = (pid: string, method: string, callArgs: unknown): Promise<ChatMethodResult> => {
    const handle = requireClient().callMethod(pid, method, callArgs);
    return (handle as unknown as MethodHandle).result;
  };

  const findByHandle = (rawHandle: string) => {
    const handle = rawHandle.startsWith("@") ? rawHandle.slice(1) : rawHandle;
    const roster = opts.getClient()?.roster ?? {};
    return Object.values(roster).find((participant) => participant.metadata?.["handle"] === handle) ?? null;
  };

  const chatSandboxValue: ChatSandboxValue = {
    // Spectrolite's eval has no chat transcript DOM to scroll.
    focusMessage: async () => false,
    publish: async (eventType, payload, options) => {
      const client = opts.getClient();
      return client ? client.publish(eventType, payload, options) : undefined;
    },
    send: async (content, options) => {
      const client = opts.getClient();
      return client ? client.send(content, options) : undefined;
    },
    publishCustomMessage: async (input, options) => requireClient().publishCustomMessage(input, options),
    updateCustomMessage: async (messageId, update, options) => requireClient().updateCustomMessage(messageId, update, options),
    registerMessageType: async (input, options) => requireClient().registerMessageType(input, options),
    clearMessageType: async (typeId, options) => requireClient().clearMessageType(typeId, options),
    getMessageType: async (typeId) => requireClient().getMessageType(typeId),
    getMessageTypes: async () => requireClient().getMessageTypes(),
    callMethod: async (pid, method, callArgs) => unwrapChatMethodResult(await callMethod(pid, method, callArgs)),
    callMethodResult: async (pid, method, callArgs) => callMethod(pid, method, callArgs),
    participantByHandle: (rawHandle) => findByHandle(rawHandle),
    callMethodByHandle: async (rawHandle, method, callArgs) => {
      const participant = findByHandle(rawHandle);
      if (!participant) throw new Error(`No participant with handle @${rawHandle.replace(/^@/, "")}`);
      return unwrapChatMethodResult(await callMethod(participant.id, method, callArgs));
    },
    callMethodResultByHandle: async (rawHandle, method, callArgs) => {
      const participant = findByHandle(rawHandle);
      if (!participant) throw new Error(`No participant with handle @${rawHandle.replace(/^@/, "")}`);
      return callMethod(participant.id, method, callArgs);
    },
    contextId: opts.contextId,
    channelId: opts.channelName,
    rpc: sandbox.rpc,
  };

  // Wrap executeSandbox with scope lifecycle hooks so REPL state persists
  // across eval calls, and merge the active doc's frontmatter dependencies
  // into per-call imports so the agent doesn't need to redeclare them.
  const wrappedExecuteSandbox = async (code: string, sandboxOpts: SandboxOptions = {}): Promise<SandboxResult> => {
    scopeManager.enterEval();
    try {
      const mergedImports = { ...opts.getDeps(), ...(sandboxOpts.imports ?? {}) };
      return await executeSandbox(code, {
        ...sandboxOpts,
        imports: Object.keys(mergedImports).length > 0 ? mergedImports : sandboxOpts.imports,
      });
    } finally {
      await scopeManager.exitEval();
    }
  };

  const evalTool = buildEvalTool({
    sandbox,
    rpc: sandbox.rpc,
    runtimeTarget: "panel",
    scopeManager,
    executeSandbox: wrappedExecuteSandbox,
    getChatSandboxValue: () => chatSandboxValue,
    getScope: () => scopeManager.current,
  });

  return {
    evalTool,
    sandbox,
    prefetch: (deps) => prefetchDependencies(sandbox, deps, (line) => { console.info(line); }),
    dispose: () => { scopeManager.dispose?.(); },
  };
}
