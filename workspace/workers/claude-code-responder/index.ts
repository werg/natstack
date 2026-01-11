/**
 * Claude Code Responder Worker
 *
 * An unsafe worker that uses the Claude Agent SDK to respond to messages on a pubsub channel.
 * Discovers tools from other participants via agentic-messaging and provides them to Claude.
 */

import { execSync } from "child_process";
import { pubsubConfig, setTitle, id } from "@natstack/runtime";
import {
  connect,
  createToolsForAgentSDK,
  jsonSchemaToZodRawShape,
  parseAgentConfig,
  createLogger,
  formatArgsForLog,
  createInterruptHandler,
  createPauseMethodDefinition,
  createRichTextChatSystemPrompt,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  formatMissedContext,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@natstack/agentic-messaging";
import { z } from "zod";
import { query, tool, createSdkMcpServer, type Query, type SDKResultMessage, type CanUseTool, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/**
 * Find an executable in the system PATH.
 * Cross-platform: uses `where` on Windows, `which` on Unix-like systems.
 */
function findExecutable(name: string): string | undefined {
  const isWindows = process.platform === "win32";
  const command = isWindows ? `where ${name}` : `which ${name}`;

  try {
    const result = execSync(command, { encoding: "utf-8" }).trim();
    // `where` on Windows may return multiple lines; take the first one
    const firstLine = result.split(/\r?\n/)[0];
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

void setTitle("Claude Code Responder");

const log = createLogger("Claude Code", id);

/** Worker-local settings interface */
interface ClaudeCodeWorkerSettings {
  model?: string;
  maxThinkingTokens?: number;
  permissionMode?: string;
}

/** Current settings state */
let currentSettings: ClaudeCodeWorkerSettings = {};

/**
 * Escape a string value for safe interpolation into a TSX template string.
 * Handles quotes, backslashes, and template literal special chars.
 */
function escapeTsxString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

/** Reference to the current query instance for model discovery */
let activeQueryInstance: Query | null = null;

/**
 * Generate TSX for permission approval UI
 */
function generatePermissionPromptTsx(
  toolName: string,
  input: Record<string, unknown>,
  decisionReason?: string
): string {
  const inputJson = JSON.stringify(input, null, 2);
  const escapedInput = inputJson.replace(/`/g, "\\`").replace(/\$/g, "\\$");
  const escapedReason = decisionReason?.replace(/`/g, "\\`").replace(/\$/g, "\\$") ?? "";

  return `
import { useState } from "react";
import { Box, Button, Callout, Code, Flex, Heading, ScrollArea, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";

export default function PermissionPrompt({ onSubmit, onCancel }) {
  const toolName = "${toolName}";
  const inputJson = \`${escapedInput}\`;
  const reason = \`${escapedReason}\`;

  return (
    <Box>
      <Flex align="center" gap="2" mb="3">
        <ExclamationTriangleIcon width={20} height={20} color="var(--amber-9)" />
        <Heading size="4">Permission Required</Heading>
      </Flex>

      {reason && (
        <Callout.Root color="amber" mb="3">
          <Callout.Text>{reason}</Callout.Text>
        </Callout.Root>
      )}

      <Flex direction="column" gap="3">
        <Box>
          <Text size="2" weight="medium" mb="1">Tool</Text>
          <Code size="2">{toolName}</Code>
        </Box>

        <Box>
          <Text size="2" weight="medium" mb="1">Input</Text>
          <ScrollArea style={{ maxHeight: 200 }}>
            <Code size="1" style={{ whiteSpace: "pre-wrap", display: "block" }}>
              {inputJson}
            </Code>
          </ScrollArea>
        </Box>

        <Flex gap="3" mt="3" justify="end">
          <Button variant="soft" color="gray" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="soft" color="red" onClick={() => onSubmit({ allow: false })}>
            Deny
          </Button>
          <Button color="green" onClick={() => onSubmit({ allow: true })}>
            Allow
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
}
`;
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  // Get channel from environment (passed by broker via process.env)
  const channelName = process.env.CHANNEL;

  // Parse agent config from environment (passed by broker as JSON)
  const agentConfig = parseAgentConfig();
  const configuredWorkingDirectory =
    typeof agentConfig.workingDirectory === "string" ? agentConfig.workingDirectory.trim() : "";
  const workingDirectory = configuredWorkingDirectory || process.env["NATSTACK_WORKSPACE"];

  // Get handle from config (set by broker from invite), fallback to default
  const handle = typeof agentConfig.handle === "string" ? agentConfig.handle : "claude";

  // Get workspace ID from environment
  const workspaceId = process.env["NATSTACK_WORKSPACE_ID"];

  log("Starting Claude Code responder...");

  // Find the claude executable path for the SDK
  const claudeExecutable = findExecutable("claude");
  if (!claudeExecutable) {
    console.error("Claude Code CLI not found in PATH. Please install claude-code.");
    return;
  }
  log(`Claude executable: ${claudeExecutable}`);

  if (workingDirectory) {
    log(`Working directory: ${workingDirectory}`);
  }
  log(`Handle: @${handle}`);

  // Connect to agentic messaging channel
  const client = await connect<ChatParticipantMetadata>({
    serverUrl: pubsubConfig.serverUrl,
    token: pubsubConfig.token,
    channel: channelName,
    handle,
    name: "Claude Code",
    type: "claude-code",
    workspaceId,
    reconnect: true,
    methods: {
      pause: createPauseMethodDefinition(async () => {
        // Pause event is published by interrupt handler
      }),
      settings: {
        description: "Configure Claude Code settings",
        parameters: z.object({}),
        menu: true,
        execute: async () => {
          // Find the chat panel participant
          const panel = Object.values(client.roster).find(
            (p) => p.metadata.type === "panel"
          );
          if (!panel) throw new Error("No panel found");

          // Fetch models dynamically from SDK if we have an active query
          let modelOptions: Array<{ value: string; displayName: string }> = [];
          try {
            if (activeQueryInstance) {
              modelOptions = await activeQueryInstance.supportedModels();
            }
          } catch (err) {
            log(`Failed to fetch models: ${err}`);
          }

          // Fallback to known Claude models if dynamic discovery unavailable
          if (modelOptions.length === 0) {
            modelOptions = [
              { value: "claude-opus-4-5-20251101", displayName: "Claude Opus 4.5" },
              { value: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
              { value: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
              { value: "claude-opus-4-1-20250805", displayName: "Claude Opus 4.1" },
              { value: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
              { value: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
            ];
          }

          // Generate SDK-specific settings UI
          const modelSelectItems = modelOptions.map(m =>
            `<Select.Item key="${m.value}" value="${m.value}">${m.displayName}</Select.Item>`
          ).join("\n              ");

          const settingsTsx = `
import { useState } from "react";
import { Box, Button, Callout, Flex, Heading, Select, Slider, Text, SegmentedControl } from "@radix-ui/themes";
import { InfoCircledIcon } from "@radix-ui/react-icons";

const PERMISSION_MODES = [
  { value: "default", label: "Default", description: "Ask for permission on each tool use" },
  { value: "acceptEdits", label: "Accept Edits", description: "Auto-approve file edits, ask for others" },
  { value: "bypassPermissions", label: "Bypass", description: "Skip all permission prompts (dangerous)" },
  { value: "plan", label: "Plan", description: "Planning mode - no tool execution" },
  { value: "delegate", label: "Delegate", description: "Delegate decisions to a sub-agent" },
  { value: "dontAsk", label: "Don't Ask", description: "Use tool defaults without prompting" },
];

export default function SettingsForm({ onSubmit, onCancel }) {
  const [model, setModel] = useState("${escapeTsxString(currentSettings.model ?? "claude-sonnet-4-5-20250929")}");
  const [thinkingBudget, setThinkingBudget] = useState(${currentSettings.maxThinkingTokens ?? 10240});
  const [permissionMode, setPermissionMode] = useState("${escapeTsxString(currentSettings.permissionMode ?? "default")}");

  const handleSubmit = () => {
    onSubmit({
      model: model || undefined,
      maxThinkingTokens: thinkingBudget,
      permissionMode: permissionMode === "default" ? undefined : permissionMode,
    });
  };

  const selectedMode = PERMISSION_MODES.find(m => m.value === permissionMode);

  return (
    <Box>
      <Heading size="4" mb="4">Claude Code Settings</Heading>

      <Flex direction="column" gap="5">
        {/* Model Selection */}
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium">Model</Text>
          <Select.Root value={model} onValueChange={setModel}>
            <Select.Trigger placeholder="Select a model..." />
            <Select.Content>
              ${modelSelectItems}
            </Select.Content>
          </Select.Root>
          <Text size="1" color="gray">Claude model for code generation</Text>
        </Flex>

        {/* Thinking Budget Slider */}
        <Flex direction="column" gap="2">
          <Flex justify="between" align="center">
            <Text size="2" weight="medium">Thinking Budget</Text>
            <Text size="2" color="gray">{thinkingBudget === 0 ? "Disabled" : \`\${thinkingBudget.toLocaleString()} tokens\`}</Text>
          </Flex>
          <Slider
            value={[thinkingBudget]}
            onValueChange={([v]) => setThinkingBudget(v)}
            min={0}
            max={32000}
            step={1024}
          />
          <Flex justify="between">
            <Text size="1" color="gray">Off</Text>
            <Text size="1" color="gray">Maximum</Text>
          </Flex>
        </Flex>

        {/* Permission Mode */}
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium">Permission Mode</Text>
          <SegmentedControl.Root value={permissionMode} onValueChange={setPermissionMode}>
            {PERMISSION_MODES.slice(0, 3).map(mode => (
              <SegmentedControl.Item key={mode.value} value={mode.value}>
                {mode.label}
              </SegmentedControl.Item>
            ))}
          </SegmentedControl.Root>
          <SegmentedControl.Root value={permissionMode} onValueChange={setPermissionMode}>
            {PERMISSION_MODES.slice(3).map(mode => (
              <SegmentedControl.Item key={mode.value} value={mode.value}>
                {mode.label}
              </SegmentedControl.Item>
            ))}
          </SegmentedControl.Root>
          {selectedMode && (
            <Text size="1" color="gray">{selectedMode.description}</Text>
          )}
          {permissionMode === "bypassPermissions" && (
            <Callout.Root color="red" size="1">
              <Callout.Icon>
                <InfoCircledIcon />
              </Callout.Icon>
              <Callout.Text>Bypassing permissions allows unrestricted tool execution</Callout.Text>
            </Callout.Root>
          )}
        </Flex>

        {/* Actions */}
        <Flex gap="3" mt="2" justify="end">
          <Button variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
          <Button onClick={handleSubmit}>Save</Button>
        </Flex>
      </Flex>
    </Box>
  );
}
`;

          // Call feedback_ui on the panel
          const handle = client.callMethod(panel.id, "feedback_ui", { code: settingsTsx });
          const result = await handle.result;
          const feedbackResult = result.content as { type: string; value?: unknown; message?: string };

          // Handle the three cases: submit, cancel, error
          if (feedbackResult.type === "cancel") {
            log("Settings cancelled");
            return { success: false, cancelled: true };
          }

          if (feedbackResult.type === "error") {
            log(`Settings error: ${feedbackResult.message}`);
            return { success: false, error: feedbackResult.message };
          }

          // Apply new settings (submit case)
          const newSettings = feedbackResult.value as ClaudeCodeWorkerSettings;
          Object.assign(currentSettings, newSettings);
          log(`Settings updated: ${JSON.stringify(currentSettings)}`);

          // Persist settings if session is available
          if (client.sessionKey) {
            try {
              await client.updateSettings(currentSettings);
            } catch (err) {
              log(`Failed to persist settings: ${err}`);
            }
          }

          return { success: true, settings: currentSettings };
        },
      },
    },
  });

  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map((p) => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  log(`Connected to channel: ${channelName}`);
  if (client.sessionKey) {
    log(`Session: ${client.sessionKey} (${client.status})`);
    log(`Checkpoint: ${client.checkpoint ?? "none"}, SDK: ${client.sdkSessionId ?? "none"}`);

    // Load persisted settings
    try {
      const savedSettings = await client.getSettings<ClaudeCodeWorkerSettings>();
      if (savedSettings) {
        currentSettings = savedSettings;
        log(`Loaded settings: ${JSON.stringify(currentSettings)}`);
      }
    } catch (err) {
      log(`Failed to load settings: ${err}`);
    }
  }

  let lastMissedPubsubId = 0;
  const buildMissedContext = () => {
    const missed = client.missedMessages.filter((event) => event.pubsubId > lastMissedPubsubId);
    if (missed.length === 0) return null;
    return formatMissedContext(missed, { maxChars: DEFAULT_MISSED_CONTEXT_MAX_CHARS });
  };

  let pendingMissedContext = buildMissedContext();

  client.onReconnect(() => {
    pendingMissedContext = buildMissedContext();
  });

  // Process incoming events using unified API
  for await (const event of client.events({ targetedOnly: true, respondWhenSolo: true })) {
    if (event.type !== "message") continue;

    // Skip replay messages - don't respond to historical messages
    if (event.kind === "replay") continue;

    const sender = client.roster[event.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && event.senderId !== id) {
      let prompt = event.content;
      if (pendingMissedContext && pendingMissedContext.count > 0) {
        prompt = `<missed_context>\n${pendingMissedContext.formatted}\n</missed_context>\n\n${prompt}`;
        lastMissedPubsubId = pendingMissedContext.lastPubsubId;
        pendingMissedContext = null;
      }
      await handleUserMessage(client, event, prompt, workingDirectory, claudeExecutable);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  incoming: IncomingNewMessage,
  prompt: string,
  workingDirectory: string | undefined,
  claudeExecutable: string
) {
  log(`Received message: ${incoming.content}`);

  // Create tools from other pubsub participants
  const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
    namePrefix: "pubsub",
  });

  log(`Discovered ${toolDefs.length} tools from pubsub participants`);

  // Start a new message (empty, will stream content via updates)
  const { messageId: responseId } = await client.send("", { replyTo: incoming.id });

  try {
    // Keep reference to the query for interrupt handling via RPC pause mechanism
    let queryInstance: Query | null = null;

    // Set up RPC pause handler - monitors for pause tool calls
    const interruptHandler = createInterruptHandler({
      client,
      messageId: incoming.id,
      onPause: async (reason) => {
        log(`Pause RPC received: ${reason}`);
        // Break out of the query loop via isPaused() check
        // The pause tool returns successfully (not an error)
      }
    });

    // Start monitoring for pause events in background
    void interruptHandler.monitor();

    // Convert pubsub tools to Claude Agent SDK MCP tools
    const mcpTools = toolDefs.map((toolDef) =>
      tool(
        toolDef.name,
        toolDef.description ?? "",
        jsonSchemaToZodRawShape(toolDef.parameters),
        async (args: unknown) => {
          log(`Tool call: ${toolDef.name} args=${formatArgsForLog(args)}`);
          const result = await executeTool(toolDef.name, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        }
      )
    );

    // Create MCP server with only pubsub tools (NOT pause - that's RPC only)
    const pubsubServer = createSdkMcpServer({
      name: "pubsub",
      version: "1.0.0",
      tools: mcpTools,
    });

    // Determine allowed tools
    const allowedTools = mcpTools.map((t) => `mcp__pubsub__${t.name}`);

    // Create permission handler that prompts user via feedback_ui
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      log(`Permission requested for tool: ${toolName}`);

      // Find the chat panel participant
      const panel = Object.values(client.roster).find(
        (p) => p.metadata.type === "panel"
      );

      if (!panel) {
        // No panel to ask - deny by default
        log(`No panel found, denying permission for ${toolName}`);
        return {
          behavior: "deny" as const,
          message: "No panel available to request permission",
          toolUseID: options.toolUseID,
        };
      }

      try {
        // Generate and show permission UI
        const promptTsx = generatePermissionPromptTsx(toolName, input, options.decisionReason);
        const handle = client.callMethod(panel.id, "feedback_ui", { code: promptTsx });
        const result = await handle.result;
        const feedbackResult = result.content as { type: string; value?: unknown; message?: string };

        // Handle the three cases: submit, cancel, error
        if (feedbackResult.type === "cancel") {
          log(`Permission prompt cancelled for ${toolName}`);
          return {
            behavior: "deny" as const,
            message: "User cancelled permission prompt",
            toolUseID: options.toolUseID,
          };
        }

        if (feedbackResult.type === "error") {
          log(`Permission prompt error for ${toolName}: ${feedbackResult.message}`);
          return {
            behavior: "deny" as const,
            message: `Permission prompt error: ${feedbackResult.message}`,
            toolUseID: options.toolUseID,
          };
        }

        // Submit case - extract the decision
        const decision = feedbackResult.value as { allow: boolean };

        if (decision.allow) {
          log(`Permission granted for ${toolName}`);
          return {
            behavior: "allow" as const,
            updatedInput: input,
            toolUseID: options.toolUseID,
          };
        } else {
          log(`Permission denied for ${toolName}`);
          return {
            behavior: "deny" as const,
            message: "User denied permission",
            toolUseID: options.toolUseID,
          };
        }
      } catch (err) {
        log(`Permission prompt failed: ${err}`);
        return {
          behavior: "deny" as const,
          message: `Permission prompt failed: ${err instanceof Error ? err.message : String(err)}`,
          toolUseID: options.toolUseID,
        };
      }
    };

    // Get session state for resumption
    const queryOptions: Parameters<typeof query>[0]["options"] = {
      mcpServers: { pubsub: pubsubServer },
      systemPrompt: createRichTextChatSystemPrompt(),
      // Provide explicit path to Claude Code CLI (required for bundled workers)
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(allowedTools.length > 0 && { allowedTools }),
      // Disable built-in tools - we only want pubsub tools
      disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Task"],
      // Set working directory if provided via config
      ...(workingDirectory && { cwd: workingDirectory }),
      // Enable streaming of partial messages for token-by-token delivery
      includePartialMessages: true,
      // Resume from previous session if available
      ...(client.sdkSessionId && { resume: client.sdkSessionId }),
      // Apply user settings
      ...(currentSettings.model && { model: currentSettings.model }),
      ...(currentSettings.maxThinkingTokens && { maxThinkingTokens: currentSettings.maxThinkingTokens }),
      ...(currentSettings.permissionMode && { permissionMode: currentSettings.permissionMode }),
      ...(currentSettings.permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
      // Wire permission prompts to feedback_ui (only for default/dontAsk modes)
      ...(!currentSettings.permissionMode || currentSettings.permissionMode === "default" ? { canUseTool } : {}),
    };

    // Query Claude using the Agent SDK
    queryInstance = query({
      prompt,
      options: queryOptions,
    });

    // Store reference for settings method to use for model discovery
    activeQueryInstance = queryInstance;

    let capturedSessionId: string | undefined;
    let checkpointCommitted = false;
    let sawStreamedText = false;

    for await (const message of queryInstance) {
      // Check if pause was requested and break early
      if (interruptHandler.isPaused()) {
        log("Execution paused, breaking out of query loop");
        break;
      }

      if (message.type === "stream_event") {
        // Handle streaming message events (token-by-token with includePartialMessages: true)
        const streamEvent = message.event as { type: string; delta?: { type: string; text?: string } };

        // Only handle text deltas from content blocks
        if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
          if (streamEvent.delta.text) {
            // Send each text delta immediately (real streaming)
            await client.update(responseId, streamEvent.delta.text);
            sawStreamedText = true;

            if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
              await client.commitCheckpoint(incoming.pubsubId);
              checkpointCommitted = true;
            }
          }
        }
      } else if (message.type === "assistant") {
        // Fallback for complete assistant messages when no streaming deltas were seen.
        if (!sawStreamedText) {
          for (const block of message.message.content) {
            if (block.type === "text") {
              await client.update(responseId, block.text);
            }
          }
        }
      } else if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Query failed: ${message.subtype}`);
        }
        // Capture session ID from result for future resumption
        // session_id is present on success results (typed as SDKResultMessage)
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === "success" && resultMessage.session_id) {
          capturedSessionId = resultMessage.session_id;
        }
        log(`Query completed. Cost: $${message.total_cost_usd?.toFixed(4) ?? "unknown"}`);
      }
    }

    if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
      await client.commitCheckpoint(incoming.pubsubId);
      checkpointCommitted = true;
    }

    // Store session ID for resumption
    if (capturedSessionId && client.sessionKey) {
      await client.updateSdkSession(capturedSessionId);
      log(`Session ID stored: ${capturedSessionId}`);
    } else if (capturedSessionId) {
      log("Skipping session update (workspaceId not set)");
    }

    // Mark message as complete (whether interrupted or finished normally)
    await client.complete(responseId);
    log(`Completed response for ${incoming.id}`);
  } catch (err) {
    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    const errorDetails = err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name, ...err }
      : err;
    console.error(`[Claude Code] Error:`, JSON.stringify(errorDetails, null, 2));
    console.error(`[Claude Code] Full error object:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  }
}

void main();
