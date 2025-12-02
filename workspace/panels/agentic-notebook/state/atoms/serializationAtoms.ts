import { atom } from "jotai";
import { serializeMessage, deserializeMessage } from "../../types/messages";
import type { StoredChat, SerializableChatMetadata, SerializedParticipant } from "../../types/storage";
import { generateChatTitle, generateChatPreview } from "../../types/storage";
import { channelIdAtom, channelCreatedAtAtom, channelUpdatedAtAtom } from "./coreAtoms";
import { messagesAtom, messageQueueAtom } from "./messageAtoms";
import { participantsAtom } from "./participantAtoms";
import { channelStatusAtom, activeParticipantIdAtom, abortControllerAtom } from "./generationAtoms";

/**
 * Serialization atoms.
 * Handles converting channel state to/from storable format.
 */

/** Convert current state to storable format */
export const toStoredChatAtom = atom((get) => {
  const messages = get(messagesAtom);
  const participants = get(participantsAtom);
  const channelId = get(channelIdAtom);
  const createdAt = get(channelCreatedAtAtom);
  const updatedAt = get(channelUpdatedAtAtom);

  const firstTextMessage = messages.find(
    (m) => m.content.type === "text" && m.participantType === "user"
  );
  const firstText =
    firstTextMessage?.content.type === "text"
      ? firstTextMessage.content.text
      : "New Chat";

  const metadata: SerializableChatMetadata = {
    id: channelId,
    title: generateChatTitle(firstText),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    messageCount: messages.length,
    preview: generateChatPreview(firstText),
    participantIds: Array.from(participants.keys()),
  };

  const serializedMessages = messages.map(serializeMessage);

  const serializedParticipants: SerializedParticipant[] = Array.from(
    participants.values()
  ).map((p) => {
    const base: SerializedParticipant = {
      id: p.id,
      type: p.type,
      displayName: p.displayName,
      capabilities: p.capabilities,
      avatar: p.avatar,
      metadata: p.metadata,
    };

    // Preserve type-specific fields
    if (p.type === "agent") {
      base.modelRole = p.modelRole;
      base.modelId = p.modelId;
      base.systemPrompt = p.systemPrompt;
    } else if (p.type === "kernel") {
      base.sessionId = p.sessionId;
      base.isReady = p.isReady;
      base.executionCount = p.executionCount;
    } else if (p.type === "user") {
      base.submitKeyConfig = p.submitKeyConfig;
    }

    return base;
  });

  return { metadata, messages: serializedMessages, participants: serializedParticipants } as StoredChat;
});

/** Load from stored chat */
export const loadStoredChatAtom = atom(
  null,
  (_get, set, stored: StoredChat) => {
    set(channelIdAtom, stored.metadata.id);
    set(messagesAtom, stored.messages.map(deserializeMessage));
    set(channelCreatedAtAtom, new Date(stored.metadata.createdAt));
    set(channelUpdatedAtAtom, new Date(stored.metadata.updatedAt));

    // Restore participants with full type information
    const participantMap = new Map(
      stored.participants.map((sp) => {
        // Reconstruct full participant with type-specific fields
        let participant: import("../../types/channel").AnyParticipant;

        if (sp.type === "agent") {
          participant = {
            id: sp.id,
            type: "agent",
            displayName: sp.displayName,
            capabilities: sp.capabilities,
            avatar: sp.avatar,
            metadata: sp.metadata,
            modelRole: sp.modelRole ?? "fast",
            modelId: sp.modelId,
            systemPrompt: sp.systemPrompt,
          };
        } else if (sp.type === "kernel") {
          participant = {
            id: sp.id,
            type: "kernel",
            displayName: sp.displayName,
            capabilities: sp.capabilities,
            avatar: sp.avatar,
            metadata: sp.metadata,
            sessionId: sp.sessionId ?? "",
            isReady: sp.isReady ?? false,
            executionCount: sp.executionCount ?? 0,
          };
        } else if (sp.type === "user") {
          participant = {
            id: sp.id,
            type: "user",
            displayName: sp.displayName,
            capabilities: sp.capabilities,
            avatar: sp.avatar,
            metadata: sp.metadata,
            submitKeyConfig: sp.submitKeyConfig ?? { submitKey: "Enter", enterBehavior: "submit" },
          };
        } else {
          // system
          participant = {
            id: sp.id,
            type: "system",
            displayName: sp.displayName,
            capabilities: sp.capabilities,
            avatar: sp.avatar,
            metadata: sp.metadata,
          };
        }

        return [participant.id, participant];
      })
    );

    set(participantsAtom, participantMap);
    set(channelStatusAtom, "idle");
    set(activeParticipantIdAtom, null); // Reset to null on load (user will start new interaction)
    set(abortControllerAtom, null);
    set(messageQueueAtom, []);
  }
);
