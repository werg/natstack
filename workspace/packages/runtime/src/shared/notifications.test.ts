import { describe, expect, it, vi } from "vitest";
import type { RpcCaller } from "@natstack/rpc";
import { createNotificationClient } from "./notifications.js";

describe("notification client", () => {
  it("routes action button clicks to local callbacks without serializing functions", async () => {
    let actionListener: ((event: { payload: unknown }) => void) | undefined;
    const onClick = vi.fn();
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        if (method === "notification.show") return (args[0] as { id: string }).id;
        return undefined;
      }),
      stream: vi.fn(),
      on: vi.fn((event: string, listener: (event: { payload: unknown }) => void) => {
        if (event === "event:notification:action") actionListener = listener;
        return vi.fn();
      }),
    };
    const client = createNotificationClient(rpc as unknown as RpcCaller);

    const id = await client.show({
      type: "success",
      title: "Image pasted",
      actions: [{ id: "reveal", label: "Reveal", onClick }],
    });

    expect(rpc.call).toHaveBeenCalledWith("main", "events.subscribe", ["notification:action"]);
    expect(rpc.call).toHaveBeenCalledWith("main", "notification.show", [expect.objectContaining({
      id,
      actions: [expect.objectContaining({ id: "reveal", label: "Reveal" })],
    })]);
    const shown = rpc.call.mock.calls.find((call) => call[1] === "notification.show")?.[2][0] as {
      actions?: Array<Record<string, unknown>>;
    };
    expect(shown.actions?.[0]?.["onClick"]).toBeUndefined();

    actionListener?.({ payload: { id, actionId: "reveal" } });

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("generates stable action IDs when callers only provide labels", async () => {
    let actionListener: ((event: { payload: unknown }) => void) | undefined;
    const onClick = vi.fn();
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        if (method === "notification.show") return (args[0] as { id: string }).id;
        return undefined;
      }),
      stream: vi.fn(),
      on: vi.fn((event: string, listener: (event: { payload: unknown }) => void) => {
        if (event === "event:notification:action") actionListener = listener;
        return vi.fn();
      }),
    };
    const client = createNotificationClient(rpc as unknown as RpcCaller);

    const id = await client.show({
      type: "success",
      title: "Image pasted",
      actions: [{ label: "Reveal in folder", onClick }],
    });

    expect(rpc.call).toHaveBeenCalledWith("main", "notification.show", [expect.objectContaining({
      actions: [expect.objectContaining({ id: "reveal-in-folder-0", label: "Reveal in folder" })],
    })]);

    actionListener?.({ payload: { id, actionId: "reveal-in-folder-0" } });

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("defaults to an info notification", async () => {
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        if (method === "notification.show") return "n1";
        return undefined;
      }),
      stream: vi.fn(),
      on: vi.fn(),
    };
    const client = createNotificationClient(rpc as unknown as RpcCaller);

    await client.show({
      title: "Hello",
      message: "Shown from the message field",
    });

    expect(rpc.call).toHaveBeenCalledWith("main", "notification.show", [
      expect.objectContaining({
        type: "info",
        title: "Hello",
        message: "Shown from the message field",
      }),
    ]);
  });
});
