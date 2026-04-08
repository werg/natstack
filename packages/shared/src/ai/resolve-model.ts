/**
 * resolveModelToPi
 *
 * Parses a NatStack-style "provider:model" string into a Pi `Model<any>`
 * object. The model id format stays `provider:model` — Pi is the runtime,
 * not a provider, so there is no `pi:` namespace.
 *
 * Resolution order:
 *   1. ModelRegistry.find() — covers custom providers from models.json
 *   2. pi-ai's built-in getModel() — covers known providers (anthropic, openai, ...)
 *
 * Throws if neither resolves the model.
 */

import { getModel as piGetModel } from "@mariozechner/pi-ai";
import {
  ModelRegistry,
  type AuthStorage,
} from "@mariozechner/pi-coding-agent";

export interface ResolvedModel {
  /** Pi Model object suitable for createAgentSession({ model }). */
  model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
  /** Provider id parsed from the input string. */
  provider: string;
  /** Bare model id parsed from the input string. */
  modelId: string;
}

export function resolveModelToPi(
  modelStr: string,
  authStorage: AuthStorage,
): ResolvedModel {
  const colonIdx = modelStr.indexOf(":");
  if (colonIdx < 0) {
    throw new Error(
      `Model string must be "provider:model": got "${modelStr}"`,
    );
  }
  const provider = modelStr.slice(0, colonIdx);
  const modelId = modelStr.slice(colonIdx + 1);
  if (!provider || !modelId) {
    throw new Error(
      `Model string must be "provider:model": got "${modelStr}"`,
    );
  }

  // Custom providers (registered via models.json) take precedence.
  const registry = new ModelRegistry(authStorage);
  const fromRegistry = registry.find(provider, modelId);
  if (fromRegistry) {
    return { model: fromRegistry, provider, modelId };
  }

  // Fall back to pi-ai's built-in model list. The cast is necessary because
  // piGetModel uses a tightly-typed conditional return; we accept the runtime
  // string and let Pi throw if it's truly unknown.
  try {
    const fromBuiltin = piGetModel(provider as never, modelId as never);
    if (fromBuiltin) {
      return { model: fromBuiltin, provider, modelId };
    }
  } catch {
    // fallthrough
  }

  throw new Error(
    `Unknown model: "${modelStr}" (provider="${provider}", modelId="${modelId}"). ` +
      `Make sure the provider is recognized by pi-ai or registered in models.json.`,
  );
}
