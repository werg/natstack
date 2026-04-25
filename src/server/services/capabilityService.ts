/**
 * RPC shim exposing the CapabilityBroker under the `capabilities` service name.
 *
 * Methods:
 *   - `mintSession`: zero-arg, returns a session capability bound to ctx.callerId.
 *   - `mint`: mint a provider capability. Gated by the consent bar on first use.
 *   - `metadata`: server-extracted, non-secret credential metadata (JWT claims etc.).
 */
import { z } from "zod";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import type { ServiceContext } from "../../../packages/shared/src/serviceDispatcher.js";
import type { ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import { providerManifestSchema } from "../../../packages/shared/src/credentials/providerManifestSchema.js";
import type { CapabilityBroker } from "./capabilityBroker.js";

const mintParamsSchema = z
  .object({
    provider: providerManifestSchema,
    connectionId: z.string().min(1).max(128).optional(),
    ttlSeconds: z.number().int().positive().max(24 * 60 * 60).optional(),
  })
  .strict();

const mintSessionParamsSchema = z
  .object({
    ttlSeconds: z.number().int().positive().max(24 * 60 * 60).optional(),
  })
  .strict()
  .optional();

const metadataParamsSchema = z
  .object({
    provider: providerManifestSchema,
    connectionId: z.string().min(1).max(128).optional(),
  })
  .strict();

type MintParams = z.infer<typeof mintParamsSchema>;
type MintSessionParams = z.infer<typeof mintSessionParamsSchema>;
type MetadataParams = z.infer<typeof metadataParamsSchema>;

export interface CapabilityServiceDeps {
  broker: CapabilityBroker;
}

export function createCapabilityService(deps: CapabilityServiceDeps): ServiceDefinition {
  const { broker } = deps;

  function throwCapabilityError(error: { message: string; code?: string }): never {
    const err = new Error(error.message) as Error & { code?: string };
    if (error.code) err.code = error.code;
    throw err;
  }

  async function mint(ctx: ServiceContext, params: MintParams) {
    const result = await broker.mintProvider({
      callerId: ctx.callerId,
      provider: params.provider as ProviderManifest,
      connectionId: params.connectionId,
      ttlSeconds: params.ttlSeconds,
    });
    if ("error" in result) {
      throwCapabilityError(result.error);
    }
    return { token: result.token, expiresAt: result.expiresAt };
  }

  async function mintSession(ctx: ServiceContext, params?: MintSessionParams) {
    const result = await broker.mintSession({
      callerId: ctx.callerId,
      ttlSeconds: params?.ttlSeconds,
    });
    if ("error" in result) {
      throwCapabilityError(result.error);
    }
    return { token: result.token, expiresAt: result.expiresAt };
  }

  async function metadata(_ctx: ServiceContext, params: MetadataParams) {
    const result = await broker.metadata({
      callerId: _ctx.callerId,
      provider: params.provider as ProviderManifest,
      connectionId: params.connectionId,
    });
    if ("error" in result) {
      throwCapabilityError(result.error);
    }
    return result;
  }

  return {
    name: "capabilities",
    description: "Capability-token broker for unified egress authority",
    policy: { allowed: ["worker", "panel", "server"] },
    methods: {
      mint: { args: z.tuple([mintParamsSchema]) },
      mintSession: { args: z.tuple([mintSessionParamsSchema]).or(z.tuple([])) },
      metadata: { args: z.tuple([metadataParamsSchema]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "mint":
          return mint(ctx, (args as [MintParams])[0]);
        case "mintSession":
          return mintSession(ctx, (args as [MintSessionParams])[0]);
        case "metadata":
          return metadata(ctx, (args as [MetadataParams])[0]);
        default:
          throw new Error(`Unknown capabilities method: ${method}`);
      }
    },
  };
}
