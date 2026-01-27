/**
 * Session Recovery Utilities
 *
 * Utilities for recovering from session crashes by synchronizing
 * SDK transcript state with pubsub history.
 *
 * The core algorithm:
 * 1. Walk back through pubsub messages until we find one whose sdkUuid exists in SDK transcript
 * 2. This is the "common ancestor" - the last point where both systems agree
 * 3. Compute deltas:
 *    - pubsubDelta: messages in pubsub after ancestor, not in SDK (feed to SDK as context)
 *    - sdkDelta: messages in SDK after ancestor, not in pubsub (post to pubsub)
 * 4. Filter out subagent-related messages from pubsubDelta (they're internal)
 * 5. Resume SDK session normally after sync
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * SDK transcript message types as stored in .jsonl files.
 * These represent the conversation history in the Claude SDK.
 */
export interface SdkTranscriptMessage {
  type: "user" | "assistant" | "system" | "result" | "stream_event" | "tool_progress" | "auth_status";
  uuid: string;
  sessionId: string;
  timestamp: string;
  parentUuid?: string | null;
  /** For subagent messages, the parent tool use ID */
  parent_tool_use_id?: string | null;
  /** True if this is a synthetic user message (e.g., tool result), not real user input */
  isSynthetic?: boolean;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; thinking?: string; tool_use_id?: string; [key: string]: unknown }>;
  };
  subtype?: string;
  // For user messages
  userType?: string;
  cwd?: string;
  // Additional fields vary by message type
  [key: string]: unknown;
}

/**
 * Computes the path to an SDK transcript file.
 *
 * Claude Code stores transcripts at:
 * ~/.claude/projects/-<cwd-path>/<session-id>.jsonl
 *
 * The cwd-path uses dashes instead of slashes.
 */
export function computeTranscriptPath(sessionId: string, workingDirectory: string): string {
  const home = homedir();
  // Convert working directory to Claude's path format: /home/user/project -> -home-user-project
  const cwdPath = workingDirectory.replace(/\//g, "-");
  return join(home, ".claude", "projects", cwdPath, `${sessionId}.jsonl`);
}

/**
 * Reads and parses an SDK transcript file.
 *
 * @param transcriptPath - Path to the .jsonl transcript file
 * @returns Array of transcript messages, or empty array if file doesn't exist
 */
export async function readSdkTranscript(transcriptPath: string): Promise<SdkTranscriptMessage[]> {
  try {
    const content = await readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const messages: SdkTranscriptMessage[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SdkTranscriptMessage;
        // Only include actual conversation messages (user, assistant, result)
        // Skip internal messages like queue-operation, file-history-snapshot
        if (parsed.type === "user" || parsed.type === "assistant" || parsed.type === "result") {
          messages.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  } catch (err) {
    // File doesn't exist or can't be read
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Content types that should be filtered out from pubsub → SDK context.
 * These are internal/ephemeral message types.
 */
export const FILTERED_CONTENT_TYPES = [
  "application/x-natstack-thinking",    // Thinking/reasoning
  "application/x-natstack-action",      // Tool use indicators
  "application/x-natstack-typing",      // Typing indicators
  "application/x-natstack-inline-ui",   // Inline UI components
] as const;

/**
 * A pubsub message with metadata for correlation with SDK messages.
 */
export interface PubsubMessageWithMetadata {
  id: string;
  pubsubId: number;
  content: string;
  senderId: string;
  senderType?: string;
  timestamp?: number;
  /** Content type (e.g., for thinking, action, typing messages) */
  contentType?: string;
  metadata?: {
    sdkUuid?: string;
    sdkSessionId?: string;
    /** If this message is related to a subagent */
    parentToolUseId?: string;
    isSubagent?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Finds the common ancestor - the most recent pubsub message whose sdkUuid exists in SDK transcript.
 *
 * Walks backward through pubsub messages until we find one that matches.
 *
 * @param sdkMessages - Messages from the SDK transcript
 * @param pubsubMessages - Messages from pubsub with metadata (assumed ordered by pubsubId)
 * @returns Index of common ancestor in pubsubMessages, or -1 if none found
 */
export function findCommonAncestor(
  sdkMessages: SdkTranscriptMessage[],
  pubsubMessages: PubsubMessageWithMetadata[]
): number {
  // Build a set of SDK UUIDs for fast lookup
  const sdkUuids = new Set<string>(sdkMessages.map((m) => m.uuid));

  // Walk backward through pubsub messages
  for (let i = pubsubMessages.length - 1; i >= 0; i--) {
    const pubsubMsg = pubsubMessages[i];
    if (!pubsubMsg) continue;
    const sdkUuid = pubsubMsg.metadata?.sdkUuid;
    if (sdkUuid && sdkUuids.has(sdkUuid)) {
      return i;
    }
  }

  return -1; // No common ancestor found
}

/**
 * Result of computing sync deltas between pubsub and SDK.
 */
export interface SyncDeltas {
  /** Index of common ancestor in pubsub messages (-1 if none) */
  commonAncestorIndex: number;
  /** SDK UUID of common ancestor (if found) */
  commonAncestorUuid?: string;
  /** Messages in pubsub after ancestor that SDK doesn't know about (for SDK context catch-up) */
  pubsubDelta: PubsubMessageWithMetadata[];
  /** Messages in SDK after ancestor that pubsub doesn't have (for pubsub catch-up) */
  sdkDelta: SdkTranscriptMessage[];
}

/**
 * Computes the deltas between pubsub and SDK state.
 *
 * @param sdkMessages - Messages from the SDK transcript
 * @param pubsubMessages - Messages from pubsub with metadata
 * @returns Deltas for bidirectional sync
 */
export function computeSyncDeltas(
  sdkMessages: SdkTranscriptMessage[],
  pubsubMessages: PubsubMessageWithMetadata[]
): SyncDeltas {
  const ancestorIndex = findCommonAncestor(sdkMessages, pubsubMessages);

  if (ancestorIndex === -1) {
    // No common ancestor - everything is a delta
    return {
      commonAncestorIndex: -1,
      pubsubDelta: pubsubMessages.filter((m) => !shouldExcludeFromSdkContext(m)),
      sdkDelta: sdkMessages.filter((m) => !shouldExcludeFromPubsubSync(m)),
    };
  }

  const ancestorPubsubMsg = pubsubMessages[ancestorIndex]!;
  const ancestorSdkUuid = ancestorPubsubMsg.metadata?.sdkUuid;

  // Find ancestor index in SDK messages
  const ancestorSdkIndex = sdkMessages.findIndex((m) => m.uuid === ancestorSdkUuid);

  // Pubsub messages after ancestor that SDK doesn't know about
  // Filter out subagent messages - they're internal and shouldn't be fed to SDK
  const pubsubAfterAncestor = pubsubMessages.slice(ancestorIndex + 1);
  const sdkUuidsAfterAncestor = new Set(
    sdkMessages.slice(ancestorSdkIndex + 1).map((m) => m.uuid)
  );
  const pubsubDelta = pubsubAfterAncestor.filter((m) => {
    // Skip if SDK already knows about this message
    if (m.metadata?.sdkUuid && sdkUuidsAfterAncestor.has(m.metadata.sdkUuid)) {
      return false;
    }
    // Skip subagent messages, internal content types, etc.
    if (shouldExcludeFromSdkContext(m)) {
      return false;
    }
    return true;
  });

  // SDK messages after ancestor that pubsub doesn't have
  // Filter out subagent messages, synthetic messages (tool results), etc.
  const sdkAfterAncestor = ancestorSdkIndex >= 0 ? sdkMessages.slice(ancestorSdkIndex + 1) : sdkMessages;
  const pubsubSdkUuids = new Set(
    pubsubAfterAncestor.map((m) => m.metadata?.sdkUuid).filter(Boolean)
  );
  const sdkDelta = sdkAfterAncestor.filter((m) => {
    // Skip if pubsub already has this message
    if (pubsubSdkUuids.has(m.uuid)) {
      return false;
    }
    // Skip subagent messages, synthetic messages, etc.
    if (shouldExcludeFromPubsubSync(m)) {
      return false;
    }
    return true;
  });

  return {
    commonAncestorIndex: ancestorIndex,
    commonAncestorUuid: ancestorSdkUuid,
    pubsubDelta,
    sdkDelta,
  };
}

/**
 * Checks if a pubsub message is subagent-related.
 */
function isSubagentMessage(msg: PubsubMessageWithMetadata): boolean {
  return !!(msg.metadata?.isSubagent || msg.metadata?.parentToolUseId);
}

/**
 * Checks if a pubsub message has a filtered content type (internal/ephemeral).
 */
function isFilteredContentType(msg: PubsubMessageWithMetadata): boolean {
  if (!msg.contentType) return false;
  return FILTERED_CONTENT_TYPES.some((ct) => msg.contentType === ct);
}

/**
 * Checks if a pubsub message should be excluded from SDK context.
 */
function shouldExcludeFromSdkContext(msg: PubsubMessageWithMetadata): boolean {
  // Exclude subagent messages
  if (isSubagentMessage(msg)) return true;
  // Exclude internal content types (thinking, action, typing, inline-ui)
  if (isFilteredContentType(msg)) return true;
  return false;
}

/**
 * Checks if an SDK message is synthetic (e.g., tool result, not real user input).
 */
function isSyntheticSdkMessage(msg: SdkTranscriptMessage): boolean {
  // Explicit synthetic flag
  if (msg.isSynthetic) return true;

  // Check if user message content is only tool_result blocks
  if (msg.type === "user" && msg.message?.content) {
    const hasOnlyToolResults = msg.message.content.every(
      (block) => block.type === "tool_result"
    );
    if (hasOnlyToolResults && msg.message.content.length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if an SDK message should be excluded from pubsub sync.
 */
function shouldExcludeFromPubsubSync(msg: SdkTranscriptMessage): boolean {
  // Exclude subagent messages
  if (isSdkSubagentMessage(msg)) return true;
  // Exclude synthetic messages (tool results, etc.)
  if (isSyntheticSdkMessage(msg)) return true;
  return false;
}

/**
 * Checks if an SDK transcript message is subagent-related.
 */
function isSdkSubagentMessage(msg: SdkTranscriptMessage): boolean {
  return !!msg.parent_tool_use_id;
}

/**
 * Identifies messages in the SDK transcript that are not in pubsub history.
 *
 * Uses the sdkUuid stored in pubsub message metadata to correlate messages.
 *
 * @param sdkMessages - Messages from the SDK transcript
 * @param pubsubMessages - Messages from pubsub with metadata
 * @returns SDK messages that are missing from pubsub
 * @deprecated Use computeSyncDeltas for bidirectional sync
 */
export function findMissingMessages(
  sdkMessages: SdkTranscriptMessage[],
  pubsubMessages: PubsubMessageWithMetadata[]
): SdkTranscriptMessage[] {
  // Build a set of SDK UUIDs that are already in pubsub
  const knownSdkUuids = new Set<string>();
  for (const msg of pubsubMessages) {
    if (msg.metadata?.sdkUuid) {
      knownSdkUuids.add(msg.metadata.sdkUuid);
    }
  }

  // Find SDK messages not in pubsub
  return sdkMessages.filter((msg) => !knownSdkUuids.has(msg.uuid));
}

/**
 * Extracts the text content from an SDK transcript message.
 *
 * @param message - SDK transcript message
 * @returns The text content, or empty string if no text content
 */
export function extractMessageText(message: SdkTranscriptMessage): string {
  if (!message.message?.content) {
    return "";
  }

  const textParts: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    }
  }

  return textParts.join("");
}

/**
 * Categorizes a recovered message for posting to pubsub.
 */
export interface RecoveredMessage {
  type: "user" | "assistant";
  sdkUuid: string;
  sdkSessionId: string;
  content: string;
  timestamp: string;
}

/**
 * Converts SDK transcript messages to a format suitable for posting to pubsub.
 *
 * @param missingMessages - SDK messages that need to be synced to pubsub
 * @returns Messages formatted for posting to pubsub
 */
export function prepareRecoveredMessages(missingMessages: SdkTranscriptMessage[]): RecoveredMessage[] {
  const recovered: RecoveredMessage[] = [];

  for (const msg of missingMessages) {
    // Only recover user and assistant messages
    if (msg.type !== "user" && msg.type !== "assistant") {
      continue;
    }

    // Skip synthetic messages (tool results, etc.) - they're internal
    if (isSyntheticSdkMessage(msg)) {
      continue;
    }

    const content = extractMessageText(msg);
    if (!content) {
      continue;
    }

    recovered.push({
      type: msg.type,
      sdkUuid: msg.uuid,
      sdkSessionId: msg.sessionId,
      content,
      timestamp: msg.timestamp,
    });
  }

  return recovered;
}

/**
 * Options for session recovery.
 */
export interface SessionRecoveryOptions {
  /** SDK session ID to recover */
  sdkSessionId: string;
  /** Working directory (used to compute transcript path) */
  workingDirectory: string;
  /** Function to send messages to pubsub */
  sendMessage: (content: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Function to get messages from pubsub with metadata */
  getPubsubMessages: () => PubsubMessageWithMetadata[];
  /** Optional logger */
  log?: (message: string) => void;
}

/**
 * Result of session recovery.
 */
export interface SessionRecoveryResult {
  /** Whether recovery was performed */
  recovered: boolean;
  /** Number of messages posted to pubsub (SDK → pubsub sync) */
  messagesPostedToPubsub: number;
  /** Messages that pubsub has but SDK doesn't know about (for SDK context catch-up) */
  contextForSdk: PubsubMessageWithMetadata[];
  /** Formatted context string to include in next SDK prompt */
  formattedContextForSdk: string;
  /** Error if recovery failed */
  error?: Error;
}

/**
 * Formats pubsub messages as context to feed to the SDK.
 *
 * @param messages - Messages to format
 * @returns Formatted context string
 */
export function formatContextForSdk(messages: PubsubMessageWithMetadata[]): string {
  if (messages.length === 0) {
    return "";
  }

  const lines: string[] = [
    "<session-recovery-context>",
    "The following messages occurred while the session was interrupted and need to be incorporated:",
    "",
  ];

  for (const msg of messages) {
    const role = msg.senderType === "panel" ? "User" : "Assistant";
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : "unknown";
    lines.push(`[${role} at ${timestamp}]`);
    lines.push(msg.content);
    lines.push("");
  }

  lines.push("</session-recovery-context>");
  return lines.join("\n");
}

/**
 * Generates the MDX code for the session recovery review UI.
 *
 * This UI allows users to review and edit the context that will be fed
 * to the SDK after a session recovery.
 *
 * @param messages - Messages that need to be synced
 * @param defaultContext - The default formatted context
 * @returns MDX code string for feedback_custom
 */
export function generateRecoveryReviewUI(
  messages: PubsubMessageWithMetadata[],
  defaultContext: string
): string {
  // Escape the default context for embedding in JSX
  const escapedContext = JSON.stringify(defaultContext);

  // Build message summaries for display
  const messageSummaries = messages.map((msg) => {
    const role = msg.senderType === "panel" ? "User" : "Assistant";
    const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : "unknown";
    const preview = msg.content.length > 100 ? msg.content.slice(0, 100) + "..." : msg.content;
    return { role, timestamp, preview };
  });

  const summariesJson = JSON.stringify(messageSummaries);

  return `
import { useState } from 'react';

export default function SessionRecoveryReview({ onSubmit, onCancel }) {
  const messages = ${summariesJson};
  const [context, setContext] = useState(${escapedContext});
  const [showEditor, setShowEditor] = useState(false);

  return (
    <div className="space-y-4">
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
        <h3 className="font-semibold text-yellow-800 dark:text-yellow-200 mb-2">
          Session Recovery Required
        </h3>
        <p className="text-sm text-yellow-700 dark:text-yellow-300">
          The previous session was interrupted. {messages.length} message(s) need to be synced.
          This context will be provided to Claude to catch up on what happened.
        </p>
      </div>

      <div className="space-y-2">
        <h4 className="font-medium text-sm">Messages to sync:</h4>
        {messages.map((msg, i) => (
          <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded p-2 text-sm">
            <span className="font-medium">{msg.role}</span>
            <span className="text-gray-500 ml-2 text-xs">{msg.timestamp}</span>
            <p className="text-gray-600 dark:text-gray-400 mt-1">{msg.preview}</p>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <button
          onClick={() => setShowEditor(!showEditor)}
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          {showEditor ? 'Hide' : 'Show'} full context to edit
        </button>

        {showEditor && (
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="w-full h-48 p-2 border rounded font-mono text-sm bg-white dark:bg-gray-900"
          />
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSubmit({ context })}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Apply Recovery Context
        </button>
        <button
          onClick={() => onSubmit({ context: '' })}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600"
        >
          Skip (No Context)
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
`;
}

/**
 * Performs bidirectional session recovery by syncing SDK and pubsub state.
 *
 * This function:
 * 1. Reads the SDK transcript file
 * 2. Finds the common ancestor between pubsub and SDK
 * 3. Computes deltas in both directions
 * 4. Posts SDK-only messages to pubsub
 * 5. Returns pubsub-only messages as context for the SDK
 *
 * After calling this, the caller should:
 * - Include `formattedContextForSdk` in the next prompt to the SDK
 * - Resume the SDK session normally (no UUID manipulation needed)
 *
 * @param options - Recovery options
 * @returns Recovery result with context for SDK
 */
export async function recoverSession(options: SessionRecoveryOptions): Promise<SessionRecoveryResult> {
  const { sdkSessionId, workingDirectory, sendMessage, getPubsubMessages, log } = options;

  try {
    // 1. Compute transcript path and read SDK history
    const transcriptPath = computeTranscriptPath(sdkSessionId, workingDirectory);
    log?.(`Reading SDK transcript from: ${transcriptPath}`);

    const sdkMessages = await readSdkTranscript(transcriptPath);
    if (sdkMessages.length === 0) {
      log?.("No SDK messages found in transcript");
      return {
        recovered: false,
        messagesPostedToPubsub: 0,
        contextForSdk: [],
        formattedContextForSdk: "",
      };
    }
    log?.(`Found ${sdkMessages.length} messages in SDK transcript`);

    // 2. Get pubsub messages with metadata
    const pubsubMessages = getPubsubMessages();
    log?.(`Found ${pubsubMessages.length} messages in pubsub history`);

    // 3. Compute sync deltas (bidirectional)
    const deltas = computeSyncDeltas(sdkMessages, pubsubMessages);

    if (deltas.commonAncestorIndex >= 0) {
      log?.(`Found common ancestor at pubsub index ${deltas.commonAncestorIndex} (SDK UUID: ${deltas.commonAncestorUuid})`);
    } else {
      log?.("No common ancestor found - full sync required");
    }

    log?.(`Pubsub delta (for SDK context): ${deltas.pubsubDelta.length} messages`);
    log?.(`SDK delta (for pubsub): ${deltas.sdkDelta.length} messages`);

    // 4. Post SDK-only messages to pubsub
    const recovered = prepareRecoveredMessages(deltas.sdkDelta);
    for (const msg of recovered) {
      const metadata = {
        sdkUuid: msg.sdkUuid,
        sdkSessionId: msg.sdkSessionId,
        recovered: true,
        recoveredAt: new Date().toISOString(),
        originalTimestamp: msg.timestamp,
        originalType: msg.type,
      };

      await sendMessage(msg.content, metadata);
      log?.(`Posted to pubsub: ${msg.type} message ${msg.sdkUuid}`);
    }

    // 5. Format pubsub-only messages as context for SDK
    const formattedContext = formatContextForSdk(deltas.pubsubDelta);
    if (deltas.pubsubDelta.length > 0) {
      log?.(`Prepared ${deltas.pubsubDelta.length} messages as context for SDK`);
    }

    const wasRecovered = recovered.length > 0 || deltas.pubsubDelta.length > 0;

    return {
      recovered: wasRecovered,
      messagesPostedToPubsub: recovered.length,
      contextForSdk: deltas.pubsubDelta,
      formattedContextForSdk: formattedContext,
    };
  } catch (err) {
    log?.(`Session recovery failed: ${err}`);
    return {
      recovered: false,
      messagesPostedToPubsub: 0,
      contextForSdk: [],
      formattedContextForSdk: "",
      error: err as Error,
    };
  }
}
