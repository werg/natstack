import { useCallback, useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { Box, Flex, Button, TextArea, SegmentedControl, Select, Text, Badge } from "@radix-ui/themes";
import { StopIcon } from "@radix-ui/react-icons";
import {
  inputModeAtom,
  inputValueAtom,
  codeLanguageAtom,
} from "../../state/uiAtoms";
import { useSendMessage, useIsGenerating, useAbortGeneration, useQueueMessage, useHasQueuedMessages, useProcessQueue } from "../../hooks/useChannel";
import { useKernel } from "../../hooks/useKernel";
import { useAgent } from "../../hooks/useAgent";
import { useInputKeyHandler } from "../../hooks/useKeyboardShortcuts";
import type { CodeLanguage } from "../../types/messages";

/**
 * Working indicator with animated dots.
 */
function WorkingIndicator() {
  return (
    <Flex align="center" gap="2">
      <Box
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--accent-9)",
          animation: "pulse 1.5s ease-in-out infinite",
        }}
      />
      <Text size="1" color="gray">
        Working...
      </Text>
      <style>
        {`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}
      </style>
    </Flex>
  );
}

/**
 * InputArea - Input composer with text/code toggle.
 */
export function InputArea() {
  const [inputMode, setInputMode] = useAtom(inputModeAtom);
  const [inputValue, setInputValue] = useAtom(inputValueAtom);
  const [codeLanguage, setCodeLanguage] = useAtom(codeLanguageAtom);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendMessage = useSendMessage();
  const queueMessage = useQueueMessage();
  const hasQueuedMessages = useHasQueuedMessages();
  const processQueue = useProcessQueue();
  const isGenerating = useIsGenerating();
  const abortGeneration = useAbortGeneration();
  const { executeFromUser } = useKernel();
  const { generate } = useAgent();

  // Process queued messages when generation completes
  useEffect(() => {
    if (!isGenerating && hasQueuedMessages) {
      processQueue();
    }
  }, [isGenerating, hasQueuedMessages, processQueue]);

  // Handle send - allows sending while generating (queues the message)
  const handleSend = useCallback(async () => {
    if (!inputValue.trim()) return;

    const value = inputValue.trim();
    setInputValue("");

    if (inputMode === "text") {
      const messageData = {
        participantId: "user",
        participantType: "user" as const,
        content: {
          type: "text" as const,
          text: value,
        },
      };

      if (isGenerating) {
        // Queue the message if currently generating
        queueMessage(messageData);
      } else {
        // Send immediately and generate response
        sendMessage(messageData);

        // Generate agent response
        try {
          await generate();
        } catch (error) {
          console.error("Generation failed:", error);
        }
      }
    } else {
      // Execute code - can run even while generating
      try {
        await executeFromUser(value, codeLanguage, "user");
      } catch (error) {
        console.error("Execution failed:", error);
      }
    }
  }, [
    inputValue,
    inputMode,
    codeLanguage,
    isGenerating,
    setInputValue,
    sendMessage,
    queueMessage,
    executeFromUser,
    generate,
  ]);

  // Keyboard handler - always enabled for typing
  const { handleKeyDown } = useInputKeyHandler(handleSend, {
    disabled: false,
  });

  return (
    <Box
      px="4"
      py="3"
      style={{
        borderTop: "1px solid var(--gray-a5)",
        background: "var(--gray-1)",
        flexShrink: 0,
      }}
    >
      {/* Working indicator */}
      {isGenerating && (
        <Flex justify="between" align="center" mb="2">
          <WorkingIndicator />
          {hasQueuedMessages && (
            <Badge size="1" color="blue">
              Messages queued
            </Badge>
          )}
        </Flex>
      )}

      {/* Mode toggle and language selector */}
      <Flex justify="between" align="center" mb="2">
        <SegmentedControl.Root
          value={inputMode}
          onValueChange={(value) => setInputMode(value as "text" | "code")}
          size="1"
        >
          <SegmentedControl.Item value="text">Text</SegmentedControl.Item>
          <SegmentedControl.Item value="code">Code</SegmentedControl.Item>
        </SegmentedControl.Root>

        {inputMode === "code" && (
          <Select.Root
            value={codeLanguage}
            onValueChange={(value) => setCodeLanguage(value as CodeLanguage)}
            size="1"
          >
            <Select.Trigger />
            <Select.Content>
              <Select.Item value="typescript">TypeScript</Select.Item>
              <Select.Item value="javascript">JavaScript</Select.Item>
              <Select.Item value="tsx">TSX</Select.Item>
              <Select.Item value="jsx">JSX</Select.Item>
            </Select.Content>
          </Select.Root>
        )}
      </Flex>

      {/* Input and buttons */}
      <Box style={{ position: "relative" }}>
        <TextArea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isGenerating && inputMode === "text"
              ? "Type a message (will be queued)..."
              : inputMode === "text"
                ? "Type a message..."
                : `Enter ${codeLanguage} code...`
          }
          style={{
            minHeight: inputMode === "code" ? "140px" : "72px",
            fontFamily: inputMode === "code" ? "monospace" : "inherit",
            resize: "none",
            width: "100%",
            paddingRight: "96px",
            background: "var(--gray-1)",
          }}
        />

        <Flex
          direction="column"
          gap="1"
          style={{
            position: "absolute",
            right: "12px",
            bottom: "12px",
            alignItems: "flex-end",
          }}
        >
          {isGenerating && (
            <Button
              color="red"
              variant="soft"
              size="1"
              onClick={abortGeneration}
            >
              <StopIcon />
              Stop
            </Button>
          )}
          <Button
            onClick={handleSend}
            disabled={!inputValue.trim()}
            variant={isGenerating ? "soft" : "solid"}
            size="2"
          >
            {isGenerating
              ? "Queue"
              : inputMode === "text"
                ? "Send"
                : "Run"}
          </Button>
        </Flex>
      </Box>

      {/* Keyboard hint */}
      <Flex justify="end" mt="1">
        <Text size="1" color="gray">
          {isGenerating
            ? "Press Enter to queue message, Escape to stop"
            : `Press Enter to ${inputMode === "text" ? "send" : "run"}`}
        </Text>
      </Flex>
    </Box>
  );
}
