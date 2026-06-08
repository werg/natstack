import { DurableObjectBase } from "@workspace/runtime/worker";
import type { WorkspaceConfig } from "@workspace/runtime/worker";
import {
  DEFAULT_AGENT_MODEL_REF,
  WORKSPACE_DEFAULT_MODEL_FIELD,
  type AgentThinkingLevel,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogProvider,
  type ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import {
  isTemplatedBaseUrl,
  modelIsConnectable,
  providerIsConnectable,
} from "@workspace/model-catalog/providerConnect";
import { pickRecommendedModelId } from "@workspace/model-catalog/modelRecommendations";

const AGENT_THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high"]);

type PiAiModule = typeof import("@earendil-works/pi-ai");

async function loadPiAi(): Promise<PiAiModule> {
  return import("@earendil-works/pi-ai");
}

let cachedCatalog: Promise<ModelCatalog> | null = null;

export function getModelCatalog(): Promise<ModelCatalog> {
  if (!cachedCatalog) {
    const catalogPromise = buildModelCatalog();
    cachedCatalog = catalogPromise;
    catalogPromise.catch(() => {
      if (cachedCatalog === catalogPromise) cachedCatalog = null;
    });
  }
  return cachedCatalog;
}

export async function buildModelCatalog(): Promise<ModelCatalog> {
  const { getModels, getProviders, getSupportedThinkingLevels } = await loadPiAi();
  const providerIds = getProviders();
  const providers: ModelCatalogProvider[] = [];
  const models: ModelCatalogEntry[] = [];
  const recommendedRefs = new Set<string>();

  for (const providerId of providerIds) {
    const provModels = getModels(providerId);
    const recommendedId = pickRecommendedModelId(providerId, provModels);
    if (recommendedId) recommendedRefs.add(`${providerId}:${recommendedId}`);
  }

  for (const providerId of providerIds) {
    const provModels = getModels(providerId);
    const baseUrls = Array.from(new Set(provModels.map((model) => model.baseUrl)));
    const recommendedModelId = pickRecommendedModelId(providerId, provModels);
    providers.push({
      id: providerId,
      label: providerId,
      baseUrls,
      recommendedModelRef: recommendedModelId ? `${providerId}:${recommendedModelId}` : null,
      connectable:
        providerIsConnectable(providerId) && baseUrls.some((url) => !isTemplatedBaseUrl(url)),
    });

    for (const model of provModels) {
      const ref = `${providerId}:${model.id}`;
      const thinkingLevels = model.reasoning
        ? (getSupportedThinkingLevels(model).filter((level) =>
            AGENT_THINKING_LEVELS.has(level)
          ) as AgentThinkingLevel[])
        : [];
      models.push({
        ref,
        id: model.id,
        name: model.name,
        provider: providerId,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        vision: model.input.includes("image"),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        thinkingLevels,
        templatedBaseUrl: isTemplatedBaseUrl(model.baseUrl),
        connectable: modelIsConnectable(providerId, model.baseUrl),
        recommended: recommendedRefs.has(ref),
      });
    }
  }

  return { providers, models };
}

export class ModelSettingsDO extends DurableObjectBase {
  protected createTables(): void {}

  async listCatalog(): Promise<ModelCatalog> {
    return this.getCatalog();
  }

  async getSettings(): Promise<ModelSettingsSnapshot> {
    const [catalog, config] = await Promise.all([
      this.getCatalog(),
      this.getWorkspaceConfig(),
    ]);
    return this.resolveSettings(catalog, config);
  }

  async getDefaultModel(): Promise<ModelSettingsSnapshot> {
    return this.getSettings();
  }

  async setDefaultModel(modelRef: string): Promise<ModelSettingsSnapshot> {
    const catalog = await this.getCatalog();
    const model = catalog.models.find((entry) => entry.ref === modelRef);
    if (!model) {
      throw new Error(`Unknown model ref: ${modelRef}`);
    }
    await this.setWorkspaceConfigField(WORKSPACE_DEFAULT_MODEL_FIELD, model.ref);
    return {
      catalog,
      defaultModel: model.ref,
      defaultModelSource: "workspace",
    };
  }

  protected getCatalog(): Promise<ModelCatalog> {
    return getModelCatalog();
  }

  protected getWorkspaceConfig(): Promise<WorkspaceConfig> {
    return this.rpc.call<WorkspaceConfig>("main", "workspace.getConfig", []);
  }

  protected setWorkspaceConfigField(key: string, value: unknown): Promise<void> {
    return this.rpc.call<void>("main", "workspace.setConfigField", [key, value]);
  }

  private resolveSettings(catalog: ModelCatalog, config: WorkspaceConfig): ModelSettingsSnapshot {
    const configured = normalizeModelRef(config.defaultAgentModel);
    if (configured && catalog.models.some((model) => model.ref === configured)) {
      return {
        catalog,
        defaultModel: configured,
        defaultModelSource: "workspace",
      };
    }
    return {
      catalog,
      defaultModel: pickFallbackModel(catalog),
      defaultModelSource: "fallback",
      ...(configured ? { invalidDefaultModel: configured } : {}),
    };
  }
}

function normalizeModelRef(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function pickFallbackModel(catalog: ModelCatalog): string {
  if (catalog.models.some((model) => model.ref === DEFAULT_AGENT_MODEL_REF)) {
    return DEFAULT_AGENT_MODEL_REF;
  }
  return catalog.models.find((model) => model.recommended)?.ref ?? catalog.models[0]?.ref ?? "";
}

export default {
  async fetch() {
    return new Response(
      "Model Settings service.\nMethods: listCatalog, getSettings, getDefaultModel, setDefaultModel.\n",
      { headers: { "Content-Type": "text/plain" } },
    );
  },
};
