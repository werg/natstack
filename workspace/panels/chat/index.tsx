/**
 * Agentic Chat Panel — Thin wrapper over @workspace/agentic-chat
 *
 * Reads runtime-specific configuration (pubsubConfig, panel ID, theme, stateArgs)
 * and delegates to the reusable AgenticChat component.
 */

import { pubsubConfig, id as panelClientId, buildNsLink, buildFocusLink, createChild, useStateArgs, forceRepaint, ensurePanelLoaded } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { useCallback } from "react";
import { Flex, Text, Button, Card } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps } from "@workspace/agentic-chat";
import { createAllToolMethodDefinitions, executeEvalTool, EVAL_DEFAULT_TIMEOUT_MS, EVAL_MAX_TIMEOUT_MS, EVAL_FRAMEWORK_TIMEOUT_MS } from "@workspace/agentic-tools";
import { z } from "zod";
import type { MethodDefinition } from "@natstack/agentic-messaging";

/** Type for chat panel state args */
interface ChatStateArgs {
  channelName: string;
  channelConfig?: {
    workingDirectory?: string;
    restrictedMode?: boolean;
  };
  contextId?: string;
  pendingAgents?: Array<{ agentId: string; handle: string }>;
}

export default function ChatPanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<ChatStateArgs>();
  const { channelName, channelConfig, contextId } = stateArgs;

  // Derive workspace root
  const workspaceRoot = channelConfig?.workingDirectory
    || process.env["NATSTACK_WORKSPACE"]?.trim()
    || (channelConfig?.restrictedMode ? "/" : undefined);

  // Build ConnectionConfig from runtime
  const config: ConnectionConfig = {
    serverUrl: pubsubConfig?.serverUrl ?? "",
    token: pubsubConfig?.token ?? "",
    clientId: panelClientId,
  };

  // Build AgenticChatActions from runtime navigation functions
  const handleNewConversation = useCallback(() => {
    const launcherUrl = buildNsLink("panels/chat-launcher", { action: "navigate" });
    window.location.href = launcherUrl;
  }, []);

  const handleAddAgent = useCallback(async (channelName: string, launcherContextId?: string) => {
    await createChild(
      "panels/chat-launcher",
      { name: "add-agent", focus: true, contextId: launcherContextId },
      { channelName, contextId: launcherContextId }
    );
  }, []);

  const handleFocusPanel = useCallback((panelId: string) => {
    window.location.href = buildFocusLink(panelId);
  }, []);

  const handleReloadPanel = useCallback(async (panelId: string) => {
    try {
      const result = await ensurePanelLoaded(panelId);
      if (!result.success) {
        console.error(`Failed to reload panel ${panelId}:`, result.error);
        window.location.href = buildFocusLink(panelId);
      }
    } catch (error) {
      console.error(`Error reloading panel ${panelId}:`, error);
      window.location.href = buildFocusLink(panelId);
    }
  }, []);

  const chatActions: AgenticChatActions = {
    onNewConversation: handleNewConversation,
    onAddAgent: handleAddAgent,
    onFocusPanel: handleFocusPanel,
    onReloadPanel: handleReloadPanel,
    onBecomeVisible: forceRepaint,
  };

  // Tool provider: creates all tool method definitions + eval
  const toolProvider: ToolProvider = useCallback(({ clientRef, workspaceRoot: wsRoot }: ToolProviderDeps) => {
    const diagnosticsPublisher = (eventType: string, payload: unknown) => {
      void clientRef.current?.publish(eventType, payload);
    };
    const fileTools = createAllToolMethodDefinitions({
      workspaceRoot: wsRoot ?? workspaceRoot,
      diagnosticsPublisher,
    });

    // Eval tool definition
    const evalMethodDef: MethodDefinition = {
      description: `Execute TypeScript/JavaScript code for side-effects.

Console output is streamed in real-time as code executes.
Async operations (fetch, await, etc.) are automatically awaited.
Top-level await is supported.

Use standard ESM imports - they're transformed to require() automatically:
- import { useState } from "react"
- import { Button } from "@radix-ui/themes"`,
      parameters: z.object({
        code: z.string().describe("The TypeScript/JavaScript code to execute"),
        syntax: z.enum(["typescript", "jsx", "tsx"]).default("tsx").describe("Target syntax"),
        timeout: z.number().default(EVAL_DEFAULT_TIMEOUT_MS).describe(`Timeout in ms (default: ${EVAL_DEFAULT_TIMEOUT_MS}, max: ${EVAL_MAX_TIMEOUT_MS}).`),
      }),
      streaming: true,
      timeout: EVAL_FRAMEWORK_TIMEOUT_MS,
      execute: async (args, ctx) => {
        let consoleBuffer = "";
        let lastFlush = 0;
        const flushConsole = (_force = false) => {
          const now = Date.now();
          if (!_force && now - lastFlush < 200) return;
          lastFlush = now;
        };

        try {
          const result = await executeEvalTool(args as { code: string; syntax?: "typescript" | "jsx" | "tsx"; timeout?: number }, ctx, {
            onConsoleEntry: (formatted: string) => {
              consoleBuffer = consoleBuffer ? `${consoleBuffer}\n${formatted}` : formatted;
              flushConsole();
            },
          });
          if (!result.success) {
            if (result.consoleOutput) consoleBuffer = result.consoleOutput;
            throw new Error(result.error || "Eval failed");
          }
          return {
            consoleOutput: result.consoleOutput || "(no output)",
            returnValue: result.returnValue,
          };
        } catch (err) {
          throw err;
        }
      },
    };

    return { eval: evalMethodDef, ...fileTools };
  }, [workspaceRoot]);

  // Error state: no channel name provided
  if (!channelName) {
    return (
      <ErrorBoundary>
        <Flex direction="column" align="center" justify="center" style={{ height: "100vh", padding: 16 }} gap="3">
          <Card>
            <Flex direction="column" gap="3" p="4" align="center">
              <Text size="4" weight="bold" color="red">
                Missing Channel Name
              </Text>
              <Text size="2" color="gray" style={{ textAlign: "center" }}>
                This panel requires a channelName state arg to connect to a chat channel.
              </Text>
              <Button onClick={handleNewConversation}>
                Start New Conversation
              </Button>
            </Flex>
          </Card>
        </Flex>
      </ErrorBoundary>
    );
  }

  return (
    <AgenticChat
      config={config}
      channelName={channelName}
      channelConfig={channelConfig}
      contextId={contextId}
      metadata={{ name: "Chat Panel", type: "panel", handle: "user" }}
      tools={toolProvider}
      actions={chatActions}
      theme={theme}
      pendingAgents={stateArgs.pendingAgents}
    />
  );
}
