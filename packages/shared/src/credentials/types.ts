import type { CredentialInjection, UrlAudience } from "./urlAudience.js";

export type { CredentialInjection, UrlAudience } from "./urlAudience.js";

export interface Credential {
  id?: string;
  label?: string;
  owner?: CredentialOwner;
  bindings?: CredentialBinding[];
  grants?: CredentialUseGrant[];
  revokedAt?: number;
  providerId: "url-bound" | "passthrough" | string;
  connectionId: string;
  connectionLabel: string;
  accountIdentity: AccountIdentity;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: number;
  metadata?: Record<string, string>;
}

export type CredentialBindingUse = "fetch" | "git-http";

export interface CredentialBinding {
  id: string;
  use: CredentialBindingUse;
  audience: UrlAudience[];
  injection: CredentialInjection;
}

export interface CredentialOwner {
  userProfileId?: string;
  sourceId: string;
  sourceKind: "workspace" | "package" | "plugin" | "user";
  label: string;
}

export type CredentialGrantScope = "caller" | "version" | "repo";
export type CredentialGrantAction = "read" | "write" | "use";

export interface CredentialUseGrant {
  bindingId: string;
  use: CredentialBindingUse;
  resource: string;
  action: CredentialGrantAction;
  scope: CredentialGrantScope;
  callerId?: string;
  repoPath?: string;
  effectiveVersion?: string;
  grantedAt: number;
  grantedBy: string;
}

export interface AccountIdentity {
  email?: string;
  username?: string;
  workspaceName?: string;
  providerUserId: string;
}

export interface StoreUrlBoundCredentialRequest {
  label: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  bindings?: CredentialBinding[];
  material: {
    type: "bearer-token" | "api-key";
    token: string;
  };
  accountIdentity?: Partial<AccountIdentity>;
  scopes?: string[];
  expiresAt?: number;
  metadata?: Record<string, string>;
}

export interface OAuthInlineClientSpec {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  allowMissingExpiry?: boolean;
  persistRefreshToken?: boolean;
  accountValidation?: OAuthAccountValidationSpec;
}

export interface OAuthStoredClientSpec {
  clientConfigId: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  allowMissingExpiry?: boolean;
  persistRefreshToken?: boolean;
  accountValidation?: OAuthAccountValidationSpec;
}

export interface OAuthAccountValidationSpec {
  userinfo?: {
    url: string;
    idField?: string;
    emailField?: string;
    usernameField?: string;
    workspaceField?: string;
  };
}

export interface OAuthLoopbackRedirectStrategy {
  type?: "loopback" | "public" | "client-forwarded";
  host?: string;
  port?: number;
  callbackPath?: string;
  callbackUri?: string;
  fallback?: "dynamic-port";
}

export interface ConnectOAuthCredentialRequest {
  oauth: OAuthInlineClientSpec | OAuthStoredClientSpec;
  credential: {
    label: string;
    audience: UrlAudience[];
    injection: CredentialInjection;
    bindings?: CredentialBinding[];
    accountIdentity?: Partial<AccountIdentity>;
    scopes?: string[];
    metadata?: Record<string, string>;
  };
  redirect?: OAuthLoopbackRedirectStrategy;
  browser?: "external" | "internal";
}

export interface ForwardOAuthCallbackRequest {
  transactionId?: string;
  url?: string;
  code?: string;
  state?: string;
}

export type OAuthClientConfigFieldType = "text" | "secret";

export interface OAuthClientConfigFieldRequest {
  name: string;
  label: string;
  type: OAuthClientConfigFieldType;
  required?: boolean;
  description?: string;
}

export interface OAuthClientConfigFieldStatus {
  configured: boolean;
  type: OAuthClientConfigFieldType;
  updatedAt?: number;
}

export interface OAuthClientConfigStatus {
  configId: string;
  configured: boolean;
  authorizeUrl?: string;
  tokenUrl?: string;
  fields: Record<string, OAuthClientConfigFieldStatus>;
  updatedAt?: number;
}

export interface ConfigureOAuthClientRequest {
  configId: string;
  title: string;
  description?: string;
  authorizeUrl: string;
  tokenUrl: string;
  fields: OAuthClientConfigFieldRequest[];
}

/** @internal Pre-release alias retained only for server-internal tests. */
export type RequestOAuthClientConfigRequest = ConfigureOAuthClientRequest;

export interface RequestCredentialInputRequest {
  title: string;
  description?: string;
  credential: {
    label: string;
    audience: UrlAudience[];
    injection: CredentialInjection;
    bindings?: CredentialBinding[];
    accountIdentity?: Partial<AccountIdentity>;
    scopes?: string[];
    metadata?: Record<string, string>;
  };
  /**
   * Static credential input currently supports exactly one required secret
   * field. Use OAuth client config for multi-field provider setup material.
   */
  fields: OAuthClientConfigFieldRequest[];
  material: {
    type: "bearer-token" | "api-key";
    tokenField: string;
  };
}

export interface GetOAuthClientConfigStatusRequest {
  configId: string;
  fields?: OAuthClientConfigFieldRequest[];
}

export interface DeleteOAuthClientConfigRequest {
  configId: string;
}

export interface GrantUrlBoundCredentialRequest {
  credentialId: string;
  callerId: string;
  grantedBy?: string;
}

export interface ResolveUrlBoundCredentialRequest {
  url: string;
  credentialId?: string;
  use?: CredentialBindingUse;
}

export interface ProxyGitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  credentialId?: string;
}

export interface ProxyGitHttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

export interface StoredCredentialSummary {
  id: string;
  label: string;
  accountIdentity?: AccountIdentity;
  audience: UrlAudience[];
  injection: CredentialInjection;
  bindings?: CredentialBinding[];
  owner?: CredentialOwner;
  scopes: string[];
  expiresAt?: number;
  revokedAt?: number;
  metadata?: Record<string, string>;
}

export type CredentialAuditEvent =
  | AuditEntry
  | ConnectionCredentialAuditEvent
  | OAuthClientConfigAuditEvent
  | OAuthConnectionTransactionAuditEvent;

export interface ConnectionCredentialAuditEvent {
  type:
    | "connection_credential.created"
    | "connection_credential.replaced"
    | "connection_credential.revoked";
  ts: number;
  callerId: string;
  providerId: string;
  connectionId: string;
  storageKind: "connection-credential";
  fieldNames: string[];
}

export interface OAuthClientConfigAuditEvent {
  type: "oauth_client_config.updated" | "oauth_client_config.revoked";
  ts: number;
  callerId: string;
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  fieldNames: string[];
}

export interface OAuthConnectionTransactionAuditEvent {
  type: "oauth_connection_transaction.transition";
  ts: number;
  callerId: string;
  transactionId: string;
  from?: OAuthConnectionTransactionState;
  to: OAuthConnectionTransactionState;
  errorCode?: OAuthConnectionErrorCode;
}

export type OAuthConnectionTransactionState =
  | "created"
  | "approved"
  | "browser_open_requested"
  | "callback_received"
  | "exchanging"
  | "validating_account"
  | "stored"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type OAuthConnectionErrorCode =
  | "approval_denied"
  | "browser_unavailable"
  | "callback_timeout"
  | "state_mismatch"
  | "redirect_mismatch"
  | "token_exchange_failed"
  | "invalid_token_response"
  | "account_validation_failed"
  | "transaction_replayed"
  | "transaction_expired"
  | "client_not_authorized"
  | "redirect_unavailable";

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
  breakerState: "closed" | "open" | "half-open";
}

export interface IntegrationManifest {
  credentials?: Record<string, {
    label: string;
    audience: UrlAudience[];
    injection: CredentialInjection;
  }>;
  endpoints?: Record<string, EndpointDeclaration[]>;
}

export interface EndpointDeclaration {
  url: string;
  methods: string[] | "*";
}

export interface RetryConfig {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  idempotentOnly?: boolean;
}
