/**
 * Diagnostics hook for type checking integration.
 *
 * Creates a TypeCheckWatcher on mount and provides diagnostics state
 * that updates as files change. Optionally connects to a PubSub channel
 * to receive and publish diagnostics.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  TypeCheckWatcher,
  createOpfsFileSource,
  createTypeDefinitionClient,
} from "@natstack/runtime/typecheck";
import { fs, rpc, normalizePath } from "@natstack/runtime";
import { resultToDiagnostics, type Diagnostic } from "../types";
import { useDiagnosticsChannel } from "./useDiagnosticsChannel";

export interface UseDiagnosticsResult {
  /** All diagnostics across all files (merged local + remote) */
  all: Diagnostic[];
  /** Get diagnostics for a specific file */
  forFile: (filePath: string | null) => Diagnostic[];
  /** Notify watcher of a file update */
  updateFile: (filePath: string, content: string) => void;
  /** Error count */
  errorCount: number;
  /** Warning count */
  warningCount: number;
  /** Whether the type checker is initializing */
  isInitializing: boolean;
  /** Error message if initialization failed */
  initError: string | null;
  /** Whether connected to a diagnostics channel */
  channelConnected: boolean;
  /** Channel connection error if any */
  channelError: string | null;
}

/**
 * Hook for managing type check diagnostics.
 *
 * @param workspacePath - The workspace path to type check
 * @param channelId - Optional PubSub channel to receive/publish diagnostics
 */
export function useDiagnostics(
  workspacePath: string,
  channelId?: string | null
): UseDiagnosticsResult {
  const [localDiagnostics, setLocalDiagnostics] = useState<Diagnostic[]>([]);
  const [checkedFiles, setCheckedFiles] = useState<string[]>([]);
  const [localTimestamp, setLocalTimestamp] = useState(0);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const watcherRef = useRef<TypeCheckWatcher | null>(null);

  // Connect to channel if provided
  const channel = useDiagnosticsChannel(channelId ?? null);

  // Initialize watcher on mount
  useEffect(() => {
    let cancelled = false;
    setIsInitializing(true);
    setInitError(null);

    const fileSource = createOpfsFileSource(fs, workspacePath);

    // Create type definition client for fetching external package types
    const typeDefClient = createTypeDefinitionClient({
      rpcCall: <T>(targetId: string, method: string, ...args: unknown[]) =>
        rpc.call<T>(targetId, method, ...args),
    });

    const watcher = new TypeCheckWatcher({
      panelPath: workspacePath,
      fileSource,
      debounceMs: 300,
      typeDefinitionClient: typeDefClient,
      onDiagnostics: (result) => {
        if (!cancelled) {
          setLocalDiagnostics(resultToDiagnostics(result));
          setCheckedFiles(result.checkedFiles);
          setLocalTimestamp(Date.now());
        }
      },
      onError: (error) => {
        console.error("[useDiagnostics] Type check error:", error);
      },
    });

    watcherRef.current = watcher;

    // Start the watcher
    watcher
      .start()
      .then(() => {
        if (!cancelled) {
          setIsInitializing(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error("[useDiagnostics] Failed to start watcher:", errorMessage);
          setInitError(errorMessage);
          setIsInitializing(false);
        }
      });

    return () => {
      cancelled = true;
      watcher.dispose();
      watcherRef.current = null;
    };
  }, [workspacePath]);

  // Publish local diagnostics to channel when they change
  useEffect(() => {
    if (channel.connected && localTimestamp > 0) {
      channel.publishDiagnostics(workspacePath, localDiagnostics, checkedFiles);
    }
  }, [channel.connected, localDiagnostics, localTimestamp, workspacePath, checkedFiles, channel.publishDiagnostics]);

  // Merge local and remote diagnostics - most recent wins
  const mergedDiagnostics = useMemo(() => {
    // If not connected to channel or no remote diagnostics, use local only
    if (!channel.connected || channel.remoteDiagnostics.length === 0) {
      return localDiagnostics;
    }

    // Use timestamp-based resolution: most recent diagnostics win
    if (channel.lastUpdate > localTimestamp) {
      return channel.remoteDiagnostics;
    }
    return localDiagnostics;
  }, [localDiagnostics, localTimestamp, channel.connected, channel.remoteDiagnostics, channel.lastUpdate]);

  const updateFile = useCallback((filePath: string, content: string) => {
    watcherRef.current?.updateFile(filePath, content);
  }, []);

  const forFile = useCallback(
    (filePath: string | null): Diagnostic[] => {
      if (!filePath) return [];
      const normalizedTarget = normalizePath(filePath);
      return mergedDiagnostics.filter((d) => normalizePath(d.file) === normalizedTarget);
    },
    [mergedDiagnostics]
  );

  const errorCount = useMemo(
    () => mergedDiagnostics.filter((d) => d.severity === "error").length,
    [mergedDiagnostics]
  );
  const warningCount = useMemo(
    () => mergedDiagnostics.filter((d) => d.severity === "warning").length,
    [mergedDiagnostics]
  );

  return {
    all: mergedDiagnostics,
    forFile,
    updateFile,
    errorCount,
    warningCount,
    isInitializing,
    initError,
    channelConnected: channel.connected,
    channelError: channel.error,
  };
}
