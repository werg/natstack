export * from "./types.js";
export * from "./protocol.js";
export { connect, renamingConflictResolver } from "./client.js";
export type { AgenticClient } from "./types.js";

// Re-export commonly needed types from pubsub so consumers don't need a direct dependency
export type { Participant, RosterUpdate, ParticipantMetadata } from "@natstack/pubsub";
