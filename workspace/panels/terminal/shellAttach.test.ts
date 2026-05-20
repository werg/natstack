import { describe, expect, it, vi } from "vitest";
import { attachWithScrollback } from "./shellAttach.js";
import type { ShellApi } from "./types.js";

const encoder = new TextEncoder();

describe("attachWithScrollback", () => {
  it("prepends scrollback and eagerly drains live output", async () => {
    let liveController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const shell = {
      getScrollback: vi.fn(async () => ({ text: "scrollback", cursor: "cursor-1" })),
      attach: vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              liveController = controller;
            },
          })
        )
      ),
    } as unknown as ShellApi;

    const response = await attachWithScrollback(shell, "session-1");
    expect(shell.attach).toHaveBeenCalledWith("session-1", { after: "cursor-1" });
    liveController?.enqueue(encoder.encode("live"));
    liveController?.close();

    const text = await response.text();
    expect(text).toBe("scrollbacklive");
  });
});
