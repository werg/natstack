/**
 * Connection state atoms -- Jotai atoms for WebSocket connection status.
 *
 * Tracks the connection lifecycle: disconnected -> connecting -> connected.
 * The ShellClient updates these atoms via onStatusChange callback.
 */

import { atom } from "jotai";
import type { ConnectionStatus } from "../services/mobileTransport";

/** Current connection status */
export const connectionStatusAtom = atom<ConnectionStatus>("disconnected");

/** Derived: true when connected */
export const isConnectedAtom = atom((get) => get(connectionStatusAtom) === "connected");

/** Derived: true when connecting or reconnecting */
export const isConnectingAtom = atom((get) => get(connectionStatusAtom) === "connecting");

/** Whether the device has network connectivity (updated by useAppLifecycle via NetInfo) */
export const networkReachableAtom = atom<boolean>(true);

/** Optional error message from the last connection failure */
export const connectionErrorAtom = atom<string | null>(null);

/**
 * Whether the biometric lock screen is currently active.
 * Written by useBiometricLock, read by useAppLifecycle to defer
 * transport reconnection until the lock is dismissed.
 */
export const biometricLockedAtom = atom<boolean>(false);
