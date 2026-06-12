import type { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import {
  ServiceError,
  type ServiceContext,
  type DeferredResult,
} from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { withCapability } from "./capabilityPermission.js";
import {
  authorizeCorsSchema,
  corsApprovalMethods,
  type CorsApprovalResult,
} from "@natstack/shared/serviceSchemas/corsApproval";

export type { CorsApprovalResult } from "@natstack/shared/serviceSchemas/corsApproval";

const SERVICE_NAME = "corsApproval";
const CAPABILITY = "cors-response-read";

export function createCorsApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
}): ServiceDefinition {
  async function authorize(
    ctx: ServiceContext,
    rawRequest: z.infer<typeof authorizeCorsSchema>
  ): Promise<CorsApprovalResult | DeferredResult> {
    if (
      ctx.caller.runtime.kind !== "panel" &&
      ctx.caller.runtime.kind !== "app" &&
      ctx.caller.runtime.kind !== "worker" &&
      ctx.caller.runtime.kind !== "do"
    ) {
      throw new ServiceError(
        SERVICE_NAME,
        "authorize",
        "corsApproval requires a verified panel, app, worker, or DO caller",
        "EACCES"
      );
    }

    const request = authorizeCorsSchema.parse(rawRequest);
    const target = normalizeHttpOrigin(request.targetUrl);
    if (!target) {
      return { allowed: false, reason: "CORS target must be an http(s) URL" };
    }

    return withCapability(
      {
        approvalQueue: deps.approvalQueue,
        grantStore: deps.grantStore,
      },
      ctx,
      {
        capability: CAPABILITY,
        dedupKey: `cors:${ctx.caller.runtime.id}:${target.origin}`,
        resource: {
          type: "url-origin",
          label: "Target origin",
          value: target.origin,
          key: target.origin,
        },
        title: "Allow cross-origin response access",
        description: "Allow this panel to read CORS-protected responses from this origin.",
        details: [
          { label: "Request origin", value: request.requestOrigin ?? "unknown" },
          { label: "Target origin", value: target.origin },
        ],
        deniedReason: "Cross-origin response access denied",
      },
      async (authorization): Promise<CorsApprovalResult> =>
        authorization.allowed
          ? { allowed: true, decision: authorization.decision }
          : { allowed: false, reason: authorization.reason }
    );
  }

  return {
    name: SERVICE_NAME,
    description: "Approval-gated CORS response header relaxation",
    policy: { allowed: ["panel", "app", "worker", "do"] },
    methods: corsApprovalMethods,
    handler: async (ctx, method, args) => {
      switch (method) {
        case "authorize":
          return authorize(ctx, args[0] as z.infer<typeof authorizeCorsSchema>);
        default:
          throw new ServiceError(
            SERVICE_NAME,
            method,
            `Unknown corsApproval method: ${method}`,
            "ENOSYS"
          );
      }
    },
  };
}

function normalizeHttpOrigin(rawUrl: string): { origin: string } | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { origin: url.origin };
  } catch {
    return null;
  }
}
