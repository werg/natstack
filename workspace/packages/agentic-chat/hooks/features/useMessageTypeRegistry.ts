import { useEffect, useMemo, useRef, useState } from "react";
import type { PubSubClient } from "@workspace/pubsub";
import {
  compileMessageTypeModule,
  type ChatMessage,
  type CustomMessageValidator,
  type MessageTypeDefinition,
  type MessageTypeModule,
} from "@workspace/agentic-core";
import type { LoadSourceFile, SandboxOptions } from "@workspace/eval";
import type { MessageTypeComponentEntry } from "../../types";

interface UseMessageTypeRegistryOptions {
  client: PubSubClient | null;
  messages: ChatMessage[];
  definitions: MessageTypeDefinition[];
  loadSourceFile?: LoadSourceFile;
  loadImport?: SandboxOptions["loadImport"];
}

export interface MessageTypeRegistryState {
  messageTypeComponents: Map<string, MessageTypeComponentEntry>;
}

export function useMessageTypeRegistry({
  client,
  messages,
  definitions,
  loadSourceFile,
  loadImport,
}: UseMessageTypeRegistryOptions): MessageTypeRegistryState {
  const [entries, setEntries] = useState<Map<string, MessageTypeComponentEntry>>(new Map());
  const [fetchedDefinitions, setFetchedDefinitions] = useState<Map<string, MessageTypeDefinition>>(new Map());
  const entriesRef = useRef(new Map<string, MessageTypeComponentEntry>());
  const definitionsRef = useRef(new Map<string, MessageTypeDefinition>());
  const pendingFetchesRef = useRef(new Set<string>());
  const pendingCompilesRef = useRef(new Set<string>());
  const fetchedInitialRef = useRef<PubSubClient | null>(null);
  const allDefinitions = useMemo(() => {
    const map = new Map(fetchedDefinitions);
    for (const definition of definitions) map.set(definition.typeId, definition);
    return Array.from(map.values());
  }, [definitions, fetchedDefinitions]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    const next = new Map(definitionsRef.current);
    for (const definition of allDefinitions) {
      next.set(definition.typeId, definition);
    }
    definitionsRef.current = next;
  }, [allDefinitions]);

  useEffect(() => {
    let cancelled = false;

    async function compileDefinition(definition: MessageTypeDefinition): Promise<void> {
      if (definition.cleared) {
        setEntries((prev) => {
          const message = `Message type ${definition.typeId} was cleared`;
          const current = prev.get(definition.typeId);
          if (current?.status === "error" && current.message === message) return prev;
          const next = new Map(prev);
          next.set(definition.typeId, { status: "error", message });
          return next;
        });
        return;
      }
      if (!definition.source) {
        setEntries((prev) => {
          const next = new Map(prev);
          next.set(definition.typeId, {
            status: "error",
            message: `Message type ${definition.typeId} has no source`,
          });
          return next;
        });
        return;
      }
      const compileKey = `${definition.typeId}:${definition.updatedAtSeq}`;
      const existing = entriesRef.current.get(definition.typeId);
      if (
        existing?.status === "ready" &&
        existing.definition.updatedAtSeq === definition.updatedAtSeq
      ) {
        return;
      }
      if (pendingCompilesRef.current.has(compileKey)) return;
      pendingCompilesRef.current.add(compileKey);

      setEntries((prev) => {
        const current = prev.get(definition.typeId);
        if (current?.status === "ready" && current.definition.updatedAtSeq === definition.updatedAtSeq) return prev;
        const next = new Map(prev);
        next.set(definition.typeId, { status: "loading" });
        return next;
      });

      try {
        const sourceCode = definition.source.type === "file"
          ? await loadSourceFile?.(definition.source.path)
          : definition.source.code;
        if (!sourceCode) throw new Error(`Unable to load source for message type ${definition.typeId}`);
        const result = await compileMessageTypeModule(sourceCode, {
          imports: definition.imports,
          sourcePath: definition.source.type === "file" ? definition.source.path : undefined,
          loadSourceFile,
          loadImport,
        });
        const validator = result.success && result.module
          ? await resolveValidator(definition, result.module, { loadSourceFile, loadImport })
          : undefined;
        if (cancelled) return;
        setEntries((prev) => {
          const next = new Map(prev);
          if (result.success && result.module) {
            next.set(definition.typeId, {
              status: "ready",
              definition,
              module: result.module,
              cacheKey: result.cacheKey ?? `${definition.typeId}:${definition.updatedAtSeq}`,
              validator,
            });
          } else {
            next.set(definition.typeId, {
              status: "error",
              message: result.error ?? `Failed to compile message type ${definition.typeId}`,
            });
          }
          return next;
        });
      } catch (err) {
        if (cancelled) return;
        setEntries((prev) => {
          const next = new Map(prev);
          next.set(definition.typeId, {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          return next;
        });
      } finally {
        pendingCompilesRef.current.delete(compileKey);
      }
    }

    for (const definition of allDefinitions) {
      void compileDefinition(definition);
    }

    return () => {
      cancelled = true;
    };
  }, [allDefinitions, loadSourceFile, loadImport]);

  useEffect(() => {
    if (!client || fetchedInitialRef.current === client) return;
    fetchedInitialRef.current = client;
    void client.getMessageTypes().then((remoteDefinitions) => {
      setFetchedDefinitions((prev) => {
        const next = new Map(prev);
        for (const definition of remoteDefinitions) next.set(definition.typeId, definition);
        return next;
      });
    }).catch((err) => {
      console.warn("[useMessageTypeRegistry] failed to fetch message type registry:", err);
    });
  }, [client]);

  useEffect(() => {
    if (!client) return;
    for (const msg of messages) {
      if (msg.contentType !== "custom" || !msg.custom) continue;
      const typeId = msg.custom.typeId;
      if (definitionsRef.current.has(typeId) || entriesRef.current.has(typeId) || pendingFetchesRef.current.has(typeId)) continue;
      pendingFetchesRef.current.add(typeId);
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(typeId, { status: "loading" });
        return next;
      });
      void client.getMessageType(typeId).then((definition) => {
        if (!definition) {
          setEntries((prev) => {
            const next = new Map(prev);
            next.set(typeId, { status: "error", message: `Message type ${typeId} is not registered` });
            return next;
          });
          return;
        }
        setFetchedDefinitions((prev) => new Map(prev).set(typeId, definition));
      }).catch((err) => {
        setEntries((prev) => {
          const next = new Map(prev);
          next.set(typeId, { status: "error", message: err instanceof Error ? err.message : String(err) });
          return next;
        });
      }).finally(() => {
        pendingFetchesRef.current.delete(typeId);
      });
    }
  }, [client, messages]);

  return { messageTypeComponents: entries };
}

/**
 * Resolve a state validator for a registered type. Prefers the module's own
 * `schema` export; otherwise compiles the registration's `schemaSourceOrPath`
 * (a SandboxSource or a bare file path) and uses its `schema`/default export.
 */
async function resolveValidator(
  definition: MessageTypeDefinition,
  module: MessageTypeModule,
  opts: { loadSourceFile?: LoadSourceFile; loadImport?: SandboxOptions["loadImport"] },
): Promise<CustomMessageValidator | undefined> {
  if (module.schema) return module.schema as CustomMessageValidator;
  const raw = definition.schemaSourceOrPath;
  if (!raw) return undefined;
  const schemaSource = typeof raw === "string" ? { type: "file" as const, path: raw } : raw;
  try {
    const code = schemaSource.type === "file"
      ? await opts.loadSourceFile?.(schemaSource.path)
      : schemaSource.code;
    if (!code) return undefined;
    const result = await compileMessageTypeModule(code, {
      imports: definition.imports,
      sourcePath: schemaSource.type === "file" ? schemaSource.path : undefined,
      loadSourceFile: opts.loadSourceFile,
      loadImport: opts.loadImport,
    });
    if (!result.success || !result.module) return undefined;
    const validator = result.module.schema ?? result.module.default;
    return validator as CustomMessageValidator | undefined;
  } catch (err) {
    console.warn(`[useMessageTypeRegistry] failed to compile schema for ${definition.typeId}:`, err);
    return undefined;
  }
}
