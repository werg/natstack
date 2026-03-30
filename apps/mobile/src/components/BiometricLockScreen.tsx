/**
 * BiometricLockScreen -- Full-screen overlay for biometric unlock.
 *
 * Displayed on top of everything when the app returns from background
 * after the lock threshold (5 minutes). The user must authenticate
 * with Face ID / Touch ID / fingerprint to proceed.
 *
 * The overlay does NOT disconnect from the server -- the ShellClient
 * stays connected so notifications and sync continue. It only blocks
 * the UI until the user re-authenticates.
 */

import React, { useState, useCallback } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";

interface BiometricLockScreenProps {
  /** Called when the user taps "Unlock" -- should trigger biometric prompt */
  onUnlock: () => Promise<boolean>;
}

export function BiometricLockScreen({ onUnlock }: BiometricLockScreenProps) {
  const colors = useAtomValue(themeColorsAtom);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleUnlockPress = useCallback(async () => {
    setIsAuthenticating(true);
    setErrorMessage(null);

    try {
      const success = await onUnlock();
      if (!success) {
        setErrorMessage("Authentication failed. Please try again.");
      }
      // If success, the parent will unmount this screen
    } catch {
      setErrorMessage("An error occurred. Please try again.");
    } finally {
      setIsAuthenticating(false);
    }
  }, [onUnlock]);

  return (
    <View style={[styles.overlay, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>NatStack</Text>

        <View style={styles.lockIconContainer}>
          {/* Shackle (arc at top) */}
          <View style={[styles.lockShackle, { borderColor: colors.textSecondary }]} />
          {/* Body (rectangle) */}
          <View style={[styles.lockBody, { borderColor: colors.textSecondary }]} />
        </View>

        <Text style={[styles.message, { color: colors.textSecondary }]}>
          Unlock to continue
        </Text>

        {errorMessage && (
          <Text style={[styles.errorText, { color: colors.danger }]}>
            {errorMessage}
          </Text>
        )}

        <Pressable
          style={[
            styles.unlockButton,
            { backgroundColor: colors.primary },
            isAuthenticating && styles.buttonDisabled,
          ]}
          onPress={handleUnlockPress}
          disabled={isAuthenticating}
        >
          {isAuthenticating ? (
            <ActivityIndicator color="#e0e0e0" />
          ) : (
            <Text style={styles.unlockButtonText}>Unlock</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    justifyContent: "center",
    alignItems: "center",
  },
  content: {
    alignItems: "center",
    padding: 32,
    width: "100%",
    maxWidth: 320,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    marginBottom: 32,
  },
  lockIconContainer: {
    alignItems: "center",
    marginBottom: 24,
  },
  lockShackle: {
    width: 28,
    height: 18,
    borderWidth: 3,
    borderBottomWidth: 0,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
  },
  lockBody: {
    width: 40,
    height: 30,
    borderWidth: 3,
    borderRadius: 4,
    marginTop: -1,
  },
  message: {
    fontSize: 16,
    textAlign: "center",
    marginBottom: 32,
  },
  errorText: {
    fontSize: 14,
    textAlign: "center",
    marginBottom: 16,
  },
  unlockButton: {
    width: "100%",
    height: 48,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  unlockButtonText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
});
