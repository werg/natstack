import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ProviderManifest, ConsentGrant, AuditEntry } from "../../../packages/shared/src/credentials/types.js";
import type { ProviderRegistry } from "../../../packages/shared/src/credentials/registry.js";
import type { CredentialStore } from "../../../packages/shared/src/credentials/store.js";
import { checkCapability } from "../../../packages/shared/src/credentials/capability.js";
import type { AuditLog } from "../../../packages/shared/src/credentials/audit.js";

interface EgressProxyDeps {
  credentialStore: CredentialStore;
  providerRegistry: ProviderRegistry;
  auditLog?: AuditLog;
}

interface WorkerAttribution {
  workerId: string;
  proxyAuth: string;
}

export class EgressProxy {
  readonly port: number;
  private readonly server: Server;
  private readonly deps: EgressProxyDeps;
  private readonly workerTokens = new Map<string, string>();

  private constructor(server: Server, port: number, deps: EgressProxyDeps) {
    this.server = server;
    this.port = port;
    this.deps = deps;
  }

  static async start(deps: EgressProxyDeps): Promise<EgressProxy> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to bind egress proxy"));
          return;
        }
        const proxy = new EgressProxy(server, addr.port, deps);
        server.on("request", (req, res) => {
          void proxy.handleRequest(req, res);
        });
        resolve(proxy);
      });
      server.on("error", reject);
    });
  }

  registerWorker(workerId: string, proxyAuthToken: string): void {
    this.workerTokens.set(proxyAuthToken, workerId);
  }

  unregisterWorker(proxyAuthToken: string): void {
    this.workerTokens.delete(proxyAuthToken);
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();

    const attribution = this.extractAttribution(req);
    const targetUrl = this.extractTargetUrl(req);

    if (!targetUrl) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing target URL" }));
      return;
    }

    const provider = this.matchProvider(targetUrl);

    if (provider && attribution) {
      const capResult = checkCapability(
        targetUrl.toString(),
        req.method ?? "GET",
        [],
      );
      if (capResult === "deny") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: "capability_violation",
          url: targetUrl.toString(),
          method: req.method,
          provider: provider.id,
        }));
        return;
      }
    }

    if (provider && attribution) {
      const credentials = await this.deps.credentialStore.list(provider.id);
      const credential = credentials[0];
      if (credential) {
        req.headers["authorization"] = `Bearer ${credential.accessToken}`;
      }
    }

    try {
      await this.forwardRequest(req, res, targetUrl);
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_error" }));
    }

    if (this.deps.auditLog && attribution) {
      const entry: AuditEntry = {
        ts: startTime,
        workerId: attribution.workerId,
        callerId: attribution.workerId,
        providerId: provider?.id ?? "unknown",
        connectionId: "",
        method: req.method ?? "GET",
        url: targetUrl.toString(),
        status: res.statusCode,
        durationMs: Date.now() - startTime,
        bytesIn: 0,
        bytesOut: 0,
        scopesUsed: [],
        retries: 0,
        breakerState: "closed",
      };
      void this.deps.auditLog.append(entry);
    }
  }

  private extractAttribution(req: IncomingMessage): WorkerAttribution | null {
    const workerId = req.headers["x-natstack-worker-id"];
    const proxyAuth = req.headers["x-natstack-proxy-auth"];
    if (typeof workerId !== "string" || typeof proxyAuth !== "string") {
      return null;
    }
    const knownWorkerId = this.workerTokens.get(proxyAuth);
    if (knownWorkerId !== workerId) {
      return null;
    }
    return { workerId, proxyAuth };
  }

  private extractTargetUrl(req: IncomingMessage): URL | null {
    const targetHeader = req.headers["x-natstack-target-url"];
    if (typeof targetHeader === "string") {
      try {
        return new URL(targetHeader);
      } catch {
        return null;
      }
    }

    const rawUrl = req.url;
    if (rawUrl && (rawUrl.startsWith("http://") || rawUrl.startsWith("https://"))) {
      try {
        return new URL(rawUrl);
      } catch {
        return null;
      }
    }

    return null;
  }

  private matchProvider(url: URL): ProviderManifest | null {
    const manifests = this.deps.providerRegistry.list();
    const origin = url.origin;
    for (const manifest of manifests) {
      for (const base of manifest.apiBase) {
        if (origin === base || origin.startsWith(base) || url.href.startsWith(base)) {
          return manifest;
        }
      }
    }
    return null;
  }

  private forwardRequest(
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    targetUrl: URL,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const isHttps = targetUrl.protocol === "https:";
      const requestFn = isHttps ? httpsRequest : httpRequest;

      const headers = { ...clientReq.headers };
      delete headers["x-natstack-worker-id"];
      delete headers["x-natstack-proxy-auth"];
      delete headers["x-natstack-target-url"];
      headers["host"] = targetUrl.host;

      const proxyReq = requestFn(
        targetUrl.toString(),
        {
          method: clientReq.method,
          headers,
        },
        (proxyRes) => {
          clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(clientRes);
          proxyRes.on("end", resolve);
        },
      );

      proxyReq.on("error", reject);
      clientReq.pipe(proxyReq);
    });
  }
}

export function createEgressProxy(deps: EgressProxyDeps): Promise<EgressProxy> {
  return EgressProxy.start(deps);
}
