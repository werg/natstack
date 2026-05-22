import { describe, expect, it } from "vitest";
import { buildEvalTool } from "./eval-tool.js";

function createEvalTool() {
  return buildEvalTool({
    sandbox: {
      rpc: {
        call: async () => ({}),
      },
      loadImport: async () => "",
    },
    rpc: {
      call: async () => ({}),
    },
    runtimeTarget: "panel",
    getChatSandboxValue: () => ({
      publish: async () => ({}),
      send: async () => ({}),
      publishCustomMessage: async () => ({ messageId: "custom-1", pubsubId: 1 }),
      updateCustomMessage: async () => 2,
      callMethod: async () => ({}),
      callMethodResult: async () => ({ content: {} }),
      participantByHandle: () => null,
      callMethodByHandle: async () => ({}),
      callMethodResultByHandle: async () => ({ content: {} }),
      contextId: "ctx-test",
      channelId: "channel-test",
      rpc: { call: async () => ({}) },
    }),
    getScope: () => ({}),
  });
}

describe("buildEvalTool", () => {
  it("does not accept a timeout parameter", () => {
    const tool = createEvalTool();

    const parsed = tool.parameters.safeParse({
      code: "return 1;",
      timeout: 10_000,
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts the supported eval parameters", () => {
    const tool = createEvalTool();

    const parsed = tool.parameters.safeParse({
      code: "return 1;",
      syntax: "tsx",
      imports: { lodash: "npm:^4.17.21" },
    });

    expect(parsed.success).toBe(true);
  });
});
