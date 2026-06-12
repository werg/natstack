import { randomBytes } from "node:crypto";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { tokensMethods } from "@natstack/shared/serviceSchemas/tokens";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";

export function createTokensService(deps: {
  tokenManager: TokenManager;
  /** @deprecated Panel token side effects were removed. */
  fsService?: unknown;
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
    description: "Token management for non-panel bearers and admin token rotation",
    policy: { allowed: ["server", "shell"] },
    methods: tokensMethods,
    handler: async (ctx, method, args) => {
      const tm = deps.tokenManager;
      switch (method) {
        case "create":
          return tm.createToken(args[0] as string, args[1] as CallerKind);
        case "ensure":
          return tm.ensureToken(args[0] as string, args[1] as CallerKind);
        case "revoke":
          tm.revokeToken(args[0] as string);
          return;
        case "get":
          try {
            return tm.getToken(args[0] as string);
          } catch {
            return null;
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
                `Failed to persist new admin token: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          tm.setAdminToken(newToken);
          return newToken;
        }
        default:
          throw new Error(`Unknown tokens method: ${method}`);
      }
    },
  };
}
