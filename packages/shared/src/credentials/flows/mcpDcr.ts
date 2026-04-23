import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { oauthErrorHtml, oauthSuccessHtml } from "../../oauthPage.js";
import type { AccountIdentity, Credential, FlowConfig } from "../types.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const CALLBACK_REGISTRATION_URI = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface ProtectedResourceMetadata {
  authorization_server?: unknown;
  authorization_servers?: unknown;
}

interface AuthorizationServerMetadata {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
}

interface DynamicClientRegistrationResponse {
  client_id?: unknown;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  scope?: unknown;
  scopes?: unknown;
}

interface AuthorizationCallbackResult {
  code: string;
  redirectUri: string;
}

function getProviderId(config: FlowConfig, resourceUrl: URL): string {
  const providerId = (config as FlowConfig & { providerId?: unknown }).providerId;

  if (typeof providerId === "string" && providerId.trim().length > 0) {
    return providerId.trim();
  }

  return resourceUrl.hostname || config.type;
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const normalized = getString(entry);
      return normalized ? [normalized] : [];
    });
  }

  const normalized = getString(value);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function appendWellKnown(base: string, path: string): string {
  const url = new URL(base);
  url.search = "";
  url.hash = "";

  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return new URL(`.well-known/${path}`, url).toString();
}

async function parseObjectResponse(response: Response): Promise<Record<string, unknown> | null> {
  const raw = await response.text();

  if (raw.trim().length === 0) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const parsed = new URLSearchParams(raw);
    return Object.fromEntries(parsed.entries());
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    return null;
  }

  return parseObjectResponse(response);
}

function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");

  const payloadPart = parts[1];
  if (!payloadPart) {
    return null;
  }

  try {
    const payload = Buffer.from(payloadPart, "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildAccountIdentity(tokenResponse: TokenResponse, resourceUrl: URL): AccountIdentity {
  const idToken = getString(tokenResponse.id_token);
  const idTokenPayload = idToken ? decodeJwtPayload(idToken) : null;

  const email = getString(idTokenPayload?.["email"]);
  const username =
    getString(idTokenPayload?.["preferred_username"]) ??
    getString(idTokenPayload?.["username"]) ??
    getString(idTokenPayload?.["name"]);
  const workspaceName =
    getString(idTokenPayload?.["workspace_name"]) ??
    getString(idTokenPayload?.["tenant_name"]) ??
    resourceUrl.hostname;
  const providerUserId =
    getString(idTokenPayload?.["sub"]) ??
    getString(idTokenPayload?.["uid"]) ??
    resourceUrl.hostname ??
    "mcp-user";

  return {
    providerUserId,
    email: email ?? undefined,
    username: username ?? undefined,
    workspaceName: workspaceName ?? undefined,
  };
}

function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let command = "xdg-open";
    let args = [url];

    if (process.platform === "darwin") {
      command = "open";
    } else if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    }

    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });

      child.once("error", () => {
        resolve(false);
      });

      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function waitForAuthorizationCallback(state: string): Promise<AuthorizationCallbackResult | null> {
  const server = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, CALLBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();

    if (!address || typeof address === "string") {
      await closeServer(server);
      return null;
    }

    const redirectUri = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;

    const callbackResult = new Promise<AuthorizationCallbackResult | null>((resolve) => {
      const timeout = setTimeout(() => {
        void closeServer(server).finally(() => {
          resolve(null);
        });
      }, CALLBACK_TIMEOUT_MS);

      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", `http://${CALLBACK_HOST}:${address.port}`);

        if (url.pathname !== CALLBACK_PATH) {
          response.statusCode = 404;
          response.end("Not found");
          return;
        }

        const returnedState = getString(url.searchParams.get("state"));
        const code = getString(url.searchParams.get("code"));
        const error = getString(url.searchParams.get("error"));
        const errorDescription = getString(url.searchParams.get("error_description"));

        clearTimeout(timeout);

        if (error) {
          response.statusCode = 400;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(oauthErrorHtml("Authorization failed.", errorDescription ?? error));
          void closeServer(server).finally(() => {
            resolve(null);
          });
          return;
        }

        if (!code || returnedState !== state) {
          response.statusCode = 400;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(oauthErrorHtml("Authorization callback was invalid."));
          void closeServer(server).finally(() => {
            resolve(null);
          });
          return;
        }

        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(oauthSuccessHtml("Authentication complete. You can close this window."));
        void closeServer(server).finally(() => {
          resolve({ code, redirectUri });
        });
      });
    });

    return callbackResult;
  } catch {
    await closeServer(server);
    return null;
  }
}

export async function mcpDcr(config: FlowConfig): Promise<Credential | null> {
  try {
    const resource = getString(config.resource);

    if (!resource) {
      return null;
    }

    const resourceUrl = new URL(resource);
    const providerId = getProviderId(config, resourceUrl);

    const protectedResourceMetadata = (await fetchJson(
      appendWellKnown(resource, "oauth-protected-resource"),
    )) as ProtectedResourceMetadata | null;

    const authorizationServer =
      getString(protectedResourceMetadata?.authorization_server) ??
      getStringArray(protectedResourceMetadata?.authorization_servers)[0] ??
      null;

    if (!authorizationServer) {
      return null;
    }

    const authorizationServerMetadata = (await fetchJson(
      appendWellKnown(authorizationServer, "oauth-authorization-server"),
    )) as AuthorizationServerMetadata | null;

    const authorizationEndpoint = getString(authorizationServerMetadata?.authorization_endpoint);
    const tokenEndpoint = getString(authorizationServerMetadata?.token_endpoint);

    if (!authorizationEndpoint || !tokenEndpoint) {
      return null;
    }

    let clientId = getString(config.clientId);

    if (!clientId) {
      const registrationEndpoint = getString(authorizationServerMetadata?.registration_endpoint);

      if (!registrationEndpoint) {
        return null;
      }

      const registrationResponse = (await fetchJson(registrationEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_name: "natstack",
          redirect_uris: [CALLBACK_REGISTRATION_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })) as DynamicClientRegistrationResponse | null;

      clientId = getString(registrationResponse?.client_id);

      if (!clientId) {
        return null;
      }
    }

    const state = randomBytes(16).toString("base64url");
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    const server = createServer();

    const callback = await new Promise<AuthorizationCallbackResult | null>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, CALLBACK_HOST, () => {
        server.off("error", reject);

        const address = server.address();

        if (!address || typeof address === "string") {
          void closeServer(server).finally(() => {
            resolve(null);
          });
          return;
        }

        const redirectUri = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;
        const authorizationUrl = new URL(authorizationEndpoint);

        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("client_id", clientId);
        authorizationUrl.searchParams.set("redirect_uri", redirectUri);
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.set("code_challenge", codeChallenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        authorizationUrl.searchParams.set("resource", resource);

        const timeout = setTimeout(() => {
          void closeServer(server).finally(() => {
            resolve(null);
          });
        }, CALLBACK_TIMEOUT_MS);

        server.on("request", (request, response) => {
          const url = new URL(request.url ?? "/", `http://${CALLBACK_HOST}:${address.port}`);

          if (url.pathname !== CALLBACK_PATH) {
            response.statusCode = 404;
            response.end("Not found");
            return;
          }

          clearTimeout(timeout);

          const returnedState = getString(url.searchParams.get("state"));
          const code = getString(url.searchParams.get("code"));
          const error = getString(url.searchParams.get("error"));
          const errorDescription = getString(url.searchParams.get("error_description"));

          if (error) {
            response.statusCode = 400;
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(oauthErrorHtml("Authorization failed.", errorDescription ?? error));
            void closeServer(server).finally(() => {
              resolve(null);
            });
            return;
          }

          if (!code || returnedState !== state) {
            response.statusCode = 400;
            response.setHeader("content-type", "text/html; charset=utf-8");
            response.end(oauthErrorHtml("Authorization callback was invalid."));
            void closeServer(server).finally(() => {
              resolve(null);
            });
            return;
          }

          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(oauthSuccessHtml("Authentication complete. You can close this window."));
          void closeServer(server).finally(() => {
            resolve({ code, redirectUri });
          });
        });

        void openBrowser(authorizationUrl.toString()).then((opened) => {
          if (!opened) {
            clearTimeout(timeout);
            void closeServer(server).finally(() => {
              resolve(null);
            });
          }
        });
      });
    });

    if (!callback) {
      return null;
    }

    const tokenResponse = (await fetchJson(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code,
        redirect_uri: callback.redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString(),
    })) as TokenResponse | null;

    const accessToken = getString(tokenResponse?.access_token);

    if (!accessToken) {
      return null;
    }

    const refreshToken = getString(tokenResponse?.refresh_token) ?? undefined;
    const expiresIn = getPositiveNumber(tokenResponse?.expires_in);
    const scopes = [
      ...new Set([
        ...getStringArray(tokenResponse?.scope),
        ...getStringArray(tokenResponse?.scopes),
      ]),
    ];

    return {
      providerId,
      connectionId: randomUUID(),
      connectionLabel: `MCP ${resourceUrl.hostname}`,
      accountIdentity: buildAccountIdentity(tokenResponse ?? {}, resourceUrl),
      accessToken,
      refreshToken,
      scopes,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    };
  } catch {
    return null;
  }
}
