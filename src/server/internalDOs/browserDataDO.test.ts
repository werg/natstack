import { describe, expect, it } from "vitest";
import type { AuthenticatedCaller } from "@natstack/rpc";
import { isBrowserDataDirectCaller } from "./browserDataDO.js";

/**
 * Layer-A receiver policy for BrowserDataDO (holds user
 * credentials/passwords/cookies/history). Direct callers are shell + shell-side
 * server services, PLUS the `@workspace-extensions/browser-data` extension — the
 * designated mediator panels/agents go through. Every other caller kind, and
 * every OTHER extension, must be refused so the open relay cannot read secrets by
 * addressing the DO directly. (The DO itself needs an FTS5 schema sql.js can't
 * build, so we test the extracted policy predicate directly.)
 */
const caller = (callerKind: string, callerId = "x"): AuthenticatedCaller =>
  ({ callerId, callerKind }) as AuthenticatedCaller;

describe("BrowserDataDO direct-caller policy", () => {
  it("allows shell and server", () => {
    expect(isBrowserDataDirectCaller(caller("shell", "shell"))).toBe(true);
    expect(isBrowserDataDirectCaller(caller("server", "main"))).toBe(true);
  });

  it("allows ONLY the @workspace-extensions/browser-data extension", () => {
    expect(
      isBrowserDataDirectCaller(caller("extension", "@workspace-extensions/browser-data"))
    ).toBe(true);
    // Any other extension is refused — it would otherwise leak user credentials.
    expect(isBrowserDataDirectCaller(caller("extension", "@workspace-extensions/evil"))).toBe(
      false
    );
    expect(isBrowserDataDirectCaller(caller("extension", "@workspace-extensions/news"))).toBe(
      false
    );
  });

  it("refuses panel, agent (do), worker, and null callers", () => {
    expect(isBrowserDataDirectCaller(caller("panel", "panel:1"))).toBe(false);
    expect(isBrowserDataDirectCaller(caller("do", "do:agent"))).toBe(false);
    expect(isBrowserDataDirectCaller(caller("worker", "worker:1"))).toBe(false);
    expect(isBrowserDataDirectCaller(null)).toBe(false);
  });
});
