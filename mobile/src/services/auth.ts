/**
 * Auth service -- Shell token entry and secure storage.
 *
 * Stores the server URL and shell token in the device keychain via
 * react-native-keychain. The shell token is the one printed by the
 * NatStack server at standalone startup (NOT the admin token, which
 * gives callerKind: "server" and bypasses shell policies).
 */

import * as Keychain from "react-native-keychain";

const KEYCHAIN_SERVICE = "com.natstack.mobile";

export interface Credentials {
  serverUrl: string;
  token: string;
}

/**
 * Save server credentials to the device keychain.
 *
 * The serverUrl is stored as the "username" field and the shell token
 * as the "password" field, since react-native-keychain uses a
 * username/password pair.
 */
export async function saveCredentials(serverUrl: string, token: string): Promise<void> {
  await Keychain.setGenericPassword(serverUrl, token, {
    service: KEYCHAIN_SERVICE,
  });
}

/**
 * Retrieve stored credentials from the device keychain.
 * Returns null if no credentials are stored.
 */
export async function getCredentials(): Promise<Credentials | null> {
  const result = await Keychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
  if (!result) return null;
  return {
    serverUrl: result.username,
    token: result.password,
  };
}

/**
 * Remove stored credentials from the device keychain.
 */
export async function clearCredentials(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
}
