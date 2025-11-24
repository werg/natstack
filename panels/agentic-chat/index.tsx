import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createReactPanelMount } from "natstack/react";
import { models, getAvailableModels, type AIModelInfo } from "natstack/ai";
import { Theme, Box, Flex, Card, Text, Heading, Button, TextArea, Select, Callout, Separator } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";

type ChatTurn = { role: "user" | "assistant"; text: string; pending?: boolean };
type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<{ type: "text"; text: string }> }
  | { role: "assistant"; content: Array<{ type: "text"; text: string }> };

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

function App() {
  const [availableModels, setAvailableModels] = useState<AIModelInfo[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const modelsList = await getAvailableModels();
        setAvailableModels(modelsList);
        if (!modelId && modelsList.length > 0) {
          setModelId(modelsList[0].id);
        }
      } catch (error) {
        setStatus(`Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [modelId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const prompt = useMemo((): PromptMessage[] => {
    const base: PromptMessage[] = [
      {
        role: "system",
        content:
          "You are a concise agentic coding assistant. When unsure, ask a follow-up. Prefer short answers and include a next action.",
      },
    ];
    const history = messages.map<PromptMessage>((m) => ({
      role: m.role,
      content: [{ type: "text", text: m.text }],
    }));
    return [...base, ...history];
  }, [messages]);

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || !modelId) return;

    abortRef.current?.abort();

    const nextMessages: ChatTurn[] = [...messages, { role: "user", text: trimmed }];
    setMessages([...nextMessages, { role: "assistant", text: "", pending: true }]);
    setInput("");
    setStatus("");

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    try {
      const model = models[modelId];
      const { stream } = await model.doStream({
        prompt: [...prompt, { role: "user", content: [{ type: "text", text: trimmed }] }],
        abortSignal: controller.signal,
      });

      let assistantText = "";
      let finished = false;
      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || typeof value !== "object") continue;

        switch ((value as { type?: string }).type) {
          case "text-delta":
            assistantText += (value as { delta?: string }).delta ?? "";
            setMessages([...nextMessages, { role: "assistant", text: assistantText, pending: true }]);
            break;
          case "finish":
            finished = true;
            setMessages([...nextMessages, { role: "assistant", text: assistantText, pending: false }]);
            break;
          case "error":
            finished = true;
            console.error("Generation error:", value);
            setStatus(`Generation error: ${(value as { error?: unknown }).error ?? "unknown error"}`);
            setMessages([...nextMessages, { role: "assistant", text: assistantText, pending: false }]);
            break;
          default:
            break;
        }
      }

      if (!finished) {
        setMessages([...nextMessages, { role: "assistant", text: assistantText, pending: false }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  return (
    <Box p="4" style={{ height: "100%" }}>
      <Flex direction="column" gap="4" style={{ height: "100%" }}>
        <Flex align="center" justify="between">
          <Box>
            <Heading size="4">Agentic Chat</Heading>
            <Text color="gray">natstack/ai proxy with Anthropic</Text>
          </Box>
          <Flex align="center" gap="3">
            <Box>
              <Text size="1" color="gray">
                Model
              </Text>
              <Select.Root value={modelId ?? ""} onValueChange={(value) => setModelId(value)}>
                <Select.Trigger placeholder="Select a model" size="2" disabled={!availableModels.length} />
                <Select.Content>
                  {availableModels.map((m) => (
                    <Select.Item key={m.id} value={m.id}>
                      {m.displayName ?? m.id}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
            <Button variant="soft" color="gray" onClick={cancel} disabled={!streaming} size="2">
              Cancel
            </Button>
          </Flex>
        </Flex>

        <Card variant="surface" style={{ flex: 1, overflow: "auto" }}>
          {messages.length === 0 ? (
            <Flex align="center" justify="center" style={{ height: "100%" }}>
              <Text color="gray">Ask a coding question to start chatting.</Text>
            </Flex>
          ) : (
            <Flex direction="column" gap="2">
              {messages.map((m, idx) => (
                <Card key={idx} variant="ghost">
                  <Text size="1" color={m.role === "user" ? "gray" : "blue"}>
                    {m.role === "user" ? "You" : "Assistant"}
                  </Text>
                  <Separator size="2" my="2" />
                  <Text style={{ whiteSpace: "pre-wrap" }}>{m.text || (m.pending ? "…" : "")}</Text>
                </Card>
              ))}
            </Flex>
          )}
        </Card>

        <Card variant="surface">
          <Flex direction="column" gap="3">
            <TextArea
              size="2"
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Shift+Enter for newline. Enter to send."
              disabled={!modelId || streaming}
            />
            <Flex align="center" justify="between" gap="3">
              {status ? (
                <Callout.Root color="red" size="1">
                  <Callout.Text>{status}</Callout.Text>
                </Callout.Root>
              ) : (
                <Box />
              )}
              <Button onClick={() => void sendMessage()} disabled={!modelId || streaming || !input.trim()} size="2">
                {streaming ? "Streaming…" : "Send"}
              </Button>
            </Flex>
          </Flex>
        </Card>
      </Flex>
    </Box>
  );
}

mount(App);
