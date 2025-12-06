import { useCallback, useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { Box, Flex, Button, TextArea, Text, Badge } from "@radix-ui/themes";
import { StopIcon } from "@radix-ui/react-icons";
import { inputValueAtom } from "../../state/uiAtoms";
import { useSendMessage, useIsGenerating, useAbortGeneration, useQueueMessage, useHasQueuedMessages, useProcessQueue } from "../../hooks/useChannel";
import { useAgent } from "../../hooks/useAgent";
import { useInputKeyHandler } from "../../hooks/useKeyboardShortcuts";

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
 * InputArea - Text input composer.
 */
export function InputArea() {
  const [inputValue, setInputValue] = useAtom(inputValueAtom);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendMessage = useSendMessage();
  const queueMessage = useQueueMessage();
  const hasQueuedMessages = useHasQueuedMessages();
  const processQueue = useProcessQueue();
  const isGenerating = useIsGenerating();
  const abortGeneration = useAbortGeneration();
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
  }, [
    inputValue,
    isGenerating,
    setInputValue,
    sendMessage,
    queueMessage,
    generate,
  ]);

  // Keyboard handler
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

      {/* Input and buttons */}
      <Box style={{ position: "relative" }}>
        <TextArea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isGenerating
              ? "Type a message (will be queued)..."
              : "Type a message..."
          }
          style={{
            minHeight: "72px",
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
            {isGenerating ? "Queue" : "Send"}
          </Button>
        </Flex>
      </Box>

      {/* Keyboard hint */}
      <Flex justify="end" mt="1">
        <Text size="1" color="gray">
          {isGenerating
            ? "Press Enter to queue message, Escape to stop"
            : "Press Enter to send"}
        </Text>
      </Flex>
    </Box>
  );
}
