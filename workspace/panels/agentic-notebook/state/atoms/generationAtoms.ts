import { atom } from "jotai";
import type { ChannelStatus } from "../../types/channel";

/**
 * Generation-related atoms.
 * Handles generation status, active participant, and abort control.
 */

/** Channel status */
export const channelStatusAtom = atom<ChannelStatus>("idle");

/** Currently active participant (for generation) */
export const activeParticipantIdAtom = atom<string | null>(null);

/** Abort controller for current generation */
export const abortControllerAtom = atom<AbortController | null>(null);

/** Check if generation is active */
export const isGeneratingAtom = atom((get) => {
  return get(activeParticipantIdAtom) !== null;
});

/** Get abort signal */
export const abortSignalAtom = atom((get) => {
  return get(abortControllerAtom)?.signal;
});

/** Start generation */
export const startGenerationAtom = atom(
  null,
  (_get, set, participantId: string) => {
    const controller = new AbortController();
    set(activeParticipantIdAtom, participantId);
    set(abortControllerAtom, controller);
    set(channelStatusAtom, "agent_thinking");
    return controller;
  }
);

/** Set streaming status */
export const setStreamingAtom = atom(
  null,
  (_get, set) => {
    set(channelStatusAtom, "agent_streaming");
  }
);

/** Abort generation */
export const abortGenerationAtom = atom(
  null,
  (get, set) => {
    const controller = get(abortControllerAtom);
    if (controller) {
      controller.abort();
      set(abortControllerAtom, null);
      set(activeParticipantIdAtom, null);
      set(channelStatusAtom, "idle");
    }
  }
);

/** End generation */
export const endGenerationAtom = atom(
  null,
  (_get, set) => {
    set(abortControllerAtom, null);
    set(activeParticipantIdAtom, null);
    set(channelStatusAtom, "idle");
  }
);
