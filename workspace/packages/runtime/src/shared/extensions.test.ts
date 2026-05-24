import { describe, expect, it, vi } from "vitest";
import type { RpcCaller } from "@natstack/rpc";
import { createExtensionsClient } from "./extensions.js";

describe("createExtensionsClient", () => {
  it("routes ordinary extension proxy methods through unary invoke", async () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell");

    await shell.open({ command: "bash", cwd: "/repo" });

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/shell",
      "open",
      [{ command: "bash", cwd: "/repo" }],
    ]);
    expect(rpc.streamCall).not.toHaveBeenCalled();
  });

  it("routes manifest-declared streaming methods through invokeStream", async () => {
    const response = new Response("stream");
    const rpc = createRpc(response, ["attach"]);
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell");

    await expect(shell.attach("session-1", { after: "42" })).resolves.toBe(response);
    await shell.write("session-1", "x");

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.streamingMethods", [
      "@workspace-extensions/shell",
    ]);
    expect(rpc.streamCall).toHaveBeenCalledWith("main", "extensions.invokeStream", [
      "@workspace-extensions/shell",
      "attach",
      ["session-1", { after: "42" }],
    ]);
    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/shell",
      "write",
      ["session-1", "x"],
    ]);
  });

  it("lets the streamingMethods option override manifest resolution", async () => {
    const response = new Response("stream");
    const rpc = createRpc(response);
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell", { streamingMethods: ["attach"] });

    await expect(shell.attach("session-1")).resolves.toBe(response);

    expect(rpc.call).not.toHaveBeenCalledWith(
      "main",
      "extensions.streamingMethods",
      expect.anything()
    );
    expect(rpc.streamCall).toHaveBeenCalledWith("main", "extensions.invokeStream", [
      "@workspace-extensions/shell",
      "attach",
      ["session-1"],
    ]);
  });

  it("keeps Promise assimilation and inspection keys inert on extension proxies", () => {
    const rpc = createRpc();
    const extensions = createExtensionsClient(rpc);
    const shell = extensions.use("@workspace-extensions/shell") as Record<string, unknown>;

    expect(shell["then"]).toBeUndefined();
    expect(shell["toJSON"]).toBeUndefined();
    expect(rpc.call).not.toHaveBeenCalled();
    expect(rpc.streamCall).not.toHaveBeenCalled();
  });
});

function createRpc(
  response: Response = new Response(),
  streamingMethods: string[] = []
): RpcCaller & {
  call: ReturnType<typeof vi.fn>;
  streamCall: ReturnType<typeof vi.fn>;
} {
  return {
    call: vi.fn(async (_target: string, method: string) =>
      method === "extensions.streamingMethods" ? streamingMethods : undefined
    ),
    streamCall: vi.fn(async () => response),
    emit: vi.fn(async () => undefined),
    onEvent: vi.fn(),
    exposeMethod: vi.fn(),
    exposeStreamingMethod: vi.fn(),
  } as unknown as RpcCaller & {
    call: ReturnType<typeof vi.fn>;
    streamCall: ReturnType<typeof vi.fn>;
  };
}
