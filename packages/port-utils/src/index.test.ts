import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findServicePort, PORT_RANGES, releaseServicePort } from "./index.js";

describe("findServicePort", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-port-lock-test-"));
    process.env["NATSTACK_PORT_LOCK_DIR"] = lockDir;
  });

  afterEach(() => {
    delete process.env["NATSTACK_PORT_LOCK_DIR"];
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("leases ports so concurrent allocators skip already selected ports", async () => {
    const first = await findServicePort("workerd");
    const second = await findServicePort("workerd");

    expect(first).toBeGreaterThanOrEqual(PORT_RANGES.workerd.start);
    expect(first).toBeLessThan(PORT_RANGES.workerd.end);
    expect(second).toBe(first + 1);

    releaseServicePort("workerd", first);
    releaseServicePort("workerd", second);
    await expect(findServicePort("workerd")).resolves.toBe(first);
    releaseServicePort("workerd", first);
  });
});
