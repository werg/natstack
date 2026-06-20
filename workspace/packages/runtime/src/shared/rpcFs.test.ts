import { Buffer } from "buffer";
import { describe, expect, it, vi } from "vitest";
import { createRpcFs } from "./rpcFs.js";

function decode(env: unknown): Buffer {
  return Buffer.from((env as { data: string }).data, "base64");
}

function mockRpc() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rpc = {
    call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === "fs.open") return { handleId: 7 };
      if (method === "fs.handleWrite") return { bytesWritten: decode(args[1]).length };
      throw new Error(`unexpected rpc ${method}`);
    }),
  };
  return { rpc, calls };
}

describe("createRpcFs FileHandle.write (Node-parity)", () => {
  it("encodes a string arg as utf-8 and treats the 2nd arg as the file position", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const fh = await fs.open("/f.txt", "w");

    const res = await fh.write("héllo", 12); // write(string, position)

    const w = calls.find((c) => c.method === "fs.handleWrite")!;
    expect(decode(w.args[1]).toString("utf-8")).toBe("héllo"); // encoded, not `buffer.subarray`-crashed
    expect(w.args[2]).toBe(12); // 2nd arg is POSITION for the string overload
    expect(res.bytesWritten).toBe(Buffer.from("héllo", "utf-8").length);
  });

  it("still writes a Uint8Array slice with offset/length/position", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const fh = await fs.open("/f.bin", "w");

    await fh.write(new Uint8Array([1, 2, 3, 4, 5]), 1, 3, 99); // write(buffer, offset, length, position)

    const w = calls.find((c) => c.method === "fs.handleWrite")!;
    expect([...decode(w.args[1])]).toEqual([2, 3, 4]);
    expect(w.args[2]).toBe(99);
  });
});
