/**
 * Biometric authentication service -- Face ID / Touch ID / fingerprint unlock.
 *
 * Uses react-native-keychain (already in dependencies) for biometric
 * support detection and authentication. The keychain module provides
 * getSupportedBiometryType() to check availability and setGenericPassword
 * with ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE for auth prompts.
 *
 * This service is used by the useBiometricLock hook to prompt for
 * biometrics when the app returns from background after a timeout.
 */

import * as Keychain from "react-native-keychain";

/** Keychain service name for the biometric auth entry */
const BIOMETRIC_SERVICE = "com.natstack.mobile.biometric";

/**
 * Check whether biometric authentication is available on this device.
 *
 * Returns true if Face ID, Touch ID, fingerprint, or iris scanning
 * is available. Returns false if the device has no biometric hardware
 * or the user has not enrolled any biometrics.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const biometryType = await Keychain.getSupportedBiometryType();
    // Returns null if no biometrics are available/enrolled
    return biometryType !== null;
  } catch {
    return false;
  }
}

/**
 * Get a human-readable name for the available biometric type.
 * Returns null if biometrics are not available.
 */
export async function getBiometricTypeName(): Promise<string | null> {
  try {
    const biometryType = await Keychain.getSupportedBiometryType();
    if (!biometryType) return null;

    switch (biometryType) {
      case Keychain.BIOMETRY_TYPE.FACE_ID:
        return "Face ID";
      case Keychain.BIOMETRY_TYPE.TOUCH_ID:
        return "Touch ID";
      case Keychain.BIOMETRY_TYPE.FINGERPRINT:
        return "Fingerprint";
      case Keychain.BIOMETRY_TYPE.IRIS:
        return "Iris";
      default:
        return "Biometrics";
    }
  } catch {
    return null;
  }
}

/**
 * Set up biometric authentication by storing a marker credential
 * in the keychain with biometric access control.
 *
 * This needs to be called once (e.g., after login) to establish
 * the keychain entry that biometric auth will verify against.
 */
export async function setupBiometricAuth(): Promise<boolean> {
  try {
    // Store a marker value protected by biometric or device passcode.
    // The actual value doesn't matter -- we use the keychain access
    // control to gate the authentication prompt.
    const result = await Keychain.setGenericPassword(
      "natstack-biometric",
      "authenticated",
      {
        service: BIOMETRIC_SERVICE,
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
        accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      },
    );
    return !!result;
  } catch (error) {
    console.error("[BiometricAuth] Failed to set up biometric auth:", error);
    return false;
  }
}

/**
 * Prompt the user for biometric authentication.
 *
 * Attempts to read the biometric-protected keychain entry, which
 * triggers the system biometric prompt (Face ID, Touch ID, etc.).
 *
 * Returns true if authentication succeeded, false otherwise.
 * Does not throw -- callers should check the return value.
 */
export async function authenticateWithBiometrics(): Promise<boolean> {
  try {
    const result = await Keychain.getGenericPassword({
      service: BIOMETRIC_SERVICE,
      authenticationPrompt: {
        title: "Unlock NatStack",
        subtitle: "Verify your identity to continue",
        cancel: "Cancel",
      },
    });

    // If the biometric entry doesn't exist yet, set it up first
    // and consider the user authenticated (first-time setup).
    if (!result) {
      const setupOk = await setupBiometricAuth();
      return setupOk;
    }

    // Successfully read the biometric-protected entry -- user is authenticated
    return true;
  } catch (error) {
    // Biometric prompt was cancelled or failed
    console.warn("[BiometricAuth] Authentication failed:", error);
    return false;
  }
}

/**
 * Remove the biometric keychain entry. Called when the user logs out
 * or disables biometric lock.
 */
export async function clearBiometricAuth(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({
      service: BIOMETRIC_SERVICE,
    });
  } catch {
    // Ignore errors on cleanup
  }
}
