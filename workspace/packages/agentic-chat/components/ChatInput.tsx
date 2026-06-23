import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Box, Button, Callout, Card, Flex, IconButton, Spinner, Text, TextArea } from "@radix-ui/themes";
import { Cross2Icon } from "@radix-ui/react-icons";
import { useIsMobile, useTouchDevice, useViewportHeight } from "@workspace/react/responsive";
import { useChatContext } from "../context/ChatContext";
import { getMentionsFromInput, useChatInputContext } from "../context/ChatInputContext";
import { ImageInput, getAttachmentInputsFromPendingImages } from "./ImageInput";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { SendButton } from "./SendButton";
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
  const {
    connected,
    allParticipants,
    selfId,
    agentBusy,
    hasOpenTurn,
    primaryActionIntent,
    flushOutboxAndInterrupt,
    flushNarration,
    undoableAction,
    undoLastAction,
    pendingSendCount,
  } = useChatContext();
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
  const sendButtonSize: "2" | "3" = isMobile ? "2" : isTouch ? "3" : "2";

  // Light haptic tick on send (touch devices). Settings-gated; default-on tick.
  const hapticTick = useCallback(() => {
    if (isTouch && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(8);
      } catch {
        /* best-effort */
      }
    }
  }, [isTouch]);

  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImageInput, setShowImageInput] = useState(false);
  const [selectedMentionIds, setSelectedMentionIds] = useState<Record<string, string>>({});
  const mentions = useMentionAutocomplete(allParticipants, selfId);

  // Auto-resize textarea: rAF-coalesced onInput handler.
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

  const handleSendMessage = useCallback(
    async (mode: "default" | "after-turn" = "default") => {
      try {
        setSendError(null);
        const attachments =
          pendingImages.length > 0
            ? getAttachmentInputsFromPendingImages(pendingImages)
            : undefined;
        const effectiveMode = mode === "after-turn" && hasOpenTurn ? "after-turn" : "default";
        await onSendMessage(attachments, {
          mentions: getMentionsFromInput(input, allParticipants, selectedMentionIds),
          replyTo: replyTo ?? undefined,
          // After-turn delivery is a message intent in payload.metadata.
          ...(effectiveMode === "after-turn" ? { metadata: { deliverAfterTurn: true } } : {}),
        });
        hapticTick();
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
    },
    [
      onSendMessage,
      pendingImages,
      onImagesChange,
      input,
      allParticipants,
      selectedMentionIds,
      replyTo,
      mentions,
      hapticTick,
      hasOpenTurn,
    ]
  );

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
      const mod = e.metaKey || e.ctrlKey;
      // Escape = flush (advance the pipeline one step) + interrupt, gated on the
      // mention popover being closed AND the composer empty (flush is
      // incremental, so a stray Escape should not dump the queue).
      if (e.key === "Escape" && !mentions.open && input.trim().length === 0 && agentBusy) {
        e.preventDefault();
        void flushOutboxAndInterrupt();
        return;
      }
      if (e.key === "Enter") {
        if (e.shiftKey && !mod) {
          // Shift+Enter = newline (default behavior).
          return;
        }
        e.preventDefault();
        if (mod && e.shiftKey) {
          // Cmd/Ctrl+Shift+Enter = send after turn.
          void handleSendMessage("after-turn");
        } else {
          // Enter (or Cmd/Ctrl+Enter) = send default (steers if mid-turn).
          void handleSendMessage("default");
        }
      }
    },
    [handleSendMessage, mentions, insertMention, input, agentBusy, flushOutboxAndInterrupt]
  );

  const toggleImageInput = useCallback(() => {
    if (sendError) setSendError(null);
    setShowImageInput((prev) => !prev);
  }, [sendError]);

  const handleSendClick = useCallback(() => {
    void handleSendMessage("default");
  }, [handleSendMessage]);
  const handleSendAfterTurn = useCallback(() => {
    void handleSendMessage("after-turn");
  }, [handleSendMessage]);

  const canSend = connected && (input.trim().length > 0 || pendingImages.length > 0);

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
        {/* The send control is docked in the input's lower-right corner (inside
            the field, not beside it). It stays put as the textarea grows; the
            textarea reserves right-padding so text never runs under it. */}
        <Box style={{ position: "relative" }}>
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
            className="chat-input-textarea"
            style={{
              width: "100%",
              // Match the dock's default band so the send button sits centered in
              // the default two-line composer (see .chat-input-send-dock).
              minHeight: "var(--composer-min-h, 3.5rem)",
              maxHeight: isMobile ? Math.min(120, viewportHeight * 0.22) : 180,
              resize: "none",
            }}
            placeholder={isMobile ? "Type a message…" : "Type a message…  (⏎ send · ⇧⏎ newline)"}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onInput={handleTextAreaInput}
            onKeyDown={handleKeyDown}
            disabled={!connected}
          />
          <Box className="chat-input-send-dock">
            <SendButton
              intent={primaryActionIntent}
              agentBusy={agentBusy}
              canSendAfterTurn={hasOpenTurn}
              disabled={!canSend}
              optionsDisabled={!connected}
              size={sendButtonSize}
              onSend={handleSendClick}
              onSendAfterTurn={handleSendAfterTurn}
              onAttach={connected ? toggleImageInput : undefined}
              attachmentCount={pendingImages.length}
            />
          </Box>
        </Box>
        {/* Transient "Sending…" ghost — the only sub-row, shown only in flight. */}
        {pendingSendCount > 0 && (
          <Flex align="center" justify="end" gap="1" mt="1" className="chat-sending-ghost" aria-live="polite">
            <Spinner size="1" />
            <Text size="1" color="gray">
              Sending…
            </Text>
          </Flex>
        )}
      </Card>

      {/* Transient flush self-narration pill. */}
      {flushNarration && (
        <Box flexShrink="0" mt="1" className="chat-narration-pill-wrap" aria-live="polite">
          <Box className="chat-narration-pill">
            <Text size="1">{flushNarration.text}</Text>
          </Box>
        </Box>
      )}

      {/* Reversible-until-committed undo snackbar (~5s). */}
      {undoableAction && (
        <Box flexShrink="0" mt="1" className="chat-undo-snackbar-wrap" aria-live="polite">
          <Flex align="center" justify="between" gap="3" className="chat-undo-snackbar">
            <Text size="1">
              {undoableAction.messageIds.length > 1
                ? `${undoableAction.messageIds.length} messages canceled`
                : "Message canceled"}
            </Text>
            <Button size="1" variant="soft" onClick={() => undoLastAction?.()}>
              Undo
            </Button>
          </Flex>
        </Box>
      )}
    </>
  );
}
