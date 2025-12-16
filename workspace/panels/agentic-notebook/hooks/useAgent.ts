import { useCallback, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useStore } from "jotai";
import { AgentSession, type ChannelAdapter } from "../agent/AgentSession";
import {
  agentAtom,
  isStreamingAtom,
  modelRoleAtom,
} from "../state/agentAtoms";
import {
  messagesAtom,
  sendMessageAtom,
  appendToMessageAtom,
  finishStreamingAtom,
  updateToolStatusAtom,
  startGenerationAtom,
  setStreamingAtom,
  endGenerationAtom,
  abortGenerationAtom,
} from "../state";
import type { ChannelMessage } from "../types/messages";

/**
 * Create a channel adapter that bridges AgentSession to Jotai atoms.
 * Uses the Jotai store directly to avoid stale closures.
 */
function createChannelAdapter(store: ReturnType<typeof useStore>): ChannelAdapter {
  return {
    getMessages(): ChannelMessage[] {
      return store.get(messagesAtom);
    },

    sendMessage(message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">): string {
      // sendMessageAtom always returns a string for "send" action
      return store.set(sendMessageAtom, message) as string;
    },

    appendToMessage(messageId: string, delta: string): void {
      store.set(appendToMessageAtom, { messageId, delta });
    },

    finishStreaming(messageId: string): void {
      store.set(finishStreamingAtom, messageId);
    },

    updateToolStatus(messageId: string, status: ChannelMessage["toolStatus"]): void {
      store.set(updateToolStatusAtom, { messageId, status });
    },

    startGeneration(participantId: string): AbortController {
      return store.set(startGenerationAtom, participantId);
    },

    setStreaming(): void {
      store.set(setStreamingAtom);
    },

    endGeneration(): void {
      store.set(endGenerationAtom);
    },

    abortGeneration(): void {
      store.set(abortGenerationAtom);
    },
  };
}

/**
 * Hook for managing the agent.
 */
export function useAgent() {
  const [agent, setAgent] = useAtom(agentAtom);
  const store = useStore();
  const [isStreaming, setIsStreaming] = useAtom(isStreamingAtom);
  const [modelRole, setModelRole] = useAtom(modelRoleAtom);

  // Keep adapter ref stable across renders
  const adapterRef = useRef<ChannelAdapter | null>(null);
  if (!adapterRef.current) {
    adapterRef.current = createChannelAdapter(store);
  }

  // Initialize agent
  const initializeAgent = useCallback(
    async () => {
      const session = new AgentSession({
        adapter: adapterRef.current!,
        modelRole,
        participantId: "agent",
      });

      await session.initialize();

      // Register tools
      session.registerFileTools();
      session.registerEvalTools();
      session.registerMDXTools();

      setAgent(session);
      return session;
    },
    [modelRole, setAgent]
  );

  // Generate response
  const generate = useCallback(async () => {
    if (!agent) {
      throw new Error("Agent not initialized");
    }

    setIsStreaming(true);
    try {
      await agent.streamGenerate();
    } finally {
      setIsStreaming(false);
    }
  }, [agent, setIsStreaming]);

  // Abort generation
  const abort = useCallback(() => {
    agent?.abort();
    setIsStreaming(false);
  }, [agent, setIsStreaming]);

  // Change model role
  const changeModelRole = useCallback(
    async (role: string) => {
      setModelRole(role);
      if (agent) {
        await agent.setModelRole(role);
      }
    },
    [agent, setModelRole]
  );

  // Destroy agent
  const destroy = useCallback(() => {
    if (agent) {
      agent.destroy();
      setAgent(null);
    }
  }, [agent, setAgent]);

  return {
    agent,
    isStreaming,
    modelRole,
    initializeAgent,
    generate,
    abort,
    changeModelRole,
    destroy,
  };
}

/**
 * Hook for getting streaming state.
 */
export function useIsStreaming(): boolean {
  return useAtomValue(isStreamingAtom);
}

/**
 * Hook for getting/setting model role.
 */
export function useModelRole() {
  return useAtom(modelRoleAtom);
}
