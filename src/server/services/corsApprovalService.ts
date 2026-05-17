import { z } from "zod";

import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";

const SERVICE_NAME = "corsApproval";
const CAPABILITY = "cors-response-read";

const authorizeCorsSchema = z
  .object({
    callerId: z.string().min(1),
    targetUrl: z.string().min(1),
    requestOrigin: z.string().min(1).optional(),
  })
  .strict();

export interface CorsApprovalResult {
  allowed: boolean;
  decision?: Exclude<GrantedDecision, "deny">;
  reason?: string;
}

export function createCorsApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
}): ServiceDefinition {
  async function authorize(
    ctx: ServiceContext,
    rawRequest: z.infer<typeof authorizeCorsSchema>
  ): Promise<CorsApprovalResult> {
    if (ctx.callerKind !== "shell" && ctx.callerKind !== "server") {
      throw new ServiceError(
        SERVICE_NAME,
        "authorize",
        "corsApproval is shell/server-only",
        "EACCES"
      );
    }

    const request = authorizeCorsSchema.parse(rawRequest);
    const target = normalizeHttpOrigin(request.targetUrl);
    if (!target) {
      return { allowed: false, reason: "CORS target must be an http(s) URL" };
    }

    const authorization = await requestCapabilityPermission(
      {
        approvalQueue: deps.approvalQueue,
        grantStore: deps.grantStore,
        codeIdentityResolver: deps.codeIdentityResolver,
      },
      {
        callerId: request.callerId,
        callerKind: "panel",
        capability: CAPABILITY,
        dedupKey: `cors:${request.callerId}:${target.origin}`,
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
      }
    );

    return authorization.allowed
      ? { allowed: true, decision: authorization.decision }
      : { allowed: false, reason: authorization.reason };
  }

  return {
    name: SERVICE_NAME,
    description: "Approval-gated CORS response header relaxation",
    policy: { allowed: ["shell", "server"] },
    methods: {
      authorize: { args: z.tuple([authorizeCorsSchema]) },
    },
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
