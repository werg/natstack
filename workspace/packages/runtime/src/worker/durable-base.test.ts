import { describe, expect, it } from "vitest";
import { DurableObjectBase } from "./durable-base.js";
import { createTestDO } from "./durable-test-utils.js";

class EchoDO extends DurableObjectBase {
  protected createTables(): void {}

  echo(...args: unknown[]): unknown[] {
    return args;
  }
}

describe("DurableObjectBase request parsing", () => {
  it("unwraps tokenized dispatch envelopes into positional arguments", async () => {
    const { instance } = await createTestDO(EchoDO);
    const fetchable = instance as unknown as { fetch(request: Request): Promise<Response> };
    const response = await fetchable.fetch(
      new Request("http://test/test-key/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args: [["op-1"], "shell:owner"],
          __instanceToken: "token",
          __instanceId: "do:internal/WorkspaceDO:test-key",
        }),
      })
    );

    await expect(response.json()).resolves.toEqual([["op-1"], "shell:owner"]);
  });

  it("keeps ordinary object payloads as a single argument", async () => {
    const { call } = await createTestDO(EchoDO);

    await expect(call("echo", { args: ["not-an-envelope"] })).resolves.toEqual([
      { args: ["not-an-envelope"] },
    ]);
  });
});
