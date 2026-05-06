import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { SampleDO } from "./index.js";

describe("SampleDO", () => {
  it("records visits and reports the running count via this.sql", async () => {
    const { call, sql } = await createTestDO(SampleDO);

    expect(await call("visitCount")).toEqual({ count: 0 });
    expect(await call("recordVisit")).toEqual({ count: 1 });
    expect(await call("recordVisit")).toEqual({ count: 2 });
    expect(await call("recordVisit")).toEqual({ count: 3 });
    expect(await call("visitCount")).toEqual({ count: 3 });

    const rows = sql.exec(`SELECT id, ts FROM visits ORDER BY id`).toArray();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(typeof row["ts"]).toBe("string");
      expect(Number.isFinite(Date.parse(row["ts"] as string))).toBe(true);
    }
  });
});
