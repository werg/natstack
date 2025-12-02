import { atom } from "jotai";
import { createChatId } from "../../types/storage";
import { channelIdAtom, channelCreatedAtAtom, channelUpdatedAtAtom } from "./coreAtoms";
import { messagesAtom, messageQueueAtom } from "./messageAtoms";
import { participantsAtom } from "./participantAtoms";
import { channelStatusAtom, activeParticipantIdAtom, abortControllerAtom } from "./generationAtoms";

/**
 * Channel-level action atoms.
 * These handle operations that span multiple atom categories.
 */

/** Clear channel (for new chat) */
export const clearChannelAtom = atom(
  null,
  (get, set) => {
    // Abort any ongoing generation
    const controller = get(abortControllerAtom);
    if (controller) {
      controller.abort();
    }

    set(messagesAtom, []);
    set(messageQueueAtom, []);
    set(channelUpdatedAtAtom, new Date());
    set(abortControllerAtom, null);
    set(activeParticipantIdAtom, null);
    set(channelStatusAtom, "idle");
  }
);

/** Reset channel with new ID. Returns the new channel ID. */
export const resetChannelAtom = atom(
  null,
  (_get, set, id?: string) => {
    const newId = id ?? createChatId();
    set(channelIdAtom, newId);
    set(messagesAtom, []);
    set(participantsAtom, new Map());
    set(channelStatusAtom, "idle");
    set(activeParticipantIdAtom, null);
    set(abortControllerAtom, null);
    set(channelCreatedAtAtom, new Date());
    set(channelUpdatedAtAtom, new Date());
    set(messageQueueAtom, []);
    return newId;
  }
);
