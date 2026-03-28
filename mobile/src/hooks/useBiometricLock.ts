/**
 * useBiometricLock -- Hook that manages the biometric lock state.
 *
 * Tracks when the app goes to background. When returning to foreground
 * after more than LOCK_THRESHOLD_MS (5 minutes), sets locked = true
 * and requires biometric authentication to unlock.
 *
 * Skips the biometric check entirely if:
 * - The device has no biometrics enrolled
 * - The user hasn't authenticated yet (still on login screen)
 *
 * Usage:
 *   const { isLocked, unlock } = useBiometricLock(isAuthenticated);
 *   if (isLocked) return <BiometricLockScreen onUnlock={unlock} />;
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useSetAtom } from "jotai";
import {
  isBiometricAvailable,
  authenticateWithBiometrics,
  setupBiometricAuth,
} from "../services/biometricAuth";
import { biometricLockedAtom } from "../state/connectionAtoms";

/** Time in background before requiring biometric unlock (5 minutes) */
const LOCK_THRESHOLD_MS = 5 * 60 * 1000;

export interface BiometricLockState {
  /** Whether the app is currently locked and needs biometric auth */
  isLocked: boolean;
  /** Whether biometrics are available on this device */
  biometricsAvailable: boolean;
  /** Trigger the biometric prompt. Resolves to true if auth succeeded. */
  unlock: () => Promise<boolean>;
}

/**
 * Hook that manages biometric lock-after-timeout behavior.
 *
 * @param isAuthenticated - Whether the user is logged in. Lock behavior
 *   is skipped when false (no point locking a login screen).
 */
export function useBiometricLock(isAuthenticated: boolean): BiometricLockState {
  const [isLocked, setIsLocked] = useState(false);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const setBiometricLocked = useSetAtom(biometricLockedAtom);

  /** Timestamp when the app last went to background */
  const backgroundTimestampRef = useRef<number | null>(null);

  /** Track the previous app state to detect transitions */
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Check biometric availability on mount and when auth state changes
  useEffect(() => {
    if (!isAuthenticated) {
      setBiometricsAvailable(false);
      setIsLocked(false);
      return;
    }

    let cancelled = false;

    void (async () => {
      const available = await isBiometricAvailable();
      if (!cancelled) {
        setBiometricsAvailable(available);
        if (available) {
          // Ensure the biometric keychain entry exists
          await setupBiometricAuth();
        }
      }
    })();

    return () => { cancelled = true; };
  }, [isAuthenticated]);

  // Listen for app state changes
  useEffect(() => {
    if (!isAuthenticated || !biometricsAvailable) return;

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextAppState;

      // App going to background
      if (
        previousState === "active" &&
        (nextAppState === "background" || nextAppState === "inactive")
      ) {
        backgroundTimestampRef.current = Date.now();
        return;
      }

      // App returning to foreground
      if (
        (previousState === "background" || previousState === "inactive") &&
        nextAppState === "active"
      ) {
        const backgroundTime = backgroundTimestampRef.current;
        backgroundTimestampRef.current = null;

        if (backgroundTime !== null) {
          const elapsed = Date.now() - backgroundTime;
          if (elapsed >= LOCK_THRESHOLD_MS) {
            setIsLocked(true);
            setBiometricLocked(true);
          }
        }
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
  }, [isAuthenticated, biometricsAvailable, setBiometricLocked]);

  const unlock = useCallback(async (): Promise<boolean> => {
    const success = await authenticateWithBiometrics();
    if (success) {
      setIsLocked(false);
      setBiometricLocked(false);
    }
    return success;
  }, [setBiometricLocked]);

  return { isLocked, biometricsAvailable, unlock };
}
