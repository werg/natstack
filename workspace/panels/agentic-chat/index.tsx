import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { models, getRoles, type AIRoleRecord, type LanguageModelV2Prompt } from "@natstack/panel";
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

interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

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
// Tool Definitions & Implementations
// =============================================================================

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    name: "get_current_time",
    description: "Get the current date and time in ISO format",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "calculate",
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
  },
  {
    type: "function",
    name: "random_number",
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
  },
  {
    type: "function",
    name: "string_transform",
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
  },
];

function executeTool(name: string, args: unknown): unknown {
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

  useEffect(() => {
    void (async () => {
      try {
        const roleRecord = await getRoles();
        setRoles(roleRecord);
      } catch (error) {
        setStatus(`Failed to load roles: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Build the prompt for the AI SDK
  const buildPrompt = useCallback(
    (msgs: ChatMessage[], results: Map<string, ToolResult>): LanguageModelV2Prompt => {
      const prompt: LanguageModelV2Prompt = [
        {
          role: "system",
          content: `You are a helpful assistant with access to tools. Use tools when appropriate to help answer questions.

Available tools:
- get_current_time: Get the current date and time
- calculate: Evaluate mathematical expressions
- random_number: Generate random numbers in a range
- string_transform: Transform strings (reverse, uppercase, lowercase, length)

When you need to use a tool, make a tool call. After receiving results, provide a helpful response to the user.`,
        },
      ];

      for (const msg of msgs) {
        if (msg.role === "user") {
          const textParts = msg.parts.filter((p) => p.type === "text") as Array<{ type: "text"; text: string }>;
          if (textParts.length > 0) {
            prompt.push({
              role: "user",
              content: textParts,
            });
          }
        } else if (msg.role === "assistant") {
          const content: Array<
            | { type: "text"; text: string }
            | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
          > = [];
          for (const part of msg.parts) {
            if (part.type === "text" && part.text) {
              content.push({ type: "text", text: part.text });
            } else if (part.type === "tool-call" && part.toolCallId) {
              // Only include tool calls that have a valid toolCallId
              content.push({
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.args,
              });
            }
          }
          if (content.length > 0) {
            prompt.push({ role: "assistant", content });
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
            prompt.push({ role: "tool", content: toolResultParts });
          }
        }
      }

      return prompt;
    },
    []
  );

  const runAgentLoop = useCallback(
    async (initialMessages: ChatMessage[], initialResults: Map<string, ToolResult>) => {
      if (!roles) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setStatus("");

      let currentMessages = [...initialMessages];
      let currentResults = new Map(initialResults);
      const maxIterations = 10;

      try {
        for (let iteration = 0; iteration < maxIterations; iteration++) {
          // Add pending assistant message
          const assistantMsg: ChatMessage = { role: "assistant", parts: [], pending: true };
          currentMessages = [...currentMessages, assistantMsg];
          setMessages(currentMessages);

          // Build prompt and call model
          const prompt = buildPrompt(currentMessages.slice(0, -1), currentResults);
          const model = models[selectedRole];

          const { stream } = await model.doStream({
            prompt,
            tools: TOOLS,
            toolChoice: { type: "auto" },
            abortSignal: controller.signal,
          });

          // Process stream
          let textContent = "";
          const toolCalls: ToolCall[] = [];
          const toolCallArgsBuffers = new Map<string, string>();
          const reader = stream.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || typeof value !== "object") continue;

            const chunk = value as { type: string; [key: string]: unknown };

            switch (chunk.type) {
              case "text-delta":
                textContent += (chunk.delta as string) ?? "";
                currentMessages = currentMessages.slice(0, -1);
                assistantMsg.parts = [{ type: "text", text: textContent }, ...toolCalls.map(tc => ({
                  type: "tool-call" as const,
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  args: tc.args,
                }))];
                currentMessages = [...currentMessages, { ...assistantMsg }];
                setMessages(currentMessages);
                break;

              case "tool-input-start": {
                const toolCallId = chunk.toolCallId as string;
                const toolName = chunk.toolName as string;
                toolCallArgsBuffers.set(toolCallId, "");
                toolCalls.push({ toolCallId, toolName, args: {} });
                break;
              }

              case "tool-input-delta": {
                const toolCallId = chunk.toolCallId as string;
                const delta = chunk.inputTextDelta as string;
                const current = toolCallArgsBuffers.get(toolCallId) ?? "";
                toolCallArgsBuffers.set(toolCallId, current + delta);
                break;
              }

              case "tool-input-end": {
                const toolCallId = chunk.toolCallId as string;
                const argsStr = toolCallArgsBuffers.get(toolCallId) ?? "{}";
                const tc = toolCalls.find((t) => t.toolCallId === toolCallId);
                if (tc) {
                  try {
                    tc.args = JSON.parse(argsStr);
                  } catch {
                    tc.args = { raw: argsStr };
                  }
                }
                // Update UI with tool call
                currentMessages = currentMessages.slice(0, -1);
                assistantMsg.parts = [
                  ...(textContent ? [{ type: "text" as const, text: textContent }] : []),
                  ...toolCalls.map(t => ({
                    type: "tool-call" as const,
                    toolCallId: t.toolCallId,
                    toolName: t.toolName,
                    args: t.args,
                  })),
                ];
                currentMessages = [...currentMessages, { ...assistantMsg }];
                setMessages(currentMessages);
                break;
              }

              case "finish":
                assistantMsg.pending = false;
                currentMessages = currentMessages.slice(0, -1);
                assistantMsg.parts = [
                  ...(textContent ? [{ type: "text" as const, text: textContent }] : []),
                  ...toolCalls.map(t => ({
                    type: "tool-call" as const,
                    toolCallId: t.toolCallId,
                    toolName: t.toolName,
                    args: t.args,
                  })),
                ];
                currentMessages = [...currentMessages, { ...assistantMsg }];
                setMessages(currentMessages);
                break;

              case "error":
                throw new Error(String(chunk.error));
            }
          }

          // If no tool calls, we're done
          if (toolCalls.length === 0) {
            break;
          }

          // Execute tool calls and add results
          const toolResultParts: MessagePart[] = [];
          for (const tc of toolCalls) {
            let result: unknown;
            let isError = false;
            try {
              result = executeTool(tc.toolName, tc.args);
            } catch (err) {
              result = { error: err instanceof Error ? err.message : String(err) };
              isError = true;
            }

            const toolResult: ToolResult = {
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              result,
              isError,
            };
            currentResults.set(tc.toolCallId, toolResult);
            toolResultParts.push({
              type: "tool-result",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              result,
              isError,
            });
          }

          setToolResults(new Map(currentResults));

          // Add tool message with results
          const toolMsg: ChatMessage = { role: "tool", parts: toolResultParts };
          currentMessages = [...currentMessages, toolMsg];
          setMessages(currentMessages);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [roles, selectedRole, buildPrompt]
  );

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !roles) return;

    abortRef.current?.abort();

    const userMsg: ChatMessage = { role: "user", parts: [{ type: "text", text: trimmed }] };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");

    await runAgentLoop(newMessages, toolResults);
  }, [input, roles, messages, toolResults, runAgentLoop]);

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
              AI with tool calling via @natstack/ai
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
            {TOOLS.map((tool) => (
              <Badge key={tool.name} variant="outline" size="1">
                {tool.name}
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
