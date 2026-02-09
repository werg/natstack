import { useState, useRef, useEffect, useCallback, useMemo, type ComponentType } from "react";
import { Badge, Box, Button, Callout, Card, Flex, IconButton, Text, TextArea, Theme } from "@radix-ui/themes";
import { PaperPlaneIcon, ImageIcon } from "@radix-ui/react-icons";
import type { Participant, AttachmentInput } from "@natstack/pubsub";
import type { AgentDebugPayload } from "@natstack/agentic-messaging";
import {
  FeedbackContainer,
  FeedbackFormRenderer,
  type ActiveFeedback,
  type ToolApprovalProps,
} from "@natstack/tool-ui";
import type { MethodHistoryEntry } from "./MethodHistoryItem";
import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";
import { ImageInput, getAttachmentInputsFromPendingImages } from "./ImageInput";
import { MessageList } from "./MessageList";
import { type PendingImage, getImagesFromClipboard, createPendingImage, validateImageFiles } from "../utils/imageUtils";
import type { ChatMessage, ChatParticipantMetadata, PendingAgent } from "../types";
import { AgentDebugConsole } from "./AgentDebugConsole";
import { DirtyRepoWarning } from "./DirtyRepoWarning";
import { PendingAgentBadge } from "./PendingAgentBadge";
import "../styles.css";

const MAX_IMAGE_COUNT = 10;
// Stable no-op function to avoid creating new arrow functions on every render
const NOOP = () => {};

interface ChatPhaseProps {
  channelId: string | null;
  connected: boolean;
  status: string;
  messages: ChatMessage[];
  input: string;
  /** Currently connected participants — used for the roster bar */
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  /** All participants ever seen (current + historical) — used for message sender lookups */
  allParticipants?: Record<string, Participant<ChatParticipantMetadata>>;
  activeFeedbacks: Map<string, ActiveFeedback>;
  theme: "light" | "dark";
  /** Whether session persistence is enabled (true = restricted/persistent session) */
  sessionEnabled?: boolean;
  /** Pending images for the message */
  pendingImages: PendingImage[];
  /** Whether there are more messages to load from history */
  hasMoreHistory?: boolean;
  /** Whether currently loading more messages */
  loadingMore?: boolean;
  /** Live method entry data — keyed by callId, updated independently of messages */
  methodEntries?: Map<string, MethodHistoryEntry>;
  /** Compiled inline UI components by ID */
  inlineUiComponents?: Map<string, {
    Component?: ComponentType<{ props: Record<string, unknown> }>;
    cacheKey: string;
    error?: string;
  }>;
  /** Debug events for agents (ephemeral, in-memory) */
  debugEvents?: Array<AgentDebugPayload & { ts: number }>;
  /** Currently open debug console agent handle */
  debugConsoleAgent?: string | null;
  /** Dirty repo warnings for agents spawned with uncommitted changes */
  dirtyRepoWarnings?: Map<string, { modified: string[]; untracked: string[]; staged: string[] }>;
  /** Pending agents (starting or failed) - managed by parent, not computed from events */
  pendingAgents?: Map<string, PendingAgent>;
  /** Callback to open/close debug console */
  onDebugConsoleChange?: (agentHandle: string | null) => void;
  /** Callback to load earlier messages */
  onLoadEarlierMessages?: () => void;
  onInputChange: (value: string) => void;
  /** Send message with optional attachments (server assigns IDs) */
  onSendMessage: (attachments?: AttachmentInput[]) => Promise<void>;
  onImagesChange: (images: PendingImage[]) => void;
  /** Add agent to the chat - optional, hides button if not provided */
  onAddAgent?: () => void;
  onReset: () => void;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
  onInterrupt?: (agentId: string, messageId?: string, agentHandle?: string) => void;
  onCallMethod?: (providerId: string, methodName: string, args: unknown) => void;
  /** Focus a disconnected agent's panel */
  onFocusPanel?: (panelId: string) => void;
  /** Reload a disconnected agent's panel */
  onReloadPanel?: (panelId: string) => void;
  /** Dismiss a dirty repo warning */
  onDismissDirtyWarning?: (agentName: string) => void;
  /** Tool approval configuration - optional, when provided enables approval UI */
  toolApproval?: ToolApprovalProps;
}

export function ChatPhase({
  channelId,
  connected,
  status,
  messages,
  input,
  participants,
  allParticipants: allParticipantsProp,
  activeFeedbacks,
  theme,
  sessionEnabled,
  pendingImages,
  hasMoreHistory,
  loadingMore,
  inlineUiComponents,
  methodEntries,
  debugEvents,
  debugConsoleAgent,
  dirtyRepoWarnings,
  pendingAgents,
  onDebugConsoleChange,
  onLoadEarlierMessages,
  onInputChange,
  onSendMessage,
  onImagesChange,
  onAddAgent,
  onReset,
  onFeedbackDismiss,
  onFeedbackError,
  onInterrupt,
  onCallMethod,
  onFocusPanel,
  onReloadPanel,
  onDismissDirtyWarning,
  toolApproval,
}: ChatPhaseProps) {
  // Fall back to current participants for sender lookups if allParticipants not provided
  const allParticipants = allParticipantsProp ?? participants;

  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showImageInput, setShowImageInput] = useState(false);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (sendError) {
      const timer = setTimeout(() => setSendError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [sendError]);

  // Auto-resize textarea: use rAF-coalesced onInput handler instead of useEffect
  // to avoid synchronous layout thrashing on every keystroke.
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
  // Cleanup rAF on unmount
  useEffect(() => {
    return () => cancelAnimationFrame(resizeRafRef.current);
  }, []);

  // Handle paste for images (works even when ImageInput is not visible)
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

        // Create pending images from pasted files
        const newImages: PendingImage[] = [];
        for (const file of files) {
          try {
            const pending = await createPendingImage(file);
            newImages.push(pending);
          } catch (err) {
            console.error("[ChatPhase] Failed to process pasted image:", err);
          }
        }

        if (newImages.length > 0) {
          try {
            onImagesChange([...pendingImages, ...newImages]);
          } catch (err) {
            console.error("[ChatPhase] onImagesChange callback error:", err);
          }
        }
      } catch (err) {
        console.error("[ChatPhase] Image paste handler error:", err);
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

  // Memoize participant active status: single reverse scan instead of O(P*M) filter per render
  const participantActiveStatus = useMemo(() => {
    const status = new Map<string, boolean>();
    const pIds = new Set(Object.keys(participants));
    const found = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && found.size < pIds.size; i--) {
      const msg = messages[i];
      if (msg.kind !== "message" || !pIds.has(msg.senderId) || found.has(msg.senderId)) continue;
      status.set(msg.senderId, !msg.complete && !msg.error);
      found.add(msg.senderId);
    }
    return status;
  }, [messages, participants]);

  return (
    <Theme appearance={theme}>
      <Flex direction="column" height="100vh" p="2" gap="2">
      {/* Header */}
      <Flex justify="between" align="center" flexShrink="0">
        <Flex gap="2" align="center">
          <Text size="5" weight="bold">
            Agentic Chat
          </Text>
          <Badge color="gray">{channelId}</Badge>
          <Badge color={sessionEnabled ? "blue" : "orange"} title={sessionEnabled ? "Session persistence enabled - messages are saved and can be replayed" : "Ephemeral session - messages are not persisted"}>
            {sessionEnabled ? "Session" : "Ephemeral"}
          </Badge>
        </Flex>
        <Flex gap="2" align="center">
          <Badge color={connected ? "green" : "gray"}>{connected ? "Connected" : status}</Badge>
          {Object.values(participants).map((p) => {
            const hasActive = participantActiveStatus.get(p.id) ?? false;

            return (
              <ParticipantBadgeMenu
                key={p.id}
                participant={p}
                hasActiveMessage={hasActive}
                onCallMethod={onCallMethod ?? NOOP}
                isGranted={toolApproval ? p.id in toolApproval.settings.agentGrants : false}
                onRevokeAgent={toolApproval?.onRevokeAgent}
                onOpenDebugConsole={onDebugConsoleChange ? (handle) => onDebugConsoleChange(handle) : undefined}
              />
            );
          })}
          {/* Pending/failed agents not yet in roster */}
          {pendingAgents && Array.from(pendingAgents.entries()).map(([handle, info]) => (
            <PendingAgentBadge
              key={`pending-${handle}`}
              handle={handle}
              agentId={info.agentId}
              status={info.status}
              error={info.error}
              onOpenDebugConsole={onDebugConsoleChange}
            />
          ))}
          {onAddAgent && (
            <Button variant="soft" size="1" onClick={onAddAgent}>
              Add Agent
            </Button>
          )}
          {toolApproval && (
            <ToolPermissionsDropdown
              settings={toolApproval.settings}
              participants={participants}
              onSetFloor={toolApproval.onSetFloor}
              onGrantAgent={toolApproval.onGrantAgent}
              onRevokeAgent={toolApproval.onRevokeAgent}
              onRevokeAll={toolApproval.onRevokeAll}
            />
          )}
          <Button variant="soft" onClick={onReset}>
            Reset
          </Button>
        </Flex>
      </Flex>

      {/* Dirty repo warnings */}
      {dirtyRepoWarnings && dirtyRepoWarnings.size > 0 && (
        <Box px="1" flexShrink="0">
          {Array.from(dirtyRepoWarnings.entries()).map(([name, state]) => (
            <DirtyRepoWarning
              key={name}
              agentName={name}
              dirtyRepo={state}
              onDismiss={() => onDismissDirtyWarning?.(name)}
            />
          ))}
        </Box>
      )}

      {/* Messages — isolated in React.memo'd MessageList; input changes don't reach here */}
      <MessageList
        messages={messages}
        methodEntries={methodEntries}
        allParticipants={allParticipants}
        inlineUiComponents={inlineUiComponents}
        hasMoreHistory={hasMoreHistory}
        loadingMore={loadingMore}
        onLoadEarlierMessages={onLoadEarlierMessages}
        onInterrupt={onInterrupt}
        onFocusPanel={onFocusPanel}
        onReloadPanel={onReloadPanel}
      />

      {activeFeedbacks.size > 0 && (
        <Flex direction="column" gap="2" flexShrink="0">
          {Array.from(activeFeedbacks.values()).map((feedback) => {
            // Render schema-based feedbacks using FeedbackFormRenderer
            if (feedback.type === "schema") {
              return (
                <FeedbackContainer
                  key={feedback.callId}
                  onDismiss={() => onFeedbackDismiss(feedback.callId)}
                  onError={(error) => onFeedbackError(feedback.callId, error)}
                >
                  <FeedbackFormRenderer
                    title={feedback.title}
                    fields={feedback.fields}
                    initialValues={feedback.values}
                    submitLabel={feedback.submitLabel}
                    cancelLabel={feedback.cancelLabel}
                    timeout={feedback.timeout}
                    timeoutAction={feedback.timeoutAction}
                    severity={feedback.severity}
                    hideSubmit={feedback.hideSubmit}
                    hideCancel={feedback.hideCancel}
                    onSubmit={(value) => feedback.complete({ type: "submit", value })}
                    onCancel={() => feedback.complete({ type: "cancel" })}
                    onError={(message) => feedback.complete({ type: "error", message })}
                  />
                </FeedbackContainer>
              );
            }

            // Render TSX-based feedbacks (type === "tsx")
            const FeedbackComponent = feedback.Component;
            if (!FeedbackComponent || typeof FeedbackComponent !== "function") {
              onFeedbackError(feedback.callId, new Error("Invalid feedback component"));
              return null;
            }
            return (
              <FeedbackContainer
                key={feedback.callId}
                onDismiss={() => onFeedbackDismiss(feedback.callId)}
                onError={(error) => onFeedbackError(feedback.callId, error)}
              >
                <FeedbackComponent
                  onSubmit={(value) => feedback.complete({ type: "submit", value })}
                  onCancel={() => feedback.complete({ type: "cancel" })}
                  onError={(message) => feedback.complete({ type: "error", message })}
                />
              </FeedbackContainer>
            );
          })}
        </Flex>
      )}

      {/* Tool approvals are now handled via the feedback system (activeFeedbacks) */}

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
      </Flex>

      {/* Agent Debug Console Modal */}
      {onDebugConsoleChange && (
        <AgentDebugConsole
          open={!!debugConsoleAgent}
          onOpenChange={(open) => !open && onDebugConsoleChange(null)}
          agentHandle={debugConsoleAgent ?? ""}
          debugEvents={debugEvents ?? []}
        />
      )}
    </Theme>
  );
}
