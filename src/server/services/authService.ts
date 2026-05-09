import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../rpcServiceWithRoutes.js";

const ExchangeBodySchema = z.object({
  callerId: z.string().min(1).max(256),
});

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function createAuthService(deps: { tokenManager: TokenManager }): ServiceWithRoutes {
  const definition: ServiceDefinition = {
    name: "auth",
    description: "Gateway authentication bootstrap routes",
    policy: { allowed: ["server", "shell"] },
    methods: {},
    handler: async () => {
      throw new Error("auth has no RPC methods");
    },
  };

  const routes: ServiceRouteDecl[] = [
    {
      serviceName: "auth",
      path: "/exchange-admin-for-shell",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        try {
          const body = ExchangeBodySchema.parse(await readJson(req));
          const token = deps.tokenManager.ensureToken(body.callerId, "shell");
          sendJson(res, 200, { token });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
        }
      },
    },
  ];

  return { definition, routes };
}
