import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintCallerAssertion,
  verifyCallerAssertion,
} from "./callerAssertion.js";

describe("caller assertions", () => {
  const secret = Buffer.from("a".repeat(64), "hex");
  const otherSecret = Buffer.from("b".repeat(64), "hex");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a valid session-lifetime assertion", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const token = mintCallerAssertion(secret, {
      callerId: "worker:hello",
      callerKind: "worker",
      audience: "egress-proxy",
    });

    expect(verifyCallerAssertion(secret, token, "egress-proxy")).toEqual({
      callerId: "worker:hello",
      callerKind: "worker",
      audience: "egress-proxy",
      issuedAt: 1_700_000_000_000,
    });
  });

  it("includes and enforces expiration when ttlMs is provided", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const token = mintCallerAssertion(secret, {
      callerId: "panel:one",
      callerKind: "panel",
      audience: "egress-proxy",
      ttlMs: 500,
    });

    expect(verifyCallerAssertion(secret, token, "egress-proxy", 1_500)).toMatchObject({
      callerId: "panel:one",
      expiresAt: 1_500,
    });
    expect(verifyCallerAssertion(secret, token, "egress-proxy", 1_501)).toEqual({
      error: "expired",
    });
  });

  it("rejects a bad signature", () => {
    const token = mintCallerAssertion(secret, {
      callerId: "panel:one",
      callerKind: "panel",
      audience: "egress-proxy",
    });

    expect(verifyCallerAssertion(otherSecret, token, "egress-proxy")).toEqual({
      error: "bad-signature",
    });
  });

  it("rejects the wrong audience", () => {
    const token = mintCallerAssertion(secret, {
      callerId: "panel:one",
      callerKind: "panel",
      audience: "egress-proxy",
    });

    expect(verifyCallerAssertion(secret, token, "gateway")).toEqual({
      error: "wrong-audience",
    });
  });

  it("rejects malformed tokens", () => {
    expect(verifyCallerAssertion(secret, "not-a-token", "egress-proxy")).toEqual({
      error: "malformed",
    });
    expect(verifyCallerAssertion(secret, "%%%%.%%%%", "egress-proxy")).toEqual({
      error: "malformed",
    });
  });

  it("rejects assertions minted before secret rotation", () => {
    const token = mintCallerAssertion(secret, {
      callerId: "server",
      callerKind: "server",
      audience: "egress-proxy",
    });

    expect(verifyCallerAssertion(otherSecret, token, "egress-proxy")).toEqual({
      error: "bad-signature",
    });
  });
});
