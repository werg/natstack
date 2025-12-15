import { useCallback, useEffect, useRef, useState } from "react";
import {
  ai,
  type AIRoleRecord,
  type StreamEvent,
  type ToolDefinition,
  type Message,
} from "@natstack/ai";
import {
  Box,
  Flex,
  Card,
  Text,
  Heading,
  Button,
  TextArea,
  Select,
  Callout,
  Separator,
  Badge,
  Code,
  ScrollArea,
} from "@radix-ui/themes";

// =============================================================================
// Types
// =============================================================================

interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };

interface ChatMessage {
  role: "user" | "assistant" | "tool";
  parts: MessagePart[];
  pending?: boolean;
}

// =============================================================================
// Tool Definitions with Execute Callbacks
// =============================================================================

function executeTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "get_current_time":
      return { time: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };

    case "calculate": {
      const { expression } = args as { expression: string };
      // Safe eval using Function constructor with restricted scope
      const sanitized = expression.replace(/[^0-9+\-*/%.()\s]/g, "");
      if (sanitized !== expression) {
        throw new Error("Expression contains invalid characters");
      }
      try {
        // eslint-disable-next-line no-new-func
        const result = new Function(`return (${sanitized})`)();
        return { expression, result };
      } catch {
        throw new Error(`Failed to evaluate: ${expression}`);
      }
    }

    case "random_number": {
      const { min, max } = args as { min: number; max: number };
      const value = Math.floor(Math.random() * (max - min + 1)) + min;
      return { min, max, value };
    }

    case "string_transform": {
      const { text, operation } = args as { text: string; operation: string };
      switch (operation) {
        case "reverse":
          return { original: text, transformed: text.split("").reverse().join("") };
        case "uppercase":
          return { original: text, transformed: text.toUpperCase() };
        case "lowercase":
          return { original: text, transformed: text.toLowerCase() };
        case "length":
          return { text, length: text.length };
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Tool definitions for the new streamText API.
 * Each tool includes an execute callback that runs panel-side.
 */
const TOOLS: Record<string, ToolDefinition> = {
  get_current_time: {
    description: "Get the current date and time in ISO format",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (args) => executeTool("get_current_time", args),
  },
  calculate: {
    description: "Evaluate a mathematical expression. Supports basic arithmetic (+, -, *, /, **, %).",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The mathematical expression to evaluate (e.g., '2 + 2', '10 * 5')",
        },
      },
      required: ["expression"],
    },
    execute: async (args) => executeTool("calculate", args),
  },
  random_number: {
    description: "Generate a random number within a specified range",
    parameters: {
      type: "object",
      properties: {
        min: {
          type: "number",
          description: "Minimum value (inclusive)",
        },
        max: {
          type: "number",
          description: "Maximum value (inclusive)",
        },
      },
      required: ["min", "max"],
    },
    execute: async (args) => executeTool("random_number", args),
  },
  string_transform: {
    description: "Transform a string: reverse, uppercase, lowercase, or count characters",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to transform",
        },
        operation: {
          type: "string",
          enum: ["reverse", "uppercase", "lowercase", "length"],
          description: "The transformation to apply",
        },
      },
      required: ["text", "operation"],
    },
    execute: async (args) => executeTool("string_transform", args),
  },
};

// =============================================================================
// Components
// =============================================================================

function ToolCallCard({ toolCall, result }: { toolCall: ToolCall; result?: ToolResult }) {
  const isError = result?.isError;
  return (
    <Card variant="surface" style={{ backgroundColor: "var(--gray-a2)" }}>
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2">
          <Badge color={isError ? "red" : result ? "green" : "orange"}>
            {isError ? "Error" : result ? "Complete" : "Pending"}
          </Badge>
          <Code size="2">{toolCall.toolName}</Code>
        </Flex>
        <Box>
          <Text size="1" color="gray">
            Args:
          </Text>
          <Code size="1" style={{ display: "block", whiteSpace: "pre-wrap" }}>
            {JSON.stringify(toolCall.args, null, 2)}
          </Code>
        </Box>
        {result && (
          <Box>
            <Text size="1" color={isError ? "red" : "gray"}>
              {isError ? "Error:" : "Result:"}
            </Text>
            <Code size="1" color={isError ? "red" : undefined} style={{ display: "block", whiteSpace: "pre-wrap" }}>
              {JSON.stringify(result.result, null, 2)}
            </Code>
          </Box>
        )}
      </Flex>
    </Card>
  );
}

function MessageCard({ message, toolResults }: { message: ChatMessage; toolResults: Map<string, ToolResult> }) {
  const roleColor = message.role === "user" ? "gray" : message.role === "tool" ? "orange" : "blue";
  const roleLabel = message.role === "user" ? "You" : message.role === "tool" ? "Tool" : "Assistant";

  return (
    <Card variant="ghost">
      <Text size="1" color={roleColor}>
        {roleLabel}
        {message.pending && <Badge ml="2" color="orange">Thinking...</Badge>}
      </Text>
      <Separator size="4" my="2" />
      <Flex direction="column" gap="2">
        {message.parts.map((part, idx) => {
          if (part.type === "text") {
            return (
              <Text key={idx} style={{ whiteSpace: "pre-wrap" }}>
                {part.text || (message.pending ? "..." : "")}
              </Text>
            );
          }
          if (part.type === "tool-call") {
            const result = toolResults.get(part.toolCallId);
            return (
              <ToolCallCard
                key={idx}
                toolCall={{ toolCallId: part.toolCallId, toolName: part.toolName, args: part.args }}
                result={result}
              />
            );
          }
          return null;
        })}
      </Flex>
    </Card>
  );
}

// =============================================================================
// Main Component
// =============================================================================

const SYSTEM_PROMPT = `You are a helpful assistant with access to tools. Use tools when appropriate to help answer questions.

Available tools:
- get_current_time: Get the current date and time
- calculate: Evaluate mathematical expressions
- random_number: Generate random numbers in a range
- string_transform: Transform strings (reverse, uppercase, lowercase, length)

When you need to use a tool, make a tool call. After receiving results, provide a helpful response to the user.`;

export default function AgenticChat() {
  const [roles, setRoles] = useState<AIRoleRecord | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>("fast");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolResults, setToolResults] = useState<Map<string, ToolResult>>(new Map());
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load available roles
  useEffect(() => {
    void (async () => {
      try {
        const roleRecord = await ai.listRoles();
        setRoles(roleRecord);
      } catch (error) {
        setStatus(`Failed to load roles: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /**
   * Convert ChatMessage array to Message array for streamText API.
   */
  const buildMessages = useCallback((msgs: ChatMessage[]): Message[] => {
    const result: Message[] = [];

    for (const msg of msgs) {
      if (msg.role === "user") {
        const textParts = msg.parts.filter((p) => p.type === "text") as Array<{ type: "text"; text: string }>;
        if (textParts.length > 0) {
          result.push({
            role: "user",
            content: textParts.map((p) => p.text).join("\n"),
          });
        }
      } else if (msg.role === "assistant") {
        const content: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }> = [];
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "tool-call" && part.toolCallId) {
            content.push({
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.args,
            });
          }
        }
        if (content.length > 0) {
          result.push({ role: "assistant", content });
        }
      } else if (msg.role === "tool") {
        const toolResultParts = msg.parts
          .filter((p) => p.type === "tool-result")
          .map((p) => {
            const tr = p as { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };
            return {
              type: "tool-result" as const,
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              result: tr.result,
              isError: tr.isError,
            };
          });
        if (toolResultParts.length > 0) {
          result.push({ role: "tool", content: toolResultParts });
        }
      }
    }

    return result;
  }, []);

  /**
   * Run the agent using the new streamText API.
   * The agent loop runs server-side, tool callbacks execute panel-side.
   */
  const runAgent = useCallback(
    async (initialMessages: ChatMessage[]) => {
      if (!roles) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setStatus("");

      // Add pending assistant message
      const assistantMsg: ChatMessage = { role: "assistant", parts: [], pending: true };
      let currentMessages = [...initialMessages, assistantMsg];
      setMessages(currentMessages);

      const currentResults = new Map(toolResults);
      let textContent = "";

      try {
        // Build messages for API
        const apiMessages = buildMessages(initialMessages);

        // Start streaming with the unified API
        const stream = ai.streamText({
          model: selectedRole,
          system: SYSTEM_PROMPT,
          messages: apiMessages,
          tools: TOOLS,
          maxSteps: 10,
          abortSignal: controller.signal,
        });

        // Process stream events
        for await (const event of stream) {
          switch (event.type) {
            case "text-delta":
              textContent += event.text;
              // Update assistant message with new text
              currentMessages = currentMessages.slice(0, -1);
              assistantMsg.parts = [
                { type: "text", text: textContent },
                ...assistantMsg.parts.filter((p) => p.type === "tool-call"),
              ];
              currentMessages = [...currentMessages, { ...assistantMsg }];
              setMessages(currentMessages);
              break;

            case "tool-call":
              // Add tool call to assistant message
              currentMessages = currentMessages.slice(0, -1);
              assistantMsg.parts = [
                ...assistantMsg.parts.filter((p) => p.type === "text"),
                ...assistantMsg.parts.filter((p) => p.type === "tool-call"),
                {
                  type: "tool-call",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args,
                },
              ];
              currentMessages = [...currentMessages, { ...assistantMsg }];
              setMessages(currentMessages);
              break;

            case "tool-result":
              // Record tool result for display
              currentResults.set(event.toolCallId, {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result,
                isError: event.isError,
              });
              setToolResults(new Map(currentResults));
              break;

            case "step-finish":
              // A step finished - could be text completion or tool calls
              // Reset text for next step if there will be more
              if (event.finishReason === "tool-calls") {
                textContent = "";
              }
              break;

            case "finish":
              // All done - mark assistant as no longer pending
              assistantMsg.pending = false;
              currentMessages = currentMessages.slice(0, -1);
              currentMessages = [...currentMessages, { ...assistantMsg }];
              setMessages(currentMessages);
              break;

            case "error":
              throw event.error;
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Mark assistant as no longer pending even on error
        assistantMsg.pending = false;
        currentMessages = currentMessages.slice(0, -1);
        currentMessages = [...currentMessages, { ...assistantMsg }];
        setMessages(currentMessages);
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [roles, selectedRole, toolResults, buildMessages]
  );

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !roles) return;

    abortRef.current?.abort();

    const userMsg: ChatMessage = { role: "user", parts: [{ type: "text", text: trimmed }] };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");

    await runAgent(newMessages);
  }, [input, roles, messages, runAgent]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const clearChat = () => {
    setMessages([]);
    setToolResults(new Map());
    setStatus("");
  };

  return (
    <Box p="4" style={{ height: "100%" }}>
      <Flex direction="column" gap="4" style={{ height: "100%" }}>
        {/* Header */}
        <Flex align="center" justify="between">
          <Box>
            <Heading size="4">Agentic Chat</Heading>
            <Text size="1" color="gray">
              AI with tool calling via @natstack/ai streamText API
            </Text>
          </Box>
          <Flex align="center" gap="3">
            <Box>
              <Text size="1" color="gray">
                Role
              </Text>
              <Select.Root value={selectedRole} onValueChange={(value) => setSelectedRole(value)}>
                <Select.Trigger placeholder="Select a role" size="2" disabled={!roles} />
                <Select.Content>
                  {roles &&
                    Object.entries(roles).map(([role, modelInfo]) => (
                      <Select.Item key={role} value={role}>
                        {role}: {modelInfo.displayName}
                      </Select.Item>
                    ))}
                </Select.Content>
              </Select.Root>
            </Box>
            <Button variant="soft" color="gray" onClick={clearChat} disabled={running} size="2">
              Clear
            </Button>
            <Button variant="soft" color="red" onClick={cancel} disabled={!running} size="2">
              Stop
            </Button>
          </Flex>
        </Flex>

        {/* Tool Info */}
        <Card variant="surface" size="1">
          <Flex gap="2" wrap="wrap" align="center">
            <Text size="1" color="gray">
              Tools:
            </Text>
            {Object.keys(TOOLS).map((toolName) => (
              <Badge key={toolName} variant="outline" size="1">
                {toolName}
              </Badge>
            ))}
          </Flex>
        </Card>

        {/* Messages */}
        <Card variant="surface" style={{ flex: 1, overflow: "hidden" }}>
          <ScrollArea style={{ height: "100%" }}>
            {messages.length === 0 ? (
              <Flex align="center" justify="center" style={{ height: "100%", minHeight: 200 }}>
                <Text color="gray">Ask something that might use tools (math, time, text manipulation).</Text>
              </Flex>
            ) : (
              <Flex direction="column" gap="3" p="2">
                {messages.map((msg, idx) => (
                  <MessageCard key={idx} message={msg} toolResults={toolResults} />
                ))}
                <div ref={messagesEndRef} />
              </Flex>
            )}
          </ScrollArea>
        </Card>

        {/* Input */}
        <Card variant="surface">
          <Flex direction="column" gap="3">
            <TextArea
              size="2"
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Try: 'What time is it?' or 'Calculate 15 * 23' or 'Reverse the word hello'"
              disabled={!roles || running}
            />
            <Flex align="center" justify="between" gap="3">
              {status ? (
                <Callout.Root color="red" size="1">
                  <Callout.Text>{status}</Callout.Text>
                </Callout.Root>
              ) : (
                <Box />
              )}
              <Button onClick={() => void sendMessage()} disabled={!roles || running || !input.trim()} size="2">
                {running ? "Running..." : "Send"}
              </Button>
            </Flex>
          </Flex>
        </Card>
      </Flex>
    </Box>
  );
}
