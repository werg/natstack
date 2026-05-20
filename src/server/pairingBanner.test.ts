import { describe, expect, it } from "vitest";
import { formatPairUrlLine } from "./pairingBanner";

describe("server pairing banner", () => {
  it("formats the Pair URL line with the canonical deep link", () => {
    expect(formatPairUrlLine("https://host.tailnet.ts.net", "A".repeat(24))).toBe(
      `  Pair URL:     natstack://connect?url=https%3A%2F%2Fhost.tailnet.ts.net&code=${"A".repeat(24)}`
    );
  });
});
