import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallerKind as SharedCallerKind } from "../serviceDispatcher.js";

export type CallerKind = Extract<SharedCallerKind, "panel" | "worker" | "shell" | "server">;

export interface VerifiedAssertion {
  callerId: string;
  callerKind: CallerKind;
  audience: string;
  issuedAt: number;
  expiresAt?: number;
}

export type VerifyCallerAssertionError =
  | { error: "malformed" }
  | { error: "bad-signature" }
  | { error: "wrong-audience" }
  | { error: "expired" };

interface AssertionPayload {
  cid: string;
  ck: CallerKind;
  aud: string;
  iat: number;
  exp?: number;
}

const CALLER_KINDS = new Set<CallerKind>(["panel", "worker", "shell", "server"]);
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function hmac(secret: Buffer, payloadB64: string): Buffer {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parsePayload(payloadB64: string): AssertionPayload | null {
  if (!BASE64URL_RE.test(payloadB64)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null) return null;
    const record = decoded as Record<string, unknown>;
    if (typeof record["cid"] !== "string" || record["cid"].length === 0) return null;
    if (typeof record["ck"] !== "string" || !CALLER_KINDS.has(record["ck"] as CallerKind)) {
      return null;
    }
    if (typeof record["aud"] !== "string" || record["aud"].length === 0) return null;
    if (typeof record["iat"] !== "number" || !Number.isFinite(record["iat"])) return null;
    if (
      record["exp"] !== undefined &&
      (typeof record["exp"] !== "number" || !Number.isFinite(record["exp"]))
    ) {
      return null;
    }
    return {
      cid: record["cid"],
      ck: record["ck"] as CallerKind,
      aud: record["aud"],
      iat: record["iat"],
      ...(record["exp"] === undefined ? {} : { exp: record["exp"] as number }),
    };
  } catch {
    return null;
  }
}

function constantTimeBufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function mintCallerAssertion(
  secret: Buffer,
  args: { callerId: string; callerKind: CallerKind; audience: string; ttlMs?: number },
): string {
  const issuedAt = Date.now();
  const payload: AssertionPayload = {
    cid: args.callerId,
    ck: args.callerKind,
    aud: args.audience,
    iat: issuedAt,
    ...(args.ttlMs === undefined ? {} : { exp: issuedAt + args.ttlMs }),
  };
  const payloadB64 = base64urlJson(payload);
  return `${payloadB64}.${hmac(secret, payloadB64).toString("base64url")}`;
}

export function verifyCallerAssertion(
  secret: Buffer,
  token: string,
  expectedAudience: string,
  now = Date.now(),
): VerifiedAssertion | VerifyCallerAssertionError {
  const parts = token.split(".");
  if (parts.length !== 2) return { error: "malformed" };
  const [payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) return { error: "malformed" };
  if (!BASE64URL_RE.test(payloadB64) || !BASE64URL_RE.test(signatureB64)) {
    return { error: "malformed" };
  }

  const payload = parsePayload(payloadB64);
  if (!payload) return { error: "malformed" };

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, "base64url");
  } catch {
    return { error: "malformed" };
  }

  if (!constantTimeBufferEqual(signature, hmac(secret, payloadB64))) {
    return { error: "bad-signature" };
  }
  if (payload.aud !== expectedAudience) return { error: "wrong-audience" };
  if (payload.exp !== undefined && now > payload.exp) return { error: "expired" };

  return {
    callerId: payload.cid,
    callerKind: payload.ck,
    audience: payload.aud,
    issuedAt: payload.iat,
    ...(payload.exp === undefined ? {} : { expiresAt: payload.exp }),
  };
}
