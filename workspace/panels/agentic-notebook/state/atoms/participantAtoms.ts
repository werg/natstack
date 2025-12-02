import { atom } from "jotai";
import type { AnyParticipant } from "../../types/channel";

/**
 * Participant-related atoms.
 * Handles the participant list and participant mutations.
 */

/** All participants */
export const participantsAtom = atom<Map<string, AnyParticipant>>(new Map());

/** Get participants as array */
export const participantsArrayAtom = atom((get) => {
  return Array.from(get(participantsAtom).values());
});

/** Add a participant */
export const addParticipantAtom = atom(
  null,
  (get, set, participant: AnyParticipant) => {
    const participants = new Map(get(participantsAtom));
    participants.set(participant.id, participant);
    set(participantsAtom, participants);
  }
);

/** Remove a participant */
export const removeParticipantAtom = atom(
  null,
  (get, set, participantId: string) => {
    const participants = new Map(get(participantsAtom));
    participants.delete(participantId);
    set(participantsAtom, participants);
  }
);

/** Update a participant */
export const updateParticipantAtom = atom(
  null,
  (get, set, { participantId, update }: { participantId: string; update: Partial<AnyParticipant> }) => {
    const participants = new Map(get(participantsAtom));
    const participant = participants.get(participantId);
    if (participant) {
      participants.set(participantId, { ...participant, ...update } as AnyParticipant);
      set(participantsAtom, participants);
    }
  }
);
