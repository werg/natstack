import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface OperatorAuth {
  token: string;
  generated: boolean;
}

export function resolveOperatorAuth(explicit?: string): OperatorAuth {
  const token = explicit?.trim() || process.env["NATSTACK_SUPERVISOR_OPERATOR_TOKEN"]?.trim();
  if (token) return { token, generated: false };
  return { token: randomBytes(32).toString("base64url"), generated: true };
}

export function hasValidOperatorToken(req: IncomingMessage, expectedToken: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  return constantTimeEqual(token, expectedToken);
}

export function requireOperatorToken(req: IncomingMessage, expectedToken: string): void {
  if (!hasValidOperatorToken(req, expectedToken)) {
    throw new OperatorAuthError();
  }
}

export class OperatorAuthError extends Error {
  constructor() {
    super("Supervisor operator token required");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
