import { parseConnectDeepLink } from "./deepLinkConnect";

const FP = "AA".repeat(32);
const CODE = "a".repeat(24);
function makeLink(sig = "wss://signal.example/"): string {
  return `natstack://connect?room=room-1111-2222&fp=${FP}&code=${CODE}&sig=${encodeURIComponent(sig)}`;
}

describe("deepLinkConnect", () => {
  it("parses a WebRTC pairing link into room/fp/code/sig", () => {
    expect(parseConnectDeepLink(makeLink())).toEqual({
      kind: "ok",
      room: "room-1111-2222",
      fp: FP,
      code: CODE,
      sig: "wss://signal.example/",
      v: 1,
      ice: "all",
      srv: undefined,
    });
  });

  it("rejects a link missing required pairing params", () => {
    expect(parseConnectDeepLink("natstack://connect?room=room-1111-2222").kind).toBe("error");
  });

  it("rejects a fingerprint that is not a SHA-256", () => {
    const link = `natstack://connect?room=room-1111-2222&fp=DE:AD:BE:EF&code=${CODE}&sig=${encodeURIComponent("wss://signal.example/")}`;
    expect(parseConnectDeepLink(link).kind).toBe("error");
  });

  it("rejects a cleartext signaling endpoint on a public host", () => {
    expect(parseConnectDeepLink(makeLink("ws://signal.example/")).kind).toBe("error");
  });

  it("allows a loopback cleartext signaling endpoint for dev", () => {
    expect(parseConnectDeepLink(makeLink("ws://127.0.0.1:8787/")).kind).toBe("ok");
  });
});
