/**
 * @natstack/mobile-webrtc — shared React Native WebRTC shell connection.
 *
 * Resolved to `src/` by `apps/mobile/metro.config.js` (the rule that maps a
 * `@natstack/<name>` import to its package source), so both the native host
 * bootstrap and the workspace app bundle it from source. RN-only
 * (`react-native-webrtc` + AsyncStorage).
 */

// MUST be first: installs the Hermes web-API polyfills the WebRTC codec needs
// before any `@natstack/rpc` module loads (TextDecoder/ReadableStream).
import "./polyfills.js";

export { createReactNativeWebRtcProvider } from "./reactNativeWebRtcPeer.js";
export {
  SHELL_CREDENTIAL_KEY,
  randomRequestId,
  makeShellTokenProvider,
  persistShellCredential,
  loadShellCredential,
  clearShellCredential,
  deviceIdFromCallerId,
  establishWebRtcConnection,
  reconnectViaWebRtc,
} from "./connect.js";
export type {
  ShellPairing,
  ShellCredential,
  StoredShellCredential,
  ShellTokenProvider,
  WebRtcConnection,
  WebRtcConnectionHandlers,
} from "./connect.js";
