import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { FsService } from "@natstack/shared/fsService";
import type { GitServer } from "@natstack/git-server";
import { savePersistedAdminToken } from "@natstack/shared/centralAuth";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";

export function createTokensService(deps: {
  tokenManager: TokenManager;
  fsService: FsService;
  gitServer: GitServer;
  codeIdentityResolver?: Pick<CodeIdentityResolver, "upsertCallerIdentity" | "unregisterCaller">;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
  /**
   * Optional — omit in IPC (Electron-embedded) mode where the admin token
   * lives in Electron parent memory and is never persisted centrally. When
   * set, `rotateAdmin` persists the new token to `~/.config/natstack/admin-token`
   * so restarts pick it up.
   */
  persistAdminToken?: (token: string) => void;
}): ServiceDefinition {
  return {
    name: "tokens",
    description: "Token management (create/revoke panel tokens)",
    policy: { allowed: ["server", "shell"] },
    methods: {
      create: { args: z.tuple([z.string(), z.string()]) },
      ensure: { args: z.tuple([z.string(), z.string()]) },
      revoke: { args: z.tuple([z.string()]) },
      get: { args: z.tuple([z.string()]) },
      ensurePanelToken: { args: z.tuple([z.string(), z.string(), z.string().nullable().optional(), z.string().optional()]) },
      revokePanelToken: { args: z.tuple([z.string()]) },
      updatePanelContext: { args: z.tuple([z.string(), z.string()]) },
      updatePanelParent: { args: z.tuple([z.string(), z.string().nullable()]) },
      /**
       * Rotate the admin token. Generates a fresh 32-byte hex token, persists
       * it to the central config dir (if enabled), swaps it into the token
       * manager, and returns the new token. Existing WS connections that
       * already authenticated with the old token keep their live session —
       * only new connects and reconnects need the new token. The client
       * receives the new token once; callers should immediately write it
       * into their credential store and plan a relaunch.
       *
       * Policy: server + shell only. Never callable from panel or worker —
       * those are semantically untrusted.
       */
      rotateAdmin: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      const tm = deps.tokenManager;
      switch (method) {
        case "create": return tm.createToken(args[0] as string, args[1] as CallerKind);
        case "ensure": return tm.ensureToken(args[0] as string, args[1] as CallerKind);
        case "revoke": tm.revokeToken(args[0] as string); return;
        case "get": try { return tm.getToken(args[0] as string); } catch { return null; }
        case "ensurePanelToken": {
          const [panelId, contextId, parentId, source] = args as [string, string, string | null | undefined, string | undefined];
          const token = tm.ensureToken(panelId, "panel");
          tm.setPanelParent(panelId, parentId ?? null);
          if (ctx.callerKind === "shell" || ctx.callerKind === "server") {
            tm.setPanelOwner(panelId, ctx.callerId);
          }
          deps.fsService.registerCallerContext(panelId, contextId);
          if (source && deps.codeIdentityResolver) {
            const effectiveVersion = source.startsWith("browser:")
              ? ""
              : await Promise.resolve(deps.getEffectiveVersion?.(source)).catch(() => undefined) ?? "";
            deps.codeIdentityResolver.upsertCallerIdentity({
              callerId: panelId,
              callerKind: "panel",
              repoPath: source,
              effectiveVersion,
            });
          }
          const gitToken = deps.gitServer.getTokenForPanel(panelId);
          return { token, gitToken };
        }
        case "revokePanelToken": {
          const [panelId] = args as [string];
          tm.revokeToken(panelId);
          deps.fsService.unregisterCallerContext(panelId);
          deps.codeIdentityResolver?.unregisterCaller(panelId);
          deps.gitServer.revokeTokenForPanel(panelId);
          return;
        }
        case "updatePanelContext": {
          const [panelId, contextId] = args as [string, string];
          deps.fsService.updateCallerContext(panelId, contextId);
          return;
        }
        case "updatePanelParent": {
          const [panelId, parentId] = args as [string, string | null];
          tm.setPanelParent(panelId, parentId);
          return;
        }
        case "rotateAdmin": {
          const newToken = randomBytes(32).toString("hex");
          // Order: persist first, then swap. If persistence fails we never
          // invalidate the existing token — the caller retries.
          if (deps.persistAdminToken) {
            try {
              deps.persistAdminToken(newToken);
            } catch (err) {
              throw new Error(
                `Failed to persist new admin token: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          tm.setAdminToken(newToken);
          return newToken;
        }
        default: throw new Error(`Unknown tokens method: ${method}`);
      }
    },
  };
}
