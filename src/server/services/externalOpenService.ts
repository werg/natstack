import { z } from "zod";
import type { EventService } from "@natstack/shared/eventsService";
import { assertAllowedOAuthExternalUrl } from "@natstack/shared/externalOpen";
import type { OpenExternalOptions } from "@natstack/shared/externalOpen";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import type { CapabilityGrantIdentity, CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";

const CAPABILITY = "external-browser-open";
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const OPEN_EXTERNAL_OPTIONS_SCHEMA = z.object({
  expectedRedirectUri: z.string().optional(),
}).strict();

export interface ExternalOpenServiceDeps {
  eventService: EventService;
  approvalQueue?: ApprovalQueue;
  grantStore?: CapabilityGrantStore;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "resolveByCallerId">;
}

export function createExternalOpenService(deps: ExternalOpenServiceDeps): ServiceDefinition {
  async function requestOpen(ctx: ServiceContext, rawUrl: string, options?: OpenExternalOptions): Promise<void> {
    const url = normalizeExternalUrl(rawUrl);
    if (options?.expectedRedirectUri) {
      assertAllowedOAuthExternalUrl(url.toString(), options.expectedRedirectUri);
    }
    const resource = resourceForExternalUrl(url);
    const identity = resolveIdentity(ctx, deps.codeIdentityResolver);

    if (ctx.callerKind === "panel" || ctx.callerKind === "worker") {
      if (!deps.grantStore || !deps.approvalQueue) {
        throw new Error("External browser open approval is unavailable");
      }
      if (!deps.grantStore.hasGrant(CAPABILITY, resource.key, identity)) {
        const decision = await requestApproval(ctx, url, options, resource, identity, deps.approvalQueue);
        if (decision === "deny") {
          throw new Error("External browser open denied");
        }
        if (decision !== "once") {
          deps.grantStore.grant(CAPABILITY, resource.key, identity, decision);
        }
      }
    }

    deps.eventService.emit("external-open:open", {
      url: url.toString(),
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
    });
  }

  return {
    name: "externalOpen",
    description: "Approval-gated system browser opens",
    policy: { allowed: ["shell", "server", "panel", "worker"] },
    methods: {
      openExternal: { args: z.tuple([z.string(), OPEN_EXTERNAL_OPTIONS_SCHEMA.optional()]) },
      openExternalForCaller: {
        args: z.tuple([
          z.object({
            callerId: z.string(),
            callerKind: z.enum(["panel", "worker"]),
            url: z.string(),
            options: OPEN_EXTERNAL_OPTIONS_SCHEMA.optional(),
          }).strict(),
        ]),
      },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "openExternal":
          return requestOpen(ctx, args[0] as string, args[1] as OpenExternalOptions | undefined);
        case "openExternalForCaller": {
          if (ctx.callerKind !== "shell" && ctx.callerKind !== "server") {
            throw new Error("openExternalForCaller is shell/server-only");
          }
          const [request] = args as [{
            callerId: string;
            callerKind: "panel" | "worker";
            url: string;
            options?: OpenExternalOptions;
          }];
          return requestOpen({
            callerId: request.callerId,
            callerKind: request.callerKind,
          }, request.url, request.options);
        }
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

function resourceForExternalUrl(url: URL): { key: string; label: string; value: string } {
  if (url.protocol === "mailto:") {
    return { key: "mailto:", label: "Scheme", value: "mailto:" };
  }
  return { key: url.origin, label: "Origin", value: url.origin };
}

function resolveIdentity(
  ctx: ServiceContext,
  codeIdentityResolver: ExternalOpenServiceDeps["codeIdentityResolver"],
): CapabilityGrantIdentity {
  const identity = codeIdentityResolver?.resolveByCallerId(ctx.callerId);
  return {
    repoPath: identity?.repoPath ?? ctx.callerId,
    effectiveVersion: identity?.effectiveVersion ?? "unknown",
  };
}

async function requestApproval(
  ctx: ServiceContext,
  url: URL,
  options: OpenExternalOptions | undefined,
  resource: { key: string; label: string; value: string },
  identity: CapabilityGrantIdentity,
  approvalQueue: ApprovalQueue,
): Promise<GrantedDecision> {
  const details = [
    { label: "URL", value: url.toString() },
  ];
  if (options?.expectedRedirectUri) {
    details.push({ label: "OAuth callback", value: options.expectedRedirectUri });
  }

  return approvalQueue.request({
    kind: "capability",
    callerId: ctx.callerId,
    callerKind: ctx.callerKind as "panel" | "worker",
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
    capability: CAPABILITY,
    title: "Open external browser",
    description: "Allow this code to open URLs in the system browser.",
    resource: {
      type: "url-origin",
      label: resource.label,
      value: resource.value,
    },
    details,
  });
}
