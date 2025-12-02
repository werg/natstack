import type { ChannelMessage } from "../types/messages";
import type { ParticipantType } from "../types/channel";

/**
 * Message validation utilities.
 */

/**
 * Validation error for messages.
 */
export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageValidationError";
  }
}

const VALID_PARTICIPANT_TYPES: ParticipantType[] = ["user", "agent", "kernel", "system"];
const VALID_CONTENT_TYPES = ["text", "code", "code_result", "tool_call", "tool_result", "system"] as const;

export function validateMessage(
  message: Omit<ChannelMessage, "id" | "timestamp" | "channelId">
): void {
  if (!message.participantId || message.participantId.trim() === "") {
    throw new MessageValidationError("participantId cannot be empty");
  }
  if (!VALID_PARTICIPANT_TYPES.includes(message.participantType)) {
    throw new MessageValidationError(`Invalid participantType: ${message.participantType}`);
  }
  if (!message.content) {
    throw new MessageValidationError("Message content is required");
  }
  if (!VALID_CONTENT_TYPES.includes(message.content.type as typeof VALID_CONTENT_TYPES[number])) {
    throw new MessageValidationError(`Invalid content type: ${message.content.type}`);
  }

  switch (message.content.type) {
    case "text":
      if (typeof message.content.text !== "string") {
        throw new MessageValidationError("Text content must have a text string");
      }
      break;
    case "code":
      if (typeof message.content.code !== "string") {
        throw new MessageValidationError("Code content must have a code string");
      }
      break;
    case "tool_call":
      if (!message.content.toolCallId || !message.content.toolName) {
        throw new MessageValidationError("Tool call must have toolCallId and toolName");
      }
      break;
    case "tool_result":
      if (!message.content.toolCallId || !message.content.toolName) {
        throw new MessageValidationError("Tool result must have toolCallId and toolName");
      }
      break;
  }
}
