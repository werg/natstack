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
      if (method === "fs.writeFile" || method === "fs.appendFile") return undefined;
      throw new Error(`unexpected rpc ${method}`);
    }),
  };
  return { rpc, calls };
}

describe("createRpcFs binary file writes", () => {
  it("passes existing binary envelopes through without double encoding", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const envelope = { __bin: true as const, data: Buffer.from([0, 1, 255]).toString("base64") };

    await fs.writeFile("/f.bin", envelope);

    const write = calls.find((c) => c.method === "fs.writeFile")!;
    expect(write.args[0]).toBe("/f.bin");
    expect(write.args[1]).toBe(envelope);
  });

  it("encodes ArrayBuffer and DataView payloads for file writes", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    const backing = new Uint8Array([9, 8, 7, 6]).buffer;
    const view = new DataView(backing, 1, 2);

    await fs.writeFile("/array.bin", arrayBuffer);
    await fs.appendFile("/view.bin", view);

    const arrayWrite = calls.find((c) => c.method === "fs.writeFile")!;
    const viewAppend = calls.find((c) => c.method === "fs.appendFile")!;
    expect([...decode(arrayWrite.args[1])]).toEqual([1, 2, 3]);
    expect([...decode(viewAppend.args[1])]).toEqual([8, 7]);
  });
});

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

  it("writes ArrayBuffer views using their own byte window before offset slicing", async () => {
    const { rpc, calls } = mockRpc();
    const fs = createRpcFs(rpc as never);
    const fh = await fs.open("/f.bin", "w");
    const backing = new Uint8Array([9, 8, 7, 6, 5]).buffer;
    const view = new DataView(backing, 1, 3);

    await fh.write(view, 1, 2, 44);

    const w = calls.find((c) => c.method === "fs.handleWrite")!;
    expect([...decode(w.args[1])]).toEqual([7, 6]);
    expect(w.args[2]).toBe(44);
  });
});
