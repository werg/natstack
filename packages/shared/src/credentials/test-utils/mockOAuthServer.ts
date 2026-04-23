import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MockOAuthServerOpts {
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  failRefreshAfter?: number;
}

interface AuthorizationCodeRecord {
  codeChallenge: string;
  redirectUri: string;
}

interface TokenResponseBody {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

interface NormalizedMockOAuthServerOpts {
  code: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  failRefreshAfter?: number;
}

export class MockOAuthServer {
  readonly port: number;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;

  private readonly server: Server;
  private readonly expiresIn: number;
  private readonly failRefreshAfter?: number;
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly consumedCodes = new Set<string>();

  private tokenRequests = 0;
  private refreshRequests = 0;
  private currentCode: string;
  private currentAccessToken: string;
  private currentRefreshToken: string;

  private constructor(server: Server, opts: NormalizedMockOAuthServerOpts) {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Mock OAuth server is not listening on a TCP port');
    }

    this.server = server;
    this.port = address.port;
    this.authorizeUrl = `http://127.0.0.1:${this.port}/authorize`;
    this.tokenUrl = `http://127.0.0.1:${this.port}/token`;
    this.currentCode = opts.code;
    this.currentAccessToken = opts.accessToken;
    this.currentRefreshToken = opts.refreshToken;
    this.expiresIn = opts.expiresIn;
    this.failRefreshAfter = opts.failRefreshAfter;
  }

  static async start(opts: MockOAuthServerOpts = {}): Promise<MockOAuthServer> {
    const normalized = normalizeOptions(opts);
    let instance: MockOAuthServer | undefined;

    const server = createServer((req, res) => {
      if (!instance) {
        res.statusCode = 503;
        res.end('Mock OAuth server is starting');
        return;
      }

      void instance.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => {
        server.off('error', reject);
        resolve();
      });
    });

    instance = new MockOAuthServer(server, normalized);
    return instance;
  }

  get tokenRequestCount(): number {
    return this.tokenRequests;
  }

  get refreshRequestCount(): number {
    return this.refreshRequests;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private readonly handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

      if (method === 'GET' && url.pathname === '/authorize') {
        this.handleAuthorize(url, res);
        return;
      }

      if (method === 'POST' && url.pathname === '/token') {
        await this.handleToken(req, res);
        return;
      }

      this.sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.sendJson(res, 500, { error: 'server_error', error_description: message });
    }
  };

  private handleAuthorize(url: URL, res: ServerResponse): void {
    const redirectUri = url.searchParams.get('redirect_uri');
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');
    const state = url.searchParams.get('state');

    if (!redirectUri) {
      this.sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      });
      return;
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      this.sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'PKCE S256 challenge is required',
      });
      return;
    }

    this.authorizationCodes.set(this.currentCode, { codeChallenge, redirectUri });
    this.consumedCodes.delete(this.currentCode);

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', this.currentCode);
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    res.statusCode = 302;
    res.setHeader('location', redirectUrl.toString());
    res.end();
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.tokenRequests += 1;

    const form = new URLSearchParams(await readRequestBody(req));
    const grantType = form.get('grant_type');

    if (grantType === 'authorization_code') {
      this.handleAuthorizationCodeGrant(form, res);
      return;
    }

    if (grantType === 'refresh_token') {
      this.handleRefreshTokenGrant(form, res);
      return;
    }

    this.sendJson(res, 400, {
      error: 'unsupported_grant_type',
      error_description: 'Unsupported grant_type',
    });
  }

  private handleAuthorizationCodeGrant(form: URLSearchParams, res: ServerResponse): void {
    const code = form.get('code');
    const codeVerifier = form.get('code_verifier');
    const redirectUri = form.get('redirect_uri');

    if (!code || !codeVerifier || !redirectUri) {
      this.sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'code, code_verifier, and redirect_uri are required',
      });
      return;
    }

    const authorizationCode = this.authorizationCodes.get(code);
    if (!authorizationCode || code !== this.currentCode) {
      this.sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'Unknown authorization code',
      });
      return;
    }

    if (this.consumedCodes.has(code)) {
      this.sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'Authorization code has already been used',
      });
      return;
    }

    if (redirectUri !== authorizationCode.redirectUri) {
      this.sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'redirect_uri does not match the original authorization request',
      });
      return;
    }

    const actualChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (actualChallenge !== authorizationCode.codeChallenge) {
      this.sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'code_verifier does not match code_challenge',
      });
      return;
    }

    this.consumedCodes.add(code);
    this.sendJson(res, 200, this.buildTokenResponse());
  }

  private handleRefreshTokenGrant(form: URLSearchParams, res: ServerResponse): void {
    this.refreshRequests += 1;

    const refreshToken = form.get('refresh_token');
    if (!refreshToken) {
      this.sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      });
      return;
    }

    if (refreshToken !== this.currentRefreshToken) {
      this.sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'Unknown refresh token',
      });
      return;
    }

    if (
      this.failRefreshAfter !== undefined &&
      Number.isInteger(this.failRefreshAfter) &&
      this.refreshRequests > this.failRefreshAfter
    ) {
      this.sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'Configured refresh failure threshold reached',
      });
      return;
    }

    this.currentAccessToken = randomValue();
    this.currentRefreshToken = randomValue();
    this.sendJson(res, 200, this.buildTokenResponse());
  }

  private buildTokenResponse(): TokenResponseBody {
    return {
      access_token: this.currentAccessToken,
      refresh_token: this.currentRefreshToken,
      token_type: 'Bearer',
      expires_in: this.expiresIn,
    };
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }
}

function normalizeOptions(opts: MockOAuthServerOpts): NormalizedMockOAuthServerOpts {
  return {
    code: opts.code ?? randomValue(),
    accessToken: opts.accessToken ?? randomValue(),
    refreshToken: opts.refreshToken ?? randomValue(),
    expiresIn: opts.expiresIn ?? 3600,
    failRefreshAfter: opts.failRefreshAfter,
  };
}

function randomValue(): string {
  return randomBytes(18).toString('base64url');
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function runSelfTest(): Promise<void> {
  const server = await MockOAuthServer.start({
    code: 'test-code',
    accessToken: 'initial-access-token',
    refreshToken: 'initial-refresh-token',
    expiresIn: 1800,
    failRefreshAfter: 1,
  });

  try {
    const redirectUri = 'http://127.0.0.1/callback';
    const codeVerifier = 'test-code-verifier';
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const authorizeResponse = await fetch(
      `${server.authorizeUrl}?redirect_uri=${encodeURIComponent(redirectUri)}&state=abc123&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
    );
    assert.equal(authorizeResponse.status, 302);

    const redirectLocation = authorizeResponse.headers.get('location');
    assert.ok(redirectLocation);
    const redirected = new URL(redirectLocation);
    assert.equal(redirected.searchParams.get('code'), 'test-code');
    assert.equal(redirected.searchParams.get('state'), 'abc123');

    const badTokenResponse = await fetch(server.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: redirectUri,
        code_verifier: 'wrong-verifier',
      }),
    });
    assert.equal(badTokenResponse.status, 400);
    assert.deepEqual(await badTokenResponse.json(), {
      error: 'invalid_grant',
      error_description: 'code_verifier does not match code_challenge',
    });

    const tokenResponse = await fetch(server.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    assert.deepEqual(await tokenResponse.json(), {
      access_token: 'initial-access-token',
      refresh_token: 'initial-refresh-token',
      token_type: 'Bearer',
      expires_in: 1800,
    });
    assert.equal(server.tokenRequestCount, 2);
    assert.equal(server.refreshRequestCount, 0);

    const refreshResponse = await fetch(server.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'initial-refresh-token',
      }),
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = (await refreshResponse.json()) as TokenResponseBody;
    assert.equal(refreshed.token_type, 'Bearer');
    assert.equal(refreshed.expires_in, 1800);
    assert.notEqual(refreshed.access_token, 'initial-access-token');
    assert.notEqual(refreshed.refresh_token, 'initial-refresh-token');
    assert.equal(server.tokenRequestCount, 3);
    assert.equal(server.refreshRequestCount, 1);

    const failedRefresh = await fetch(server.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshed.refresh_token,
      }),
    });
    assert.equal(failedRefresh.status, 400);
    assert.deepEqual(await failedRefresh.json(), {
      error: 'invalid_grant',
      error_description: 'Configured refresh failure threshold reached',
    });
    assert.equal(server.tokenRequestCount, 4);
    assert.equal(server.refreshRequestCount, 2);
  } finally {
    await server.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSelfTest();
  process.stdout.write('mockOAuthServer self-test passed\n');
}
