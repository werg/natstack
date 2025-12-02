/**
 * Channel atoms - split into focused modules.
 *
 * This replaces the monolithic channelAtoms.ts with organized modules:
 * - coreAtoms: Channel ID and timestamps
 * - messageAtoms: Messages and message actions
 * - participantAtoms: Participants and participant actions
 * - generationAtoms: Generation status, abort control
 * - serializationAtoms: Storage conversion
 * - channelAtoms: Cross-cutting channel operations
 */

// Core
export {
  channelIdAtom,
  channelCreatedAtAtom,
  channelUpdatedAtAtom,
} from "./coreAtoms";

// Messages
export {
  messagesAtom,
  messageQueueAtom,
  hasQueuedMessagesAtom,
  sendMessageAtom,
  queueMessageAtom,
  processQueueAtom,
  updateMessageAtom,
  appendToMessageAtom,
  finishStreamingAtom,
  updateToolStatusAtom,
} from "./messageAtoms";

// Participants
export {
  participantsAtom,
  participantsArrayAtom,
  addParticipantAtom,
  removeParticipantAtom,
  updateParticipantAtom,
} from "./participantAtoms";

// Generation
export {
  channelStatusAtom,
  activeParticipantIdAtom,
  abortControllerAtom,
  isGeneratingAtom,
  abortSignalAtom,
  startGenerationAtom,
  setStreamingAtom,
  abortGenerationAtom,
  endGenerationAtom,
} from "./generationAtoms";

// Serialization
export {
  toStoredChatAtom,
  loadStoredChatAtom,
} from "./serializationAtoms";

// Channel operations
export {
  clearChannelAtom,
  resetChannelAtom,
} from "./channelAtoms";
