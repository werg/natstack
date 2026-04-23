import { describe, it, expect, vi } from "vitest";
import {
  createChannelToolsExtension,
  type ChannelToolMethod,
} from "./channel-tools.js";

interface MockTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>;
}

function createMockApi() {
  const registered = new Map<string, MockTool>();
  let activeTools: string[] = [];
  const handlers = new Map<string, () => Promise<void> | void>();

  return {
    on: vi.fn((event: string, handler: () => Promise<void> | void) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: MockTool) => {
      registered.set(tool.name, tool);
    }),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = [...names];
    }),
    fire: async (event: string) => {
      const h = handlers.get(event);
      if (h) await h();
    },
    getRegistered: () => registered,
    getActive: () => activeTools,
  };
}

const BUILTIN: readonly string[] = ["bash", "read", "edit", "write"];

describe("createChannelToolsExtension", () => {
  it("registers tools from the roster on session_start", async () => {
    const roster: ChannelToolMethod[] = [
      {
        participantHandle: "ai-chat",
        name: "inline_ui",
        description: "Render inline UI",
        parameters: { type: "object", properties: {} },
      },
      {
        participantHandle: "sandbox",
        name: "eval",
        description: "Run eval",
        parameters: { type: "object", properties: { code: { type: "string" } } },
      },
    ];

    const factory = createChannelToolsExtension({
      getRoster: () => roster,
      callMethod: vi.fn().mockResolvedValue("ok"),
      builtinToolNames: BUILTIN,
    });
    const api = createMockApi();
    factory(api as never);
    await api.fire("session_start");

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(api.getRegistered().has("inline_ui")).toBe(true);
    expect(api.getRegistered().has("eval")).toBe(true);
    expect(api.getActive()).toEqual(
      expect.arrayContaining([...BUILTIN, "inline_ui", "eval"]),
    );
  });

  it("registers new tools added between turns and updates active set", async () => {
    let roster: ChannelToolMethod[] = [
      {
        participantHandle: "ai-chat",
        name: "inline_ui",
        description: "",
        parameters: {},
      },
    ];
    const factory = createChannelToolsExtension({
      getRoster: () => roster,
      callMethod: vi.fn().mockResolvedValue("ok"),
      builtinToolNames: BUILTIN,
    });
    const api = createMockApi();
    factory(api as never);

    await api.fire("session_start");
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.getActive()).toContain("inline_ui");
    expect(api.getActive()).not.toContain("eval");

    // Add a new tool
    roster = [
      ...roster,
      {
        participantHandle: "sandbox",
        name: "eval",
        description: "",
        parameters: {},
      },
    ];
    await api.fire("turn_start");
    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(api.getActive()).toEqual(
      expect.arrayContaining([...BUILTIN, "inline_ui", "eval"]),
    );
  });

  it("hides removed tools by leaving them out of setActiveTools", async () => {
    let roster: ChannelToolMethod[] = [
      { participantHandle: "ai-chat", name: "inline_ui", description: "", parameters: {} },
      { participantHandle: "sandbox", name: "eval", description: "", parameters: {} },
    ];
    const factory = createChannelToolsExtension({
      getRoster: () => roster,
      callMethod: vi.fn().mockResolvedValue("ok"),
      builtinToolNames: BUILTIN,
    });
    const api = createMockApi();
    factory(api as never);

    await api.fire("session_start");
    expect(api.getActive()).toContain("eval");

    roster = roster.filter((m) => m.name !== "eval");
    await api.fire("turn_start");
    expect(api.getActive()).toContain("inline_ui");
    expect(api.getActive()).not.toContain("eval");
    // Tool stays registered (Pi has no unregisterTool) but inactive.
    expect(api.getRegistered().has("eval")).toBe(true);
  });

  it("execute() forwards to callMethod with the participant handle", async () => {
    const callMethod = vi.fn().mockResolvedValue({ ok: true });
    const factory = createChannelToolsExtension({
      getRoster: () => [
        {
          participantHandle: "sandbox",
          name: "eval",
          description: "",
          parameters: {},
        },
      ],
      callMethod,
      builtinToolNames: BUILTIN,
    });
    const api = createMockApi();
    factory(api as never);
    await api.fire("session_start");

    const tool = api.getRegistered().get("eval")!;
    const result = await tool.execute("call-1", { code: "1+1" }, undefined);

    expect(callMethod).toHaveBeenCalledWith(
      "call-1",
      "sandbox",
      "eval",
      { code: "1+1" },
      undefined,
      undefined,
    );
    expect(result.content[0]!.text).toBe(JSON.stringify({ ok: true }));
  });

  it("execute() returns an error result if the tool is no longer in the roster", async () => {
    let roster: ChannelToolMethod[] = [
      { participantHandle: "sandbox", name: "eval", description: "", parameters: {} },
    ];
    const callMethod = vi.fn();
    const factory = createChannelToolsExtension({
      getRoster: () => roster,
      callMethod,
      builtinToolNames: BUILTIN,
    });
    const api = createMockApi();
    factory(api as never);
    await api.fire("session_start");

    const tool = api.getRegistered().get("eval")!;

    // Roster gets cleared between registration and execute
    roster = [];

    const result = await tool.execute("call-1", {}, undefined);
    expect(result.isError).toBe(true);
    expect(callMethod).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toMatch(/no longer available/);
  });

  it("throws on duplicate tool names from different handles (defense in depth)", async () => {
    const factory = createChannelToolsExtension({
      getRoster: () => [
        { participantHandle: "ai-chat", name: "ping", description: "", parameters: {} },
        { participantHandle: "sandbox", name: "ping", description: "", parameters: {} },
      ],
      callMethod: vi.fn(),
      builtinToolNames: BUILTIN,
    });
    const api = createMockApi();
    factory(api as never);
    await expect(api.fire("session_start")).rejects.toThrow(/Tool name collision/);
  });
});
