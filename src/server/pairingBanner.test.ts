import { describe, expect, it } from "vitest";
import { createConnectDeepLink, type ConnectPairing } from "@natstack/shared/connect";
import { formatPairUrlLine } from "./pairingBanner";

describe("server pairing banner", () => {
  it("formats the Pair URL line with the canonical WebRTC deep link", () => {
    const pairing: ConnectPairing = {
      room: "11111111-2222-3333-4444-555555555555",
      fp: "AA".repeat(32),
      code: "A".repeat(24),
      sig: "wss://signal.example/",
      v: 1,
      ice: "all",
    };
    expect(formatPairUrlLine(pairing)).toBe(`  Pair URL:     ${createConnectDeepLink(pairing)}`);
  });
});
