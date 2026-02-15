import { useState, useRef, useEffect, useCallback } from "react";
import { Box, Callout, Card, Flex, IconButton, TextArea } from "@radix-ui/themes";
import { PaperPlaneIcon, ImageIcon } from "@radix-ui/react-icons";
import { useChatContext } from "../context/ChatContext";
import { useChatInputContext } from "../context/ChatInputContext";
import { ImageInput, getAttachmentInputsFromPendingImages } from "./ImageInput";
import { getImagesFromClipboard, createPendingImage, validateImageFiles, type PendingImage } from "../utils/imageUtils";

const MAX_IMAGE_COUNT = 10;

/**
 * Chat input area with text input, image attachment, and send button.
 * Reads from ChatContext.
 */
export function ChatInput() {
  const { connected } = useChatContext();
  const { input, pendingImages, onInputChange, onSendMessage, onImagesChange } = useChatInputContext();

  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImageInput, setShowImageInput] = useState(false);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (sendError) {
      const timer = setTimeout(() => setSendError(null), 5000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [sendError]);

  // Auto-resize textarea: use rAF-coalesced onInput handler
  const resizeRafRef = useRef(0);
  const handleTextAreaInput = useCallback(() => {
    const textArea = textAreaRef.current;
    if (!textArea) return;
    cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      textArea.style.height = "auto";
      textArea.style.height = `${textArea.scrollHeight}px`;
    });
  }, []);
  useEffect(() => {
    return () => cancelAnimationFrame(resizeRafRef.current);
  }, []);

  // Handle paste for images
  useEffect(() => {
    if (!connected) return;

    const handlePaste = async (event: ClipboardEvent) => {
      try {
        const files = getImagesFromClipboard(event);
        if (files.length === 0) return;

        event.preventDefault();

        if (pendingImages.length + files.length > MAX_IMAGE_COUNT) {
          setSendError(`Maximum ${MAX_IMAGE_COUNT} images allowed`);
          return;
        }

        const validation = validateImageFiles(files);
        if (!validation.valid) {
          setSendError(validation.error ?? "Invalid image");
          return;
        }

        const newImages: PendingImage[] = [];
        for (const file of files) {
          try {
            const pending = await createPendingImage(file);
            newImages.push(pending);
          } catch (err) {
            console.error("[ChatInput] Failed to process pasted image:", err);
          }
        }

        if (newImages.length > 0) {
          onImagesChange([...pendingImages, ...newImages]);
        }
      } catch (err) {
        console.error("[ChatInput] Image paste handler error:", err);
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [connected, pendingImages, onImagesChange]);

  const handleSendMessage = useCallback(async () => {
    try {
      setSendError(null);
      const attachments = pendingImages.length > 0
        ? getAttachmentInputsFromPendingImages(pendingImages)
        : undefined;
      await onSendMessage(attachments);
      onImagesChange([]);
      setShowImageInput(false);
      if (textAreaRef.current) {
        textAreaRef.current.style.height = "auto";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message);
      console.error("Failed to send message:", error);
    }
  }, [onSendMessage, pendingImages, onImagesChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  }, [handleSendMessage]);

  const toggleImageInput = useCallback(() => {
    setShowImageInput((prev) => !prev);
  }, []);

  const handleSendClick = useCallback(() => {
    void handleSendMessage();
  }, [handleSendMessage]);

  return (
    <>
      {/* Error display */}
      {sendError && (
        <Box flexShrink="0">
          <Callout.Root color="red" size="1">
            <Callout.Text>
              Failed to send: {sendError}
            </Callout.Text>
          </Callout.Root>
        </Box>
      )}

      {/* Image input - shown when toggled or when images are pending */}
      {(showImageInput || pendingImages.length > 0) && (
        <Box flexShrink="0">
          <Card size="1">
            <ImageInput
              images={pendingImages}
              onImagesChange={onImagesChange}
              onError={(error) => setSendError(error)}
              disabled={!connected}
            />
          </Card>
        </Box>
      )}

      {/* Input */}
      <Box flexShrink="0">
      <Card size="1">
        <Flex align="end" gap="1" p="0">
          <TextArea
            ref={textAreaRef}
            size="2"
            variant="surface"
            style={{ flex: 1, minHeight: 48, maxHeight: 200, resize: "none" }}
            placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onInput={handleTextAreaInput}
            onKeyDown={handleKeyDown}
            disabled={!connected}
          />
          <Flex direction="column" gap="2">
            <IconButton
              variant="ghost"
              size="2"
              onClick={toggleImageInput}
              disabled={!connected}
              color={pendingImages.length > 0 ? "blue" : "gray"}
              title="Attach images"
            >
              <ImageIcon />
            </IconButton>
            <IconButton
              onClick={handleSendClick}
              disabled={!connected || (!input.trim() && pendingImages.length === 0)}
              size="2"
              variant="soft"
            >
              <PaperPlaneIcon />
            </IconButton>
          </Flex>
        </Flex>
      </Card>
      </Box>
    </>
  );
}
