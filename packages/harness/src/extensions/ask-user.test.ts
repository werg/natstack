import { describe, it, expect, vi } from "vitest";
import { createAskUserExtension, type AskUserParams } from "./ask-user.js";

interface MockTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

function createMockApi() {
  const registered = new Map<string, MockTool>();
  return {
    on: vi.fn(),
    registerTool: vi.fn((tool: MockTool) => {
      registered.set(tool.name, tool);
    }),
    getRegistered: () => registered,
  };
}

describe("createAskUserExtension", () => {
  it("registers an ask_user tool", () => {
    const factory = createAskUserExtension({
      askUser: vi.fn().mockResolvedValue("answer"),
    });
    const api = createMockApi();
    factory(api as never);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.getRegistered().has("ask_user")).toBe(true);
  });

  it("execute() forwards the params and returns the user's answer", async () => {
    const askUser = vi.fn().mockResolvedValue("Yes, do it");
    const factory = createAskUserExtension({ askUser });
    const api = createMockApi();
    factory(api as never);

    const tool = api.getRegistered().get("ask_user")!;
    const params: AskUserParams = { question: "Should I proceed?" };
    const result = await tool.execute("call-1", params, undefined);

    expect(askUser).toHaveBeenCalledWith("call-1", params, undefined);
    expect(result.content[0]!.text).toBe("Yes, do it");
  });

  it("execute() forwards structured questions", async () => {
    const askUser = vi.fn().mockResolvedValue("opt-2");
    const factory = createAskUserExtension({ askUser });
    const api = createMockApi();
    factory(api as never);

    const params: AskUserParams = {
      questions: [
        {
          question: "Pick one",
          options: [{ label: "opt-1" }, { label: "opt-2" }],
        },
      ],
    };
    const tool = api.getRegistered().get("ask_user")!;
    await tool.execute("call-1", params, undefined);

    expect(askUser).toHaveBeenCalledWith("call-1", params, undefined);
  });

  it("propagates the abort signal", async () => {
    const askUser = vi.fn().mockResolvedValue("");
    const factory = createAskUserExtension({ askUser });
    const api = createMockApi();
    factory(api as never);

    const ctrl = new AbortController();
    const tool = api.getRegistered().get("ask_user")!;
    await tool.execute("call-1", { question: "?" }, ctrl.signal);

    expect(askUser).toHaveBeenCalledWith("call-1", { question: "?" }, ctrl.signal);
  });
});
