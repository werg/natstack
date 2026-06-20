import { describe, expect, it } from "vitest";
import { panelRuntimeLeaseSchema } from "./panelRuntime.js";

describe("panelRuntimeLeaseSchema", () => {
  // The lease schema is .strict(). A lease may carry `keepLoaded` (set when a CDP client pins a panel
  // so the headless host won't unload/evict it mid-automation). The strict schema MUST allow that key
  // — otherwise panelRuntime.acquire / the lease snapshot reject EVERY pinned lease at runtime
  // ("Unrecognized key(s): 'keepLoaded'"), which broke all panel acquisition. This locks the
  // schema↔type consistency that tsc CANNOT catch: `keepLoaded` is optional on the type, so a strict
  // schema missing it still `satisfies z.ZodType<PanelRuntimeLease>`.
  const baseLease = {
    slotId: "panel:tree/x",
    runtimeEntityId: "panel:nav-1",
    clientSessionId: "sess-1",
    hostConnectionId: "host-1",
    connectionId: "conn-1",
    holderLabel: "label",
    platform: "headless" as const,
    supportsCdp: true,
    loadOnLeaseAssignment: true,
    acquiredAt: 0,
  };

  it("accepts a lease carrying the keepLoaded pin flag", () => {
    const parsed = panelRuntimeLeaseSchema.parse({ ...baseLease, keepLoaded: true });
    expect(parsed.keepLoaded).toBe(true);
  });

  it("accepts a lease without keepLoaded (optional)", () => {
    expect(() => panelRuntimeLeaseSchema.parse(baseLease)).not.toThrow();
  });
});
