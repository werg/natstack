/**
 * CapabilityBroker — unified egress authority.
 *
 * Mints short-lived capability tokens that carry:
 *   - session: attribution only (callerId). Session capabilities never grant
 *     credential authority; they only preserve caller identity for ordinary
 *     egress/audit.
 *   - provider: attribution + credential binding (callerId + providerId + connectionId).
 *
 * Capability tokens are *format-preserving*: the broker derives a token that
 * looks like the real credential (JWT passthrough, prefixed-opaque, or opaque)
 * so SDKs that format-validate API keys or parse JWT claims see valid bytes.
 *
 * The actual authenticating secret never leaves the server — only the shape +
 * 256 bits of random entropy do. The broker's in-memory map is the sole
 * authority at resolve time (no HMAC; map lookup on 256 random bits is
 * unforgeable).
 *
 * Resolve side: `resolveFromRequest` scans every known capability slot (any
 * header or query param used by any registered manifest's `authInjection`,
 * plus `Authorization`) for a token and returns the first live match.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type {
  CapabilityShape,
  Credential,
  ProviderManifest,
} from "../../../packages/shared/src/credentials/types.js";
import type { ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import type { ConsentGate } from "./consentGate.js";

const DEFAULT_PROVIDER_TTL_MS = 60 * 60 * 1000;       // 60 min
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;    // 8 h
const SWEEP_INTERVAL_MS = 60 * 1000;
const SESSION_CAPABILITY_PREFIX = "natstack_session_";
const OPAQUE_CAPABILITY_PREFIX = "natstack_cap_";

export type CapabilityKind = "session" | "provider";

export interface MintSessionRequest {
  callerId: string;
  ttlSeconds?: number;
}

export interface MintProviderRequest {
  callerId: string;
  provider: ProviderManifest;
  connectionId?: string;
  ttlSeconds?: number;
  signal?: AbortSignal;
}

export interface MintedCapability {
  token: string;
  capId: string;
  expiresAt: number;
  kind: CapabilityKind;
}

export interface ResolvedCapability {
  capId: string;
  token: string;
  callerId: string;
  kind: CapabilityKind;
  providerId?: string;
  connectionId?: string;
  provider?: ProviderManifest;
  grantEpoch?: number;
  credential?: Credential;
}

export interface CarrierLocation {
  kind: "header" | "query";
  name: string;
}

export interface MintError {
  statusCode: number;
  message: string;
  code?: string;
}

interface BrokerEntry {
  capId: string;
  token: string;
  callerId: string;
  kind: CapabilityKind;
  providerId?: string;
  connectionId?: string;
  provider?: ProviderManifest;
  grantEpoch?: number;
  expiresAt: number;
}

export interface CapabilityBrokerCredentialStore {
  load(providerId: string, connectionId: string): Promise<Credential | null> | Credential | null;
  list(providerId?: string): Promise<Credential[]> | Credential[];
}

export interface CapabilityBrokerDeps {
  credentialStore: CapabilityBrokerCredentialStore;
  consentGate: ConsentGate;
  resolveIdentity: (callerId: string) => ResolvedCodeIdentity | null;
}

export class CapabilityBroker {
  private readonly byToken = new Map<string, BrokerEntry>();
  private readonly byCapId = new Map<string, BrokerEntry>();
  private readonly grantEpochByKey = new Map<string, number>();
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private knownSlotsCache: CarrierLocation[] | null = null;
  private knownSlotsCacheSize = -1;

  constructor(private readonly deps: CapabilityBrokerDeps) {
    this.sweepHandle = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepHandle.unref === "function") this.sweepHandle.unref();
  }

  stop(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  async mintSession(req: MintSessionRequest): Promise<MintedCapability | { error: MintError }> {
    const identity = this.deps.resolveIdentity(req.callerId);
    if (!identity) {
      return { error: { statusCode: 403, message: `Unknown caller: ${req.callerId}` } };
    }
    const ttlMs = req.ttlSeconds !== undefined ? req.ttlSeconds * 1000 : DEFAULT_SESSION_TTL_MS;
    const capId = randomUUID();
    const token = `${SESSION_CAPABILITY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const entry: BrokerEntry = {
      capId,
      token,
      callerId: req.callerId,
      kind: "session",
      expiresAt: Date.now() + ttlMs,
    };
    this.store(entry);
    return { token, capId, expiresAt: entry.expiresAt, kind: "session" };
  }

  async mintProvider(
    req: MintProviderRequest,
  ): Promise<MintedCapability | { error: MintError }> {
    const identity = this.deps.resolveIdentity(req.callerId);
    if (!identity) {
      return { error: { statusCode: 403, message: `Unknown caller: ${req.callerId}` } };
    }
    const manifest = req.provider;

    const gateResult = await this.deps.consentGate.ensureGrant({
      identity,
      provider: manifest,
      connectionIdOverride: req.connectionId ?? null,
      signal: req.signal,
    });
    if ("error" in gateResult) {
      return { error: gateResult.error };
    }

    const { credential, grant } = gateResult;
    const shape = detectShape(credential, manifest);
    const token = mintTokenForShape(shape, credential.accessToken);

    const ttlMs = req.ttlSeconds !== undefined ? req.ttlSeconds * 1000 : DEFAULT_PROVIDER_TTL_MS;
    const capId = randomUUID();
    const grantKey = grantEpochKey(manifest.id, grant.connectionId);
    const grantEpoch = this.grantEpochByKey.get(grantKey) ?? 0;
    const entry: BrokerEntry = {
      capId,
      token,
      callerId: req.callerId,
      kind: "provider",
      providerId: manifest.id,
      connectionId: grant.connectionId,
      provider: manifest,
      grantEpoch,
      expiresAt: Date.now() + ttlMs,
    };
    this.store(entry);
    return { token, capId, expiresAt: entry.expiresAt, kind: "provider" };
  }

  async metadata(params: {
    callerId: string;
    provider: ProviderManifest;
    connectionId?: string;
  }): Promise<{
    connectionId: string;
    accountIdentity: Credential["accountIdentity"];
    claims?: Record<string, unknown>;
    expiresAt?: number;
  } | { error: MintError }> {
    const identity = this.deps.resolveIdentity(params.callerId);
    if (!identity) {
      return { error: { statusCode: 403, message: `Unknown caller: ${params.callerId}` } };
    }
    const manifest = params.provider;
    const gateResult = await this.deps.consentGate.ensureGrant({
      identity,
      provider: manifest,
      connectionIdOverride: params.connectionId ?? null,
    });
    if ("error" in gateResult) {
      return { error: gateResult.error };
    }
    const { credential } = gateResult;
    const claims = decodeJwtPayload(credential.accessToken) ?? undefined;
    return {
      connectionId: credential.connectionId,
      accountIdentity: credential.accountIdentity,
      claims,
      expiresAt: credential.expiresAt,
    };
  }

  resolve(token: string): ResolvedCapability | null {
    const entry = this.byToken.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.drop(entry);
      return null;
    }
    if (entry.kind === "provider" && entry.providerId && entry.connectionId) {
      const grantKey = grantEpochKey(entry.providerId, entry.connectionId);
      const currentEpoch = this.grantEpochByKey.get(grantKey) ?? 0;
      if ((entry.grantEpoch ?? 0) < currentEpoch) {
        this.drop(entry);
        return null;
      }
    }
    return {
      capId: entry.capId,
      token: entry.token,
      callerId: entry.callerId,
      kind: entry.kind,
      providerId: entry.providerId,
      connectionId: entry.connectionId,
      provider: entry.provider,
      grantEpoch: entry.grantEpoch,
    };
  }

  /**
   * Scan known capability slots in the request and return the first live match.
   * A slot is any header or query param used by any registered manifest's
   * authInjection, plus Authorization as the universal default.
   */
  resolveFromRequest(
    headers: Record<string, string | string[] | undefined> | Headers,
    url?: string | URL,
  ): { entry: ResolvedCapability; carrier: CarrierLocation } | null {
    const slots = this.getKnownSlots();
    for (const slot of slots) {
      const candidate = this.readCarrier(headers, url, slot);
      if (!candidate) continue;
      for (const raw of candidate) {
        const stripped = stripBearer(raw);
        const hit = this.resolve(stripped);
        if (hit) return { entry: hit, carrier: slot };
      }
    }
    return null;
  }

  revokeById(capId: string): void {
    const entry = this.byCapId.get(capId);
    if (entry) this.drop(entry);
  }

  revokeFor(providerId: string, connectionId?: string): void {
    if (connectionId) {
      const key = grantEpochKey(providerId, connectionId);
      this.grantEpochByKey.set(key, (this.grantEpochByKey.get(key) ?? 0) + 1);
      return;
    }
    // Bump all connection epochs for this provider.
    for (const entry of this.byToken.values()) {
      if (entry.providerId === providerId && entry.connectionId) {
        const key = grantEpochKey(providerId, entry.connectionId);
        this.grantEpochByKey.set(key, (this.grantEpochByKey.get(key) ?? 0) + 1);
      }
    }
  }

  revokeCaller(callerId: string): void {
    for (const entry of Array.from(this.byToken.values())) {
      if (entry.callerId === callerId) this.drop(entry);
    }
  }

  private store(entry: BrokerEntry): void {
    this.byToken.set(entry.token, entry);
    this.byCapId.set(entry.capId, entry);
  }

  private drop(entry: BrokerEntry): void {
    this.byToken.delete(entry.token);
    this.byCapId.delete(entry.capId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const entry of Array.from(this.byToken.values())) {
      if (entry.expiresAt < now) this.drop(entry);
    }
  }

  private getKnownSlots(): CarrierLocation[] {
    const dynamicProviders = Array.from(this.byToken.values())
      .map((entry) => entry.provider)
      .filter((provider): provider is ProviderManifest => !!provider);
    const cacheSize = dynamicProviders.length;
    if (this.knownSlotsCache && this.knownSlotsCacheSize === cacheSize) {
      return this.knownSlotsCache;
    }
    const slots = new Map<string, CarrierLocation>();
    slots.set("header:authorization", { kind: "header", name: "authorization" });
    for (const manifest of dynamicProviders) {
      const injection = manifest.authInjection;
      if (!injection) continue;
      if (injection.type === "header" && injection.headerName) {
        const name = injection.headerName.toLowerCase();
        slots.set(`header:${name}`, { kind: "header", name });
      } else if (injection.type === "query-param" && injection.paramName) {
        slots.set(`query:${injection.paramName}`, { kind: "query", name: injection.paramName });
      }
      for (const strip of injection.stripHeaders ?? []) {
        const name = strip.toLowerCase();
        slots.set(`header:${name}`, { kind: "header", name });
      }
    }
    this.knownSlotsCache = Array.from(slots.values());
    this.knownSlotsCacheSize = cacheSize;
    return this.knownSlotsCache;
  }

  private readCarrier(
    headers: Record<string, string | string[] | undefined> | Headers,
    url: string | URL | undefined,
    slot: CarrierLocation,
  ): string[] | null {
    if (slot.kind === "header") {
      return readHeaderValues(headers, slot.name);
    }
    if (!url) return null;
    try {
      const parsed = typeof url === "string" ? new URL(url) : url;
      const value = parsed.searchParams.get(slot.name);
      return value ? [value] : null;
    } catch {
      return null;
    }
  }
}

export function createCapabilityBroker(deps: CapabilityBrokerDeps): CapabilityBroker {
  return new CapabilityBroker(deps);
}

// ── Shape detection + token minting ─────────────────────────────────────────

export function detectShape(
  credential: Pick<Credential, "accessToken">,
  manifest: Pick<ProviderManifest, "capabilityShape">,
): CapabilityShape {
  if (manifest.capabilityShape) return manifest.capabilityShape;
  const token = credential.accessToken;
  if (looksLikeJwt(token)) return { kind: "jwt-passthrough" };
  const m = token.match(/^([a-zA-Z][\w-]{1,30}[_-])(.{8,})$/);
  if (m && m[1]) return { kind: "prefixed-opaque", prefix: m[1], bodyLength: 43 };
  return { kind: "opaque", totalLength: 48 };
}

export function mintTokenForShape(shape: CapabilityShape, sourceToken: string): string {
  if (shape.kind === "jwt-passthrough") {
    const parts = sourceToken.split(".");
    const header = parts[0] ?? "";
    const payload = parts[1] ?? "";
    const signature = randomBytes(32).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }
  if (shape.kind === "prefixed-opaque") {
    const bodyLength = shape.bodyLength ?? 43;
    return `${shape.prefix}${randomBytesBase64Url(bodyLengthToByteLength(bodyLength))}`;
  }
  // opaque
  const total = shape.totalLength ?? 48;
  const body = randomBytesBase64Url(bodyLengthToByteLength(Math.max(1, total - OPAQUE_CAPABILITY_PREFIX.length)));
  return `${OPAQUE_CAPABILITY_PREFIX}${body}`;
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [rawHeader, rawPayload] = parts;
  if (!rawHeader || !rawPayload) return false;
  try {
    const header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8")) as unknown;
    const payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8")) as unknown;
    return Boolean(header && typeof header === "object" && payload && typeof payload === "object");
  } catch {
    return false;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function randomBytesBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function bodyLengthToByteLength(base64UrlCharLength: number): number {
  return Math.max(16, Math.ceil((base64UrlCharLength * 3) / 4));
}

function grantEpochKey(providerId: string, connectionId: string): string {
  return `${providerId}\x00${connectionId}`;
}

function readHeaderValues(
  headers: Record<string, string | string[] | undefined> | Headers,
  name: string,
): string[] | null {
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value ? [value] : null;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (typeof value === "string") return [value];
  }
  return null;
}

function stripBearer(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) return trimmed.slice(7).trim();
  return trimmed;
}

export function isSessionCapability(token: string): boolean {
  return token.startsWith(SESSION_CAPABILITY_PREFIX);
}
