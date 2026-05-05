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
  oauth1ConsumerSecret?: string;
  oauth1TokenSecret?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  sshPrivateKey?: string;
  sshPublicKey?: string;
  cookieHeader?: string;
  cookieSession?: CookieSessionMaterial;
  samlAssertion?: string;
  scopes: string[];
  expiresAt?: number;
  metadata?: Record<string, string>;
}

export interface CookieSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
  partitionKey?: string;
}

export interface CookieSessionMaterial {
  origins: string[];
  cookies: CookieSessionCookie[];
}

export type CredentialBindingUse = "fetch" | "git-http" | "git-ssh";

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
    type: "bearer-token" | "api-key" | "oauth1-token" | "cookie-session" | "saml-session" | "aws-sigv4" | "ssh-key";
    token: string;
  };
  accountIdentity?: Partial<AccountIdentity>;
  scopes?: string[];
  expiresAt?: number;
  metadata?: Record<string, string>;
}

export type CredentialFlowType =
  | "oauth2-auth-code-pkce"
  | "oauth2-auth-code"
  | "oauth2-device-code"
  | "oauth2-client-credentials"
  | "oauth1a"
  | "api-key"
  | "aws-sigv4"
  | "ssh-key"
  | "oauth2-jwt-bearer"
  | "oauth2-token-exchange"
  | "browser-cookie-session"
  | "saml-browser-session";

export interface OAuthInlineClientSpec {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  allowMissingExpiry?: boolean;
  persistRefreshToken?: boolean;
  accountValidation?: OAuthAccountValidationSpec;
  revocationUrl?: string;
}

export interface OAuthStoredClientSpec {
  clientConfigId: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  allowMissingExpiry?: boolean;
  persistRefreshToken?: boolean;
  accountValidation?: OAuthAccountValidationSpec;
  revocationUrl?: string;
}

export type OAuthTokenAuthMethod = "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";

export interface OAuth2AuthCodePkceFlowSpec {
  type: "oauth2-auth-code-pkce";
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientConfigId?: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  allowMissingExpiry?: boolean;
  persistRefreshToken?: boolean;
  accountValidation?: OAuthAccountValidationSpec;
  tokenAuth?: OAuthTokenAuthMethod;
  revocationUrl?: string;
}

export interface OAuth2AuthCodeFlowSpec {
  type: "oauth2-auth-code";
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientConfigId?: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  tokenAuth?: OAuthTokenAuthMethod;
  persistRefreshToken?: boolean;
  accountValidation?: OAuthAccountValidationSpec;
  revocationUrl?: string;
  pkce: false;
  compatibilityReason: string;
  requiresConfidentialClient?: boolean;
}

export interface OAuth2DeviceCodeFlowSpec {
  type: "oauth2-device-code";
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientConfigId?: string;
  scopes?: string[];
  tokenAuth?: OAuthTokenAuthMethod;
  pollIntervalSeconds?: number;
  expiresInSeconds?: number;
  accountValidation?: OAuthAccountValidationSpec;
  persistRefreshToken?: boolean;
  revocationUrl?: string;
}

export interface OAuth2ClientCredentialsFlowSpec {
  type: "oauth2-client-credentials";
  tokenUrl: string;
  clientConfigId: string;
  tokenAuth: Exclude<OAuthTokenAuthMethod, "none">;
  scopes?: string[];
  audienceParam?: string;
  resourceParam?: string;
  accountValidation?: OAuthAccountValidationSpec;
  revocationUrl?: string;
}

export interface OAuth2JwtBearerFlowSpec {
  type: "oauth2-jwt-bearer";
  tokenUrl: string;
  clientConfigId: string;
  issuer?: string;
  subject?: string;
  audience?: string;
  scopes?: string[];
  accountValidation?: OAuthAccountValidationSpec;
  persistRefreshToken?: boolean;
  revocationUrl?: string;
}

export interface OAuth2TokenExchangeFlowSpec {
  type: "oauth2-token-exchange";
  tokenUrl: string;
  clientConfigId: string;
  subjectCredentialId: string;
  subjectTokenType?: "access_token" | "jwt";
  requestedTokenType?: string;
  scopes?: string[];
  audience?: string;
  resource?: string;
  tokenAuth?: Exclude<OAuthTokenAuthMethod, "none">;
  accountValidation?: OAuthAccountValidationSpec;
  persistRefreshToken?: boolean;
  revocationUrl?: string;
}

export interface OAuth1aFlowSpec {
  type: "oauth1a";
  requestTokenUrl: string;
  authorizeUrl: string;
  accessTokenUrl: string;
  clientConfigId: string;
  callbackConfirmedParam?: string;
  signatureMethod?: "HMAC-SHA1";
  accountValidation?: AccountValidationSpec;
}

export interface ApiKeyFlowSpec {
  type: "api-key";
  title?: string;
  description?: string;
  fields: ClientConfigFieldRequest[];
  materialTemplate: {
    type: "bearer-token" | "api-key";
    valueTemplate: string;
  };
  accountValidation?: "http-probe" | "none";
}

export interface AwsSigV4FlowSpec {
  type: "aws-sigv4";
  title?: string;
  description?: string;
  accountValidation?: "http-probe" | "none";
}

export interface SshKeyFlowSpec {
  type: "ssh-key";
  mode?: "generate" | "import";
  algorithm?: "ed25519";
  title?: string;
  description?: string;
  accountValidation?: "none";
}

export interface BrowserCookieSessionFlowSpec {
  type: "browser-cookie-session";
  signInUrl: string;
  capture: {
    cookies: string[];
    origins: string[];
  };
  completionUrlPattern?: string;
  accountValidation?: "http-probe" | "none";
  maxTtlSeconds?: number;
}

export interface SamlBrowserSessionFlowSpec {
  type: "saml-browser-session";
  signInUrl: string;
  spAudience: string;
  capture: {
    cookies?: string[];
    assertion?: {
      issuer: string;
      audience: string;
      recipient: string;
      persistAssertion?: boolean;
    };
  };
  completionUrlPattern?: string;
  maxTtlSeconds?: number;
  accountValidation?: "saml-assertion-claims" | "http-probe" | "none";
}

export type CredentialFlowSpec =
  | OAuth2AuthCodePkceFlowSpec
  | OAuth2AuthCodeFlowSpec
  | OAuth2DeviceCodeFlowSpec
  | OAuth2ClientCredentialsFlowSpec
  | OAuth2JwtBearerFlowSpec
  | OAuth2TokenExchangeFlowSpec
  | OAuth1aFlowSpec
  | ApiKeyFlowSpec
  | AwsSigV4FlowSpec
  | SshKeyFlowSpec
  | BrowserCookieSessionFlowSpec
  | SamlBrowserSessionFlowSpec;

export type AccountValidationSpec =
  | "none"
  | "oauth2-userinfo"
  | "oauth2-introspection"
  | "http-probe"
  | "saml-assertion-claims"
  | "jwt-claims";

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

export interface ConnectCredentialRequest {
  flow: CredentialFlowSpec;
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

export interface ConnectCredentialEnvelope {
  spec: ConnectCredentialRequest;
  handoffTarget: {
    callerId: string;
    callerKind: "panel" | "shell";
  };
}

export interface ForwardOAuthCallbackRequest {
  transactionId?: string;
  url?: string;
  code?: string;
  state?: string;
}

export type ClientConfigFieldType = "text" | "secret";

export interface ClientConfigFieldRequest {
  name: string;
  label: string;
  type: ClientConfigFieldType;
  required?: boolean;
  description?: string;
}

export interface ClientConfigFieldStatus {
  configured: boolean;
  type: ClientConfigFieldType;
  updatedAt?: number;
}

export interface ClientConfigStatus {
  configId: string;
  configured: boolean;
  authorizeUrl?: string;
  tokenUrl?: string;
  status?: "active" | "disabled" | "deleted";
  flowTypes?: CredentialFlowType[];
  fields: Record<string, ClientConfigFieldStatus>;
  updatedAt?: number;
}

export interface ConfigureClientRequest {
  configId: string;
  title: string;
  description?: string;
  authorizeUrl: string;
  tokenUrl: string;
  fields: ClientConfigFieldRequest[];
  flowTypes?: CredentialFlowType[];
  status?: "active" | "disabled";
  allowRefreshWhenDisabled?: boolean;
}

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
   * field. Use client config for multi-field provider setup material.
   */
  fields: ClientConfigFieldRequest[];
  material: {
    type: "bearer-token" | "api-key";
    tokenField: string;
  };
}

export interface GetClientConfigStatusRequest {
  configId: string;
  fields?: ClientConfigFieldRequest[];
}

export interface DeleteClientConfigRequest {
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
  | ClientConfigAuditEvent
  | OAuthConnectionTransactionAuditEvent;

export interface ConnectionCredentialAuditEvent {
  type:
    | "connection_credential.created"
    | "connection_credential.replaced"
    | "connection_credential.revoked"
    | "connection_credential.revocation_failed";
  ts: number;
  callerId: string;
  providerId: string;
  connectionId: string;
  storageKind: "connection-credential";
  fieldNames: string[];
}

export interface ClientConfigAuditEvent {
  type: "client_config.updated" | "client_config.revoked";
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
  | "handoff_requested"
  | "waiting_for_user"
  | "browser_open_requested"
  | "callback_received"
  | "polling"
  | "exchanging"
  | "validating_account"
  | "capturing_material"
  | "stored"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type OAuthConnectionErrorCode =
  | "unsupported_flow"
  | "invalid_connection_spec"
  | "approval_denied"
  | "browser_unavailable"
  | "unsupported_browser_mode"
  | "callback_timeout"
  | "state_mismatch"
  | "redirect_mismatch"
  | "token_exchange_failed"
  | "invalid_token_response"
  | "unsupported_token_auth_method"
  | "account_validation_failed"
  | "transaction_replayed"
  | "transaction_expired"
  | "client_config_unavailable"
  | "client_not_authorized"
  | "device_authorization_failed"
  | "device_code_expired"
  | "oauth1_signature_failed"
  | "session_capture_failed"
  | "saml_assertion_failed"
  | "unsupported_account_validation"
  | "unsupported_injection"
  | "ambiguous_credential"
  | "credential_conflict"
  | "credential_expired_reauth_required"
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
