import { describe, expect, it } from "vitest";

import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

describe("bootstrap transport policy", () => {
  it("allows only recovery UI RPC methods to main", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "shellApproval.listPending",
      })
    ).not.toThrow();
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "workspace.units.rollback",
      })
    ).not.toThrow();
  });

  it("rejects arbitrary shell RPC methods and non-main targets", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "panel.create",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("panel-1", {
        type: "request",
        method: "shellApproval.listPending",
      })
    ).toThrow(/only call the host/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "event",
        event: "anything",
      })
    ).toThrow(/only send RPC requests/);
  });
});
