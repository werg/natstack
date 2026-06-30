// Parsing + validation for `natstack://connect` WebRTC pairing deep links.
//
// The deep-link flow is user-triggered onboarding (scan QR, tap link), which
// means any installed Android app can fire one. Without validation, an attacker
// could propose a pairing the user did not intend. The shared parser constrains
// what can be auto-applied:
//
//   - `room` is an unguessable signaling rendezvous id; `fp` is the server's
//     pinned DTLS SHA-256 fingerprint; `code` proves QR possession; `sig` is the
//     signaling endpoint (wss/https, or ws/http only for loopback dev).
//   - The pairing code/room/fingerprint must match a plausible format so obvious
//     junk is rejected before we try to pair with it.
//
// There is no server URL anymore: remote reach is an encrypted WebRTC pipe whose
// peer identity is the pinned fingerprint, not a TLS origin. The UI layer is
// still responsible for asking the user to confirm before overwriting
// credentials — this module only decides whether the link is structurally safe.

import { type ConnectLink, parseConnectLink } from "@natstack/shared/connect";

export type ConnectDeepLinkResult = ConnectLink;

export function parseConnectDeepLink(rawUrl: string): ConnectDeepLinkResult {
  return parseConnectLink(rawUrl);
}
