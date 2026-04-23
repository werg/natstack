export interface ProviderManifest {
  id: string;
  displayName: string;
  clientId?: string;
  apiBase: string[];
  flows: FlowConfig[];
  authInjection?: AuthInjection;
  scopes?: Record<string, string>;
  scopeDescriptions?: Record<string, string>;
  rateLimits?: RateLimitConfig;
  retry?: RetryConfig;
  refreshBufferSeconds?: number;
  whoami?: {
    url: string;
    identityPath: {
      email?: string;
      username?: string;
      workspaceName?: string;
      providerUserId: string;
    };
  };
  webhooks?: {
    subscriptions?: WebhookSubscriptionConfig[];
  };
}

export interface AuthInjection {
  type: "header" | "query-param";
  headerName?: string;
  valueTemplate?: string;
  paramName?: string;
  stripHeaders?: string[];
}

export interface FlowConfig {
  type:
    | 'loopback-pkce'
    | 'device-code'
    | 'mcp-dcr'
    | 'pat'
    | 'cli-piggyback'
    | 'composio-bridge'
    | 'service-account'
    | 'bot-token'
    | 'github-app-installation'
    | "env-var";
  clientId?: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceAuthUrl?: string;
  command?: string;
  jsonPath?: string;
  probeUrl?: string;
  resource?: string;
  envVar?: string;
  extraAuthorizeParams?: Record<string, string>;
  fixedScope?: string;
  tokenMetadata?: Record<string, {
    source: "jwt-claim" | "response-field";
    path: string;
  }>;
}

export interface Credential {
  providerId: string;
  connectionId: string;
  connectionLabel: string;
  accountIdentity: AccountIdentity;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: number;
  metadata?: Record<string, string>;
}

export interface AccountIdentity {
  email?: string;
  username?: string;
  workspaceName?: string;
  providerUserId: string;
}

export interface CredentialHandle {
  connectionId: string;
  apiBase: string[];
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface ConsentGrant {
  codeIdentity: string;
  codeIdentityType: "repo" | "hash";
  providerId: string;
  connectionId: string;
  scopes: string[];
  grantedAt: number;
  grantedBy: string;
  transient?: boolean;
}

export interface RateLimitConfig {
  requestsPerSecond?: number;
  burstSize?: number;
  strategy?: 'delay' | 'fail-fast';
}

export interface RetryConfig {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  idempotentOnly?: boolean;
}

export interface AuditEntry {
  ts: number;
  workerId: string;
  callerId: string;
  providerId: string;
  connectionId: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  bytesIn: number;
  bytesOut: number;
  scopesUsed: string[];
  capabilityViolation?: string;
  retries: number;
  breakerState: 'closed' | 'open' | 'half-open';
}

export interface IntegrationManifest {
  providers: (string | { id: string; role: string })[];
  scopes: Record<string, string[]>;
  endpoints: Record<string, EndpointDeclaration[]>;
  webhooks?: Record<string, WebhookBinding[]>;
}

export interface EndpointDeclaration {
  url: string;
  methods: string[] | '*';
}

export interface WebhookBinding {
  event: string;
  deliver: string;
}

export interface WebhookSubscriptionConfig {
  event: string;
  delivery: 'https-post' | 'pubsub-push';
  verify?: string;
  watch?: {
    type: string;
    renewEveryHours?: number;
  };
}
