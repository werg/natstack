import { describe, it, expect, vi } from "vitest";
import { createReadTool } from "../read.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createReadTool", () => {
  it("reads a small text file", async () => {
    const fs = new StubFs({ files: { [`${CWD}/hello.txt`]: "hello\nworld" } });
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "hello.txt" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "hello\nworld" });
    expect(result.details.path).toBe("hello.txt");
  });

  it("respects offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const fs = new StubFs({ files: { [`${CWD}/big.txt`]: lines } });
    const tool = createReadTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "big.txt", offset: 3, limit: 2 });
    const text = (result.content[0] as { text: string }).text;
    // Selected slice "line 3\nline 4" plus a continuation hint.
    expect(text).toContain("line 3");
    expect(text).toContain("line 4");
    expect(text).not.toContain("line 5\n");
  });

  it("delegates text reads to the file extension when context rpc is available", async () => {
    const fs = new StubFs();
    const rpc = {
      call: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "line 3\nline 4" }],
        details: { path: "big.txt", engine: "node-file" },
      }),
      streamCall: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", { path: "big.txt", offset: 3, limit: 2 });

    expect((result.content[0] as { text: string }).text).toBe("line 3\nline 4");
    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/file-tools",
      "read",
      [{ path: "big.txt", cwd: CWD, offset: 3, limit: 2 }],
    ]);
  });

  it("keeps image reads on the image-service path", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fs = new StubFs({ files: { [`${CWD}/pic.png`]: pngBytes } });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        const [extensionName, extensionMethod] = args;
        expect(method).toBe("extensions.invoke");
        expect(extensionName).toBe("@workspace-extensions/image-service");
        if (extensionMethod === "detectMimeType") return Promise.resolve("image/png");
        if (extensionMethod === "resize") {
          return Promise.resolve({
            data: pngBytes,
            mimeType: "image/png",
            width: 8,
            height: 8,
            originalWidth: 8,
            originalHeight: 8,
            wasResized: false,
          });
        }
        return Promise.resolve(null);
      }),
      streamCall: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", { path: "pic.png" });

    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      expect.arrayContaining(["@workspace-extensions/file-tools", "read"]),
    );
  });

  it("throws when file is missing", async () => {
    const fs = new StubFs();
    const tool = createReadTool(CWD, fs);
    await expect(tool.execute("call-1", { path: "missing.txt" })).rejects.toThrow(/not found/i);
  });

  it("returns ImageContent when the image service extension detects an image type", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fs = new StubFs({ files: { [`${CWD}/pic.png`]: pngBytes } });
    const rpc = {
      call: vi.fn().mockImplementation((_target: string, method: string, args: unknown[]) => {
        const [extensionName, extensionMethod] = args;
        expect(method).toBe("extensions.invoke");
        expect(extensionName).toBe("@workspace-extensions/image-service");
        if (extensionMethod === "detectMimeType") return Promise.resolve("image/png");
        if (extensionMethod === "resize") {
          return Promise.resolve({
            data: pngBytes,
            mimeType: "image/png",
            width: 8,
            height: 8,
            originalWidth: 8,
            originalHeight: 8,
            wasResized: false,
          });
        }
        return Promise.resolve(null);
      }),
      streamCall: vi.fn(async () => new Response()),
    };
    const tool = createReadTool(CWD, fs, { rpc });
    const result = await tool.execute("call-1", { path: "pic.png" });
    const last = result.content[result.content.length - 1] as { type: string; mimeType: string };
    expect(last.type).toBe("image");
    expect(last.mimeType).toBe("image/png");
  });

  it("aborts when signal is already aborted", async () => {
    const fs = new StubFs({ files: { [`${CWD}/foo.txt`]: "x" } });
    const tool = createReadTool(CWD, fs);
    const ac = new AbortController();
    ac.abort();
    await expect(tool.execute("call-1", { path: "foo.txt" }, ac.signal)).rejects.toThrow(/abort/i);
  });
});
