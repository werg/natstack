import { z } from "zod";
import type { EventService } from "@natstack/shared/eventsService";
import { assertAllowedOAuthExternalUrl } from "@natstack/shared/externalOpen";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";

const CAPABILITY = "external-browser-open";
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const OPEN_EXTERNAL_OPTIONS_SCHEMA = z
  .object({
    expectedRedirectUri: z.string().optional(),
  })
  .strict();

export interface ExternalOpenServiceDeps {
  eventService: EventService;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
}

export function createExternalOpenService(deps: ExternalOpenServiceDeps): ServiceDefinition {
  async function requestOpen(
    ctx: ServiceContext,
    rawUrl: string,
    options?: OpenExternalOptions
  ): Promise<OpenExternalResult> {
    const url = normalizeExternalUrl(rawUrl);
    if (options?.expectedRedirectUri) {
      assertAllowedOAuthExternalUrl(url.toString(), options.expectedRedirectUri);
    }
    const resource = resourceForExternalUrl(url);

    let approvalDecision: OpenExternalResult["approvalDecision"];
    if (
      ctx.caller.runtime.kind === "panel" ||
      ctx.caller.runtime.kind === "app" ||
      ctx.caller.runtime.kind === "worker" ||
      ctx.caller.runtime.kind === "do"
    ) {
      if (!deps.grantStore || !deps.approvalQueue) {
        throw new Error("External browser open approval is unavailable");
      }
      const authorization = await requestCapabilityPermission(
        {
          approvalQueue: deps.approvalQueue,
          grantStore: deps.grantStore,
        },
        {
          caller: ctx.caller,
          capability: CAPABILITY,
          resource,
          title: "Open external browser",
          description: "Allow this code to open URLs in the system browser.",
          details: externalOpenDetails(url, options),
          deniedReason: "External browser open denied",
        }
      );
      if (!authorization.allowed) {
        throw new Error(authorization.reason ?? "External browser open denied");
      }
      approvalDecision = authorization.decision;
    }

    deps.eventService.emit("external-open:open", {
      url: url.toString(),
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
    });
    return approvalDecision ? { approvalDecision } : {};
  }

  return {
    name: "externalOpen",
    description: "Approval-gated system browser opens",
    policy: { allowed: ["shell", "server", "panel", "app", "worker", "do", "extension"] },
    methods: {
      openExternal: { args: z.tuple([z.string(), OPEN_EXTERNAL_OPTIONS_SCHEMA.optional()]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "openExternal":
          return requestOpen(ctx, args[0] as string, args[1] as OpenExternalOptions | undefined);
        default:
          throw new Error(`Unknown externalOpen method: ${method}`);
      }
    },
  };
}

function normalizeExternalUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("openExternal requires an absolute URL");
  }
  if (!OPEN_EXTERNAL_ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error("openExternal only supports http(s) and mailto URLs");
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.hash = "";
  }
  return url;
}

function resourceForExternalUrl(url: URL): {
  key: string;
  type: string;
  label: string;
  value: string;
} {
  if (url.protocol === "mailto:") {
    return { key: "mailto:", type: "url-origin", label: "Scheme", value: "mailto:" };
  }
  return { key: url.origin, type: "url-origin", label: "Origin", value: url.origin };
}

function externalOpenDetails(
  url: URL,
  options: OpenExternalOptions | undefined
): Array<{ label: string; value: string }> {
  const details = [{ label: "URL", value: url.toString() }];
  if (options?.expectedRedirectUri) {
    details.push({ label: "OAuth callback", value: options.expectedRedirectUri });
  }
  return details;
}
