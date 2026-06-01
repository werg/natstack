// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MethodDefinition, PubSubClient } from "@workspace/pubsub";

const pubsubMock = vi.hoisted(() => ({
  connectViaRpc: vi.fn(),
}));

vi.mock("@workspace/pubsub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/pubsub")>()),
  connectViaRpc: pubsubMock.connectViaRpc,
}));

vi.mock("@workspace/tool-ui", () => ({
  useFeedbackManager: () => ({
    activeFeedbacks: new Map(),
    addFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    dismissFeedback: vi.fn(),
    handleFeedbackError: vi.fn(),
  }),
  useToolApproval: () => ({
    settings: {},
    setGlobalFloor: vi.fn(),
  }),
}));

import { useAgenticChat } from "./useAgenticChat";
import type { ConnectionConfig } from "../types";

function createClient(): PubSubClient & {
  updateChannelConfig: ReturnType<typeof vi.fn>;
} {
  return {
    clientId: "panel:chat",
    channelConfig: {},
    ready: vi.fn(async () => undefined),
    close: vi.fn(),
    events: vi.fn(async function* () {}),
    onRoster: vi.fn(() => () => undefined),
    onReconnect: vi.fn(() => () => undefined),
    onConfigChange: vi.fn(() => () => undefined),
    getMessageTypes: vi.fn(async () => []),
    updateChannelConfig: vi.fn(async () => undefined),
  } as unknown as PubSubClient & { updateChannelConfig: ReturnType<typeof vi.fn> };
}

function Probe({ config }: { config: ConnectionConfig }) {
  useAgenticChat({
    config,
    channelName: "chat-title-test",
    metadata: { name: "Chat Panel", type: "panel", handle: "user" },
    sandbox: {
      rpc: config.rpc,
      loadImport: vi.fn(async () => ""),
    },
  });
  return null;
}

describe("useAgenticChat set_title", () => {
  beforeEach(() => {
    document.title = "";
    pubsubMock.connectViaRpc.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets the calling panel title directly and preserves channel title metadata", async () => {
    const client = createClient();
    let methods: Record<string, MethodDefinition> | undefined;
    pubsubMock.connectViaRpc.mockImplementation(
      (options: { methods: Record<string, MethodDefinition> }) => {
        methods = options.methods;
        return client;
      }
    );
    const call = vi.fn(async () => undefined) as unknown as ConnectionConfig["rpc"]["call"];
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call,
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => {
      expect(methods?.["set_title"]).toBeDefined();
    });

    const result = await methods!["set_title"]!.execute(
      { title: "Welcome to NatStack" },
      {} as never
    );

    expect(result).toEqual({ ok: true });
    expect(document.title).toBe("Welcome to NatStack");
    expect(config.rpc.call).toHaveBeenCalledWith("main", "runtime.setTitle", [
      "Welcome to NatStack",
      { explicit: true },
    ]);
    expect(client.updateChannelConfig).toHaveBeenCalledWith({
      title: "Welcome to NatStack",
      titleExplicit: false,
    });

    unmount();
  });

  it("reports a warning if the direct runtime title update fails", async () => {
    const client = createClient();
    let methods: Record<string, MethodDefinition> | undefined;
    pubsubMock.connectViaRpc.mockImplementation(
      (options: { methods: Record<string, MethodDefinition> }) => {
        methods = options.methods;
        return client;
      }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const call = vi.fn(async (_target: string, method: string) => {
      if (method === "runtime.setTitle") {
        throw new Error("runtime unavailable");
      }
      return null;
    }) as unknown as ConnectionConfig["rpc"]["call"];
    const config: ConnectionConfig = {
      clientId: "panel:chat",
      rpc: {
        selfId: "panel:chat",
        call,
        on: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<Probe config={config} />);

    await waitFor(() => {
      expect(methods?.["set_title"]).toBeDefined();
    });

    const result = await methods!["set_title"]!.execute(
      { title: "Welcome to NatStack" },
      {} as never
    );

    expect(result).toEqual({ ok: true, warnings: ["runtime unavailable"] });
    expect(client.updateChannelConfig).toHaveBeenCalledWith({
      title: "Welcome to NatStack",
      titleExplicit: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "[useAgenticChat] runtime.setTitle failed:",
      expect.any(Error)
    );

    unmount();
  });
});
