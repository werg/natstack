import { useState, useRef, useEffect, useCallback } from "react";
import { Box, Callout, Card, Flex, IconButton, Text, TextArea } from "@radix-ui/themes";
import { PaperPlaneIcon, ImageIcon, Cross2Icon } from "@radix-ui/react-icons";
import { useIsMobile, useTouchDevice, useViewportHeight } from "@workspace/react/responsive";
import { useChatContext } from "../context/ChatContext";
import { getMentionsFromInput, useChatInputContext } from "../context/ChatInputContext";
import { ImageInput, getAttachmentInputsFromPendingImages } from "./ImageInput";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { useMentionAutocomplete, type MentionCandidate } from "../hooks/useMentionAutocomplete";
import {
  getImagesFromClipboard,
  createPendingImage,
  validateImageFiles,
  type PendingImage,
} from "../utils/imageUtils";

const MAX_IMAGE_COUNT = 10;

/**
 * Chat input area with text input, image attachment, and send button.
 * Reads from ChatContext.
 */
export function ChatInput() {
  const { connected, allParticipants } = useChatContext();
  const {
    input,
    pendingImages,
    onInputChange,
    onSendMessage,
    onImagesChange,
    replyTo,
    replyToMessage,
    setReplyTo,
  } = useChatInputContext();
  const isMobile = useIsMobile();
  const isTouch = useTouchDevice();
  const viewportHeight = useViewportHeight();
  const iconButtonSize: "2" | "3" = isMobile ? "2" : isTouch ? "3" : "2";

  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImageInput, setShowImageInput] = useState(false);
  const [selectedMentionIds, setSelectedMentionIds] = useState<Record<string, string>>({});
  const mentions = useMentionAutocomplete(allParticipants);

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

  useEffect(() => {
    if (replyTo) textAreaRef.current?.focus();
  }, [replyTo]);

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
      const attachments =
        pendingImages.length > 0 ? getAttachmentInputsFromPendingImages(pendingImages) : undefined;
      await onSendMessage(attachments, {
        mentions: getMentionsFromInput(input, allParticipants, selectedMentionIds),
        replyTo: replyTo ?? undefined,
      });
      onImagesChange([]);
      setShowImageInput(false);
      setSelectedMentionIds({});
      mentions.close();
      if (textAreaRef.current) {
        textAreaRef.current.style.height = "auto";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSendError(message);
      console.error("Failed to send message:", error);
    }
  }, [
    onSendMessage,
    pendingImages,
    onImagesChange,
    input,
    allParticipants,
    selectedMentionIds,
    replyTo,
    mentions,
  ]);

  const handleInputChange = useCallback(
    (value: string) => {
      if (sendError) setSendError(null);
      onInputChange(value);
      const textArea = textAreaRef.current;
      if (textArea) mentions.updateFromTextArea(textArea, value);
    },
    [onInputChange, sendError, mentions]
  );

  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      const textArea = textAreaRef.current;
      if (!textArea) return;
      const caret = textArea.selectionStart ?? input.length;
      const start = mentions.triggerStart >= 0 ? mentions.triggerStart : caret;
      const before = input.slice(0, start);
      const after = input.slice(caret);
      const spacer = after.startsWith(" ") ? "" : " ";
      const next = `${before}@${candidate.handle}${spacer}${after}`;
      const nextCaret = before.length + candidate.handle.length + 1 + spacer.length;
      onInputChange(next);
      setSelectedMentionIds((current) => ({
        ...current,
        [candidate.handle.toLowerCase()]: candidate.participantId,
      }));
      mentions.close();
      requestAnimationFrame(() => {
        textArea.focus();
        textArea.setSelectionRange(nextCaret, nextCaret);
        handleTextAreaInput();
      });
    },
    [input, mentions, onInputChange, handleTextAreaInput]
  );

  const handleImagesChange = useCallback(
    (images: PendingImage[]) => {
      if (sendError) setSendError(null);
      onImagesChange(images);
    },
    [onImagesChange, sendError]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mentions.open) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          mentions.setSelectedIndex(mentions.selectedIndex + 1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          mentions.setSelectedIndex(Math.max(0, mentions.selectedIndex - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          mentions.close();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const candidate = mentions.candidates[mentions.selectedIndex];
          if (candidate) insertMention(candidate);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSendMessage();
      }
    },
    [handleSendMessage, mentions, insertMention]
  );

  const toggleImageInput = useCallback(() => {
    if (sendError) setSendError(null);
    setShowImageInput((prev) => !prev);
  }, [sendError]);

  const handleSendClick = useCallback(() => {
    void handleSendMessage();
  }, [handleSendMessage]);

  return (
    <>
      {/* Error display */}
      {sendError && (
        <Box flexShrink="0">
          <Callout.Root color="red" size="1">
            <Callout.Text>Failed to send: {sendError}</Callout.Text>
          </Callout.Root>
        </Box>
      )}

      {/* Image input - shown when toggled or when images are pending */}
      {(showImageInput || pendingImages.length > 0) && (
        <Card
          className="chat-surface-card chat-attachment-card"
          size="1"
          variant="surface"
          style={{ flexShrink: 0 }}
        >
          <ImageInput
            images={pendingImages}
            onImagesChange={handleImagesChange}
            onError={(error) => setSendError(error)}
            disabled={!connected}
          />
        </Card>
      )}

      {/* Input */}
      <Card
        className="chat-surface-card chat-input-card"
        size="1"
        variant="surface"
        style={{ flexShrink: 0 }}
      >
        {replyTo && (
          <Flex align="center" justify="between" gap="2" mb="2">
            <Text size="1" color="gray" truncate>
              Replying to{" "}
              {replyToMessage?.senderMetadata?.name ?? replyToMessage?.senderId ?? "message"}
              {replyToMessage?.content ? `: ${replyToMessage.content.slice(0, 80)}` : ""}
            </Text>
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              onClick={() => setReplyTo(null)}
              title="Cancel reply"
            >
              <Cross2Icon />
            </IconButton>
          </Flex>
        )}
        <Flex align="stretch" gap="2">
          <Box style={{ position: "relative", flex: 1 }}>
            {mentions.open && (
              <MentionAutocomplete
                candidates={mentions.candidates}
                selectedIndex={mentions.selectedIndex}
                position={mentions.caretPosition}
                onHighlight={mentions.setSelectedIndex}
                onSelect={insertMention}
              />
            )}
            <TextArea
              ref={textAreaRef}
              size="2"
              variant="surface"
              style={{
                width: "100%",
                minHeight: isMobile ? 38 : 42,
                maxHeight: isMobile ? Math.min(120, viewportHeight * 0.22) : 180,
                resize: "none",
              }}
              placeholder={
                isMobile
                  ? "Type a message..."
                  : "Type a message... (Enter to send, Shift+Enter for new line)"
              }
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onInput={handleTextAreaInput}
              onKeyDown={handleKeyDown}
              disabled={!connected}
            />
          </Box>
          <Flex className="chat-input-actions" direction="column" gap="1" align="center" justify="center">
            <IconButton
              className="chat-input-action-button"
              variant={showImageInput || pendingImages.length > 0 ? "soft" : "ghost"}
              size={iconButtonSize}
              onClick={toggleImageInput}
              disabled={!connected}
              color={pendingImages.length > 0 ? "blue" : "gray"}
              title={pendingImages.length > 0 ? `${pendingImages.length} image${pendingImages.length > 1 ? "s" : ""} attached` : "Attach images"}
              aria-label="Attach images"
            >
              <Box position="relative" asChild>
                <span>
                  <ImageIcon />
                  {pendingImages.length > 0 && (
                    <Text as="span" className="chat-input-attachment-count" size="1">
                      {pendingImages.length}
                    </Text>
                  )}
                </span>
              </Box>
            </IconButton>
            <IconButton
              className="chat-input-action-button chat-input-send-button"
              onClick={handleSendClick}
              disabled={!connected || (!input.trim() && pendingImages.length === 0)}
              size={iconButtonSize}
              variant="solid"
              title="Send message"
              aria-label="Send message"
            >
              <PaperPlaneIcon />
            </IconButton>
          </Flex>
        </Flex>
      </Card>
    </>
  );
}
