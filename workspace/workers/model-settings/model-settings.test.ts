import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { WorkspaceConfig } from "@workspace/runtime/worker";
import type { ModelCatalog } from "@workspace/model-catalog/catalog";
import { ModelSettingsDO } from "./index.js";

const CATALOG: ModelCatalog = {
  providers: [
    {
      id: "openai",
      label: "openai",
      baseUrls: ["https://api.openai.com/v1"],
      recommendedModelRef: "openai:gpt-5",
      connectable: true,
    },
    {
      id: "anthropic",
      label: "anthropic",
      baseUrls: ["https://api.anthropic.com/v1"],
      recommendedModelRef: "anthropic:claude-opus-4-1",
      connectable: true,
    },
  ],
  models: [
    {
      ref: "openai:gpt-5",
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      vision: true,
      contextWindow: 128000,
      maxTokens: 16000,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      templatedBaseUrl: false,
      connectable: true,
      recommended: true,
    },
    {
      ref: "anthropic:claude-opus-4-1",
      id: "claude-opus-4-1",
      name: "Claude Opus 4.1",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      reasoning: true,
      vision: true,
      contextWindow: 200000,
      maxTokens: 32000,
      thinkingLevels: ["low", "medium", "high"],
      templatedBaseUrl: false,
      connectable: true,
      recommended: true,
    },
  ],
};

class TestModelSettingsDO extends ModelSettingsDO {
  static config: WorkspaceConfig = { id: "test" };
  static writes: Array<{ key: string; value: unknown }> = [];

  protected getCatalog(): Promise<ModelCatalog> {
    return Promise.resolve(CATALOG);
  }

  protected getWorkspaceConfig(): Promise<WorkspaceConfig> {
    return Promise.resolve(TestModelSettingsDO.config);
  }

  protected setWorkspaceConfigField(key: string, value: unknown): Promise<void> {
    TestModelSettingsDO.writes.push({ key, value });
    TestModelSettingsDO.config = {
      ...TestModelSettingsDO.config,
      [key]: value,
    };
    return Promise.resolve();
  }
}

describe("ModelSettingsDO", () => {
  it("reads the configured workspace default model", async () => {
    TestModelSettingsDO.config = {
      id: "test",
      defaultAgentModel: "anthropic:claude-opus-4-1",
    };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultModel: "anthropic:claude-opus-4-1",
      defaultModelSource: "workspace",
    });
  });

  it("falls back when the configured default is missing from the catalog", async () => {
    TestModelSettingsDO.config = {
      id: "test",
      defaultAgentModel: "missing:model",
    };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("getSettings")).resolves.toMatchObject({
      defaultModel: "openai:gpt-5",
      defaultModelSource: "fallback",
      invalidDefaultModel: "missing:model",
    });
  });

  it("persists a validated default model to workspace config", async () => {
    TestModelSettingsDO.config = { id: "test" };
    TestModelSettingsDO.writes = [];
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("setDefaultModel", "anthropic:claude-opus-4-1")).resolves.toMatchObject({
      defaultModel: "anthropic:claude-opus-4-1",
      defaultModelSource: "workspace",
    });
    expect(TestModelSettingsDO.writes).toEqual([
      { key: "defaultAgentModel", value: "anthropic:claude-opus-4-1" },
    ]);
  });

  it("rejects unknown default model refs", async () => {
    TestModelSettingsDO.config = { id: "test" };
    const { call } = await createTestDO(TestModelSettingsDO);

    await expect(call("setDefaultModel", "missing:model")).rejects.toThrow(
      "Unknown model ref: missing:model"
    );
  });
});
