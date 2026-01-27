/**
 * Session Recovery Entry Point
 *
 * Node.js-only utilities for crash recovery by syncing SDK state to pubsub.
 * Import from "@natstack/agentic-messaging/recovery"
 *
 * Note: This module uses Node.js built-ins (os, fs) and should NOT be
 * imported in browser contexts.
 */

export {
  computeTranscriptPath,
  readSdkTranscript,
  findCommonAncestor,
  computeSyncDeltas,
  findMissingMessages,
  extractMessageText,
  prepareRecoveredMessages,
  formatContextForSdk,
  generateRecoveryReviewUI,
  recoverSession,
  FILTERED_CONTENT_TYPES,
  type SdkTranscriptMessage,
  type PubsubMessageWithMetadata,
  type RecoveredMessage,
  type SyncDeltas,
  type SessionRecoveryOptions,
  type SessionRecoveryResult,
} from "./session-recovery.js";
