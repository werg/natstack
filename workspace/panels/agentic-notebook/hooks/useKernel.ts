import { useCallback, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useStore } from "jotai";
import { KernelManager, type KernelChannelAdapter } from "../kernel/KernelManager";
import {
  kernelAtom,
  kernelExecutionCountAtom,
  kernelExecutingAtom,
} from "../state/kernelAtoms";
import {
  sendMessageAtom,
  participantsAtom,
} from "../state";
import type { CellResult } from "../kernel/KernelManager";
import type { CodeLanguage } from "../types/messages";

/**
 * Create a KernelChannelAdapter that bridges to Jotai atoms.
 */
function createKernelChannelAdapter(store: ReturnType<typeof useStore>): KernelChannelAdapter {
  return {
    sendMessage(message) {
      return store.set(sendMessageAtom, message);
    },
    getAgentId() {
      const participants = store.get(participantsAtom);
      for (const [id, participant] of participants) {
        if (participant.type === "agent") {
          return id;
        }
      }
      return "agent";
    },
  };
}

/**
 * Hook for managing the kernel.
 */
export function useKernel() {
  const [kernel, setKernel] = useAtom(kernelAtom);
  const store = useStore();
  const [executionCount, setExecutionCount] = useAtom(kernelExecutionCountAtom);
  const [isExecuting, setIsExecuting] = useAtom(kernelExecutingAtom);
  const [isReady, setIsReady] = useState(false);

  // Initialize kernel
  const initializeKernel = useCallback(
    async (fs?: import("../storage/ChatStore").FileSystem) => {
      const channelAdapter = createKernelChannelAdapter(store);

      const manager = new KernelManager({
        channel: channelAdapter,
        participantId: "kernel",
      });

      await manager.initialize();
      if (fs) {
        manager.injectFileSystemBindings(fs);
      }
      setKernel(manager);
      setIsReady(true);

      return manager;
    },
    [store, setKernel]
  );

  // Execute code
  const execute = useCallback(
    async (code: string): Promise<CellResult> => {
      if (!kernel) {
        throw new Error("Kernel not initialized");
      }

      setIsExecuting(true);
      try {
        const result = await kernel.execute(code);
        setExecutionCount((c) => c + 1);
        return result;
      } finally {
        setIsExecuting(false);
      }
    },
    [kernel, setIsExecuting, setExecutionCount]
  );

  // Execute code from user (sends messages to channel)
  const executeFromUser = useCallback(
    async (
      code: string,
      language: CodeLanguage,
      userId: string
    ): Promise<CellResult> => {
      if (!kernel) {
        throw new Error("Kernel not initialized");
      }

      setIsExecuting(true);
      try {
        const result = await kernel.executeFromUser(code, language, userId);
        setExecutionCount((c) => c + 1);
        return result;
      } finally {
        setIsExecuting(false);
      }
    },
    [kernel, setIsExecuting, setExecutionCount]
  );

  // Reset kernel
  const reset = useCallback(
    (keepBindings?: string[]) => {
      if (!kernel) return;
      kernel.reset(keepBindings);
      setExecutionCount(0);
    },
    [kernel, setExecutionCount]
  );

  // Get scope
  const getScope = useCallback(() => {
    return kernel?.getScope() ?? {};
  }, [kernel]);

  // Destroy kernel
  const destroy = useCallback(() => {
    if (kernel) {
      kernel.destroy();
      setKernel(null);
      setIsReady(false);
    }
  }, [kernel, setKernel]);

  return {
    kernel,
    isReady,
    isExecuting,
    executionCount,
    initializeKernel,
    execute,
    executeFromUser,
    reset,
    getScope,
    destroy,
  };
}

/**
 * Hook for getting kernel ready state.
 */
export function useKernelReady(): boolean {
  const kernel = useAtomValue(kernelAtom);
  return kernel?.isReady() ?? false;
}

/**
 * Hook for getting kernel execution count.
 */
export function useKernelExecutionCount(): number {
  return useAtomValue(kernelExecutionCountAtom);
}

/**
 * Hook for getting kernel executing state.
 */
export function useKernelExecuting(): boolean {
  return useAtomValue(kernelExecutingAtom);
}
