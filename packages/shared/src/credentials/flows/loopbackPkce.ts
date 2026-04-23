import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FlowRunner } from '../resolver.js';
import type { AccountIdentity, Credential, FlowConfig } from '../types.js';

interface LoopbackPkceRunnerDeps {
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
}

interface CallbackResult {
  code: string;
}

type JsonRecord = Record<string, unknown>;

export function createLoopbackPkceRunner(deps: LoopbackPkceRunnerDeps = {}): FlowRunner {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const openUrl = deps.openUrl ?? openAuthorizationUrl;

  return async function loopbackPkceRunner(config: FlowConfig): Promise<Credential | null> {
    if (!config.authorizeUrl || !config.tokenUrl || !config.clientId) {
      return null;
    }

    const state = randomBytes(16).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    let server: Server | undefined;

    try {
      const listener = await createLoopbackListener(state);
      server = listener.server;

      const authorizationUrl = new URL(config.authorizeUrl);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('client_id', config.clientId);
      authorizationUrl.searchParams.set('redirect_uri', listener.redirectUri);
      authorizationUrl.searchParams.set('code_challenge', codeChallenge);
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
      authorizationUrl.searchParams.set('state', state);

      await openUrl(authorizationUrl.toString());

      const callback = await listener.waitForCallback;
      const tokenResponse = await exchangeAuthorizationCode(fetchImpl, config, {
        code: callback.code,
        codeVerifier,
        redirectUri: listener.redirectUri,
      });

      if (!tokenResponse) {
        return null;
      }

      return buildCredential(config, tokenResponse);
    } catch {
      return null;
    } finally {
      if (server) {
        await closeServer(server);
      }
    }
  };
}

export const loopbackPkce: FlowRunner = createLoopbackPkceRunner();

async function createLoopbackListener(state: string): Promise<{
  redirectUri: string;
  server: Server;
  waitForCallback: Promise<CallbackResult>;
}> {
  let settled = false;
  let resolveCallback: ((value: CallbackResult) => void) | undefined;
  let rejectCallback: ((reason?: unknown) => void) | undefined;

  const waitForCallback = new Promise<CallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
    const handleRequest = (): void => {
      try {
        const address = getServerAddress(server);
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${address.port}`);

        if (req.method !== 'GET' || url.pathname !== '/callback') {
          sendText(res, 404, 'Not found');
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          sendText(res, 400, 'Authentication failed. You can close this window.');

          if (!settled) {
            settled = true;
            rejectCallback?.(new Error(error));
          }
          return;
        }

        const code = url.searchParams.get('code');
        const actualState = url.searchParams.get('state');

        if (!code || actualState !== state) {
          sendText(res, 400, 'Invalid authentication response. You can close this window.');

          if (!settled) {
            settled = true;
            rejectCallback?.(new Error('Invalid OAuth callback'));
          }
          return;
        }

        sendText(res, 200, 'Authentication complete. You can close this window.');

        if (!settled) {
          settled = true;
          resolveCallback?.({ code });
        }
      } catch (error) {
        sendText(res, 500, 'Authentication failed. You can close this window.');

        if (!settled) {
          settled = true;
          rejectCallback?.(error);
        }
      }
    };

    handleRequest();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = getServerAddress(server);
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;

  return { redirectUri, server, waitForCallback };
}

async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  config: FlowConfig,
  params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<JsonRecord | null> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('redirect_uri', params.redirectUri);
  body.set('code_verifier', params.codeVerifier);

  if (config.clientId) {
    body.set('client_id', config.clientId);
  }

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }

  const response = await fetchImpl(config.tokenUrl!, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  return asRecord(payload);
}

function buildCredential(config: FlowConfig, tokenResponse: JsonRecord): Credential | null {
  const accessToken = firstString(tokenResponse.access_token, tokenResponse.accessToken);
  if (!accessToken) {
    return null;
  }

  const idToken = firstString(tokenResponse.id_token, tokenResponse.idToken);
  const claimSources = [
    asRecord(tokenResponse.accountIdentity),
    asRecord(tokenResponse.account_identity),
    asRecord(tokenResponse.account),
    asRecord(tokenResponse.user),
    decodeJwtClaims(idToken),
    decodeJwtClaims(accessToken),
  ].filter((value): value is JsonRecord => value !== null);

  const accountIdentity = buildAccountIdentity(claimSources);
  const providerId = deriveProviderId(config, tokenResponse, claimSources);
  const connectionId =
    firstString(tokenResponse.connectionId, tokenResponse.connection_id) ?? accountIdentity.providerUserId;
  const connectionLabel =
    firstString(tokenResponse.connectionLabel, tokenResponse.connection_label) ??
    accountIdentity.email ??
    accountIdentity.username ??
    accountIdentity.workspaceName ??
    providerId;

  return {
    providerId,
    connectionId,
    connectionLabel,
    accountIdentity,
    accessToken,
    refreshToken: firstString(tokenResponse.refresh_token, tokenResponse.refreshToken) ?? undefined,
    scopes: parseScopes(tokenResponse),
    expiresAt: parseExpiresAt(tokenResponse) ?? undefined,
  };
}

function buildAccountIdentity(claimSources: JsonRecord[]): AccountIdentity {
  const providerUserId =
    firstStringFromRecords(claimSources, ['providerUserId', 'provider_user_id', 'sub', 'id', 'user_id']) ??
    firstStringFromRecords(claimSources, ['email', 'username', 'preferred_username']) ??
    randomBytes(12).toString('hex');

  return {
    email: firstStringFromRecords(claimSources, ['email']) ?? undefined,
    username:
      firstStringFromRecords(claimSources, ['username', 'preferred_username', 'login', 'name']) ?? undefined,
    workspaceName:
      firstStringFromRecords(claimSources, ['workspaceName', 'workspace_name', 'tenant', 'org', 'organization']) ??
      undefined,
    providerUserId,
  };
}

function deriveProviderId(config: FlowConfig, tokenResponse: JsonRecord, claimSources: JsonRecord[]): string {
  return (
    normalizeProviderId(firstString(tokenResponse.providerId, tokenResponse.provider_id)) ??
    normalizeProviderId(firstStringFromRecords(claimSources, ['providerId', 'provider_id', 'iss', 'issuer'])) ??
    normalizeProviderId(config.resource) ??
    normalizeProviderId(config.authorizeUrl) ??
    normalizeProviderId(config.tokenUrl) ??
    'oauth'
  );
}

function normalizeProviderId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.hostname;
  } catch {
    const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
    return normalized.length > 0 ? normalized : null;
  }
}

function parseScopes(tokenResponse: JsonRecord): string[] {
  const scopeValue = tokenResponse.scope ?? tokenResponse.scopes;

  if (typeof scopeValue === 'string') {
    return scopeValue
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  if (Array.isArray(scopeValue)) {
    return scopeValue.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0);
  }

  return [];
}

function parseExpiresAt(tokenResponse: JsonRecord): number | null {
  const expiresAt = toNumber(tokenResponse.expires_at ?? tokenResponse.expiresAt);
  if (expiresAt !== null) {
    return expiresAt;
  }

  const expiresIn = toNumber(tokenResponse.expires_in ?? tokenResponse.expiresIn);
  if (expiresIn === null) {
    return null;
  }

  return Date.now() + expiresIn * 1000;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function firstStringFromRecords(records: JsonRecord[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = firstString(record[key]);
      if (value) {
        return value;
      }
    }
  }

  return null;
}

function decodeJwtClaims(token: string | null): JsonRecord | null {
  if (!token) {
    return null;
  }

  const segments = token.split('.');
  const payload = segments[1];

  if (!payload) {
    return null;
  }

  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function getServerAddress(server: Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Loopback server is not listening on a TCP port');
  }

  return address;
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function openAuthorizationUrl(url: string): Promise<void> {
  try {
    const openModule = await import('open');
    await openModule.default(url);
  } catch {
    console.warn(`Open this URL to continue authentication: ${url}`);
  }
}
