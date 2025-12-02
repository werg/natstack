import { atom } from "jotai";
import { createChatId } from "../../types/storage";

/**
 * Core channel state atoms.
 * These are the fundamental atoms that identify and timestamp the channel.
 */

/** Channel ID */
export const channelIdAtom = atom<string>(createChatId());

/** Channel creation timestamp */
export const channelCreatedAtAtom = atom<Date>(new Date());

/** Channel last update timestamp */
export const channelUpdatedAtAtom = atom<Date>(new Date());
