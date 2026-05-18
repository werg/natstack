import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeProcessAdapter } from "./index.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-process-adapter-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createNodeProcessAdapter", () => {
  it("spawns from the ESM package without relying on a global require", async () => {
    const dir = tempDir();
    const childPath = path.join(dir, "child.cjs");
    fs.writeFileSync(
      childPath,
      "process.send?.({ ok: typeof require === 'function' });\n",
      "utf8",
    );

    const proc = createNodeProcessAdapter(childPath, process.env);
    const message = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("child did not send a message")), 5_000);
      proc.on("message", (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`child exited before sending a message: ${code}`));
      });
    });

    expect(message).toEqual({ ok: true });
  });
});
