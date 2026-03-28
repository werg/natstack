/**
 * Auth state atoms -- Jotai atoms for authentication state.
 *
 * Tracks whether the user has stored credentials and is authenticated.
 * Credentials are persisted in the device keychain (see services/auth.ts).
 */

import { atom } from "jotai";

/** Stored server URL (populated from keychain on app launch) */
export const serverUrlAtom = atom<string>("");

/** Whether valid credentials are loaded (not whether WS is connected) */
export const isAuthenticatedAtom = atom<boolean>(false);

/** Loading state for credential operations */
export const authLoadingAtom = atom<boolean>(false);

/** Auth error message (e.g., invalid token, connection refused) */
export const authErrorAtom = atom<string | null>(null);
