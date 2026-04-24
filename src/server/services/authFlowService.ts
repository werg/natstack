import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { z } from "zod";
import { openaiCodex, type AuthFlowSession, type AuthFlowCredentials } from "@natstack/auth-flow";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createDevLogger } from "@natstack/dev-log";
import type { AuthTokensServiceImpl } from "./authService.js";

const log = createDevLogger("auth");
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
/** Hard cap on simultaneously-pending OAuth flows. Prevents a malicious
 *  caller from filling memory by issuing endless `startOAuthLogin`
 *  requests. When the cap is reached, the oldest entry is evicted
 *  (LRU-by-insertion-order on the underlying Map). */
const MAX_PENDING_FLOWS = 1000;

interface ProviderHandle {
  buildAuthUrl(redirectUri: string): Promise<{ authUrl: string; session: AuthFlowSession }>;
  exchangeCode(opts: { code: string; verifier: string; redirectUri: string }): Promise<AuthFlowCredentials>;
}

interface PendingFlow {
  providerId: string;
  session: AuthFlowSession;
  timer: ReturnType<typeof setTimeout>;
}

const defaultProviders: Record<string, ProviderHandle> = {
  "openai-codex": {
    buildAuthUrl: (redirectUri) => openaiCodex.buildAuthorizeUrl({ redirectUri }),
    exchangeCode: (opts) => openaiCodex.exchangeCode(opts),
  },
};

export interface AuthFlowServiceDeps {
  authTokens: AuthTokensServiceImpl;
  providers?: Record<string, ProviderHandle>;
}

const callbackPayloadSchema = z.object({
  callbackUrl: z.string().url(),
});

export function createAuthFlowService(deps: AuthFlowServiceDeps): ServiceDefinition {
  const providers = deps.providers ?? defaultProviders;
  const pendingFlows = new Map<string, PendingFlow>();

  const clearFlow = (flowId: string): void => {
    const pending = pendingFlows.get(flowId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingFlows.delete(flowId);
  };

  const startFlow = async (providerId: string, redirectUri: string) => {
    const provider = providers[providerId];
    if (!provider) {
      throw new Error(`OAuth not supported for ${providerId}`);
    }

    const { authUrl, session } = await provider.buildAuthUrl(redirectUri);
    const flowId = randomUUID();
    const timer = setTimeout(() => {
      pendingFlows.delete(flowId);
    }, FLOW_TIMEOUT_MS);
    // SECURITY (#36 in audit): unref so a long-pending flow does not
    // hold the Node event loop alive past process shutdown.
    if (typeof timer.unref === "function") timer.unref();

    // SECURITY: cap the table size. Map preserves insertion order, so
    // iterator's first key is the oldest entry — evict it (and its
    // timer) before inserting the new one.
    while (pendingFlows.size >= MAX_PENDING_FLOWS) {
      const oldestId = pendingFlows.keys().next().value;
      if (typeof oldestId !== "string") break;
      const oldest = pendingFlows.get(oldestId);
      if (oldest) clearTimeout(oldest.timer);
      pendingFlows.delete(oldestId);
    }

    pendingFlows.set(flowId, {
      providerId,
      session,
      timer,
    });
    return { flowId, authUrl };
  };

  const completeFlow = async (flowId: string, callbackUrl: string) => {
    const pending = pendingFlows.get(flowId);
    if (!pending) {
      throw new Error("OAuth flow not found or expired");
    }

    const callback = new URL(callbackUrl);
    const state = callback.searchParams.get("state") ?? "";
    const code = callback.searchParams.get("code") ?? "";
    const error = callback.searchParams.get("error");

    // SECURITY (#36 in audit): compare full origin + pathname, not just
    // pathname. The previous check accepted callbacks on a different
    // host or scheme as long as the path component matched, which would
    // let an attacker who can steer the OAuth provider's redirect to
    // their own host (or to `http:` instead of `https:`) complete a
    // flow against the wrong origin.
    const expected = new URL(pending.session.redirectUri);
    if (
      callback.protocol !== expected.protocol ||
      callback.host !== expected.host ||
      callback.pathname !== expected.pathname
    ) {
      throw new Error("OAuth callback URL mismatch");
    }
    if (error) {
      clearFlow(flowId);
      throw new Error(`OAuth provider error: ${error}`);
    }
    if (state !== pending.session.state) {
      clearFlow(flowId);
      throw new Error("OAuth state mismatch");
    }
    if (!code) {
      clearFlow(flowId);
      throw new Error("OAuth callback missing code");
    }

    const provider = providers[pending.providerId];
    if (!provider) {
      clearFlow(flowId);
      throw new Error(`OAuth provider unavailable for ${pending.providerId}`);
    }

    try {
      const credentials = await provider.exchangeCode({
        code,
        verifier: pending.session.verifier,
        redirectUri: pending.session.redirectUri,
      });
      await deps.authTokens.persist(pending.providerId, {
        access: credentials.access,
        refresh: credentials.refresh,
        expires: credentials.expires,
        extra: Object.fromEntries(
          Object.entries(credentials).filter(([key]) => !["access", "refresh", "expires"].includes(key)),
        ),
      });
      return { success: true };
    } finally {
      clearFlow(flowId);
    }
  };

  return {
    name: "auth",
    description: "Server-owned OAuth flow core logic",
    policy: { allowed: ["shell", "panel", "worker", "server"] },
    methods: {
      startOAuthLogin: {
        args: z.tuple([z.string(), z.string().url()]),
      },
      completeOAuthLogin: {
        args: z.tuple([z.string(), callbackPayloadSchema]),
      },
      listProviders: {
        args: z.tuple([]),
      },
      logout: {
        args: z.tuple([z.string()]),
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "startOAuthLogin":
          return startFlow(args[0] as string, args[1] as string);
        case "completeOAuthLogin":
          return completeFlow(args[0] as string, (args[1] as z.infer<typeof callbackPayloadSchema>).callbackUrl);
        case "listProviders":
          return deps.authTokens.listProviders();
        case "logout":
          return deps.authTokens.logout(args[0] as string);
        default:
          log.warn(`Unknown auth method: ${method}`);
          throw new Error(`Unknown auth method: ${method}`);
      }
    },
  };
}
