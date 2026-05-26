import type { ServerResponse } from "http";
import { authErrorCode, authErrorStatus } from "./errors.js";

export interface HttpErrorPayload {
  error: string;
  code: string;
}

export function authHttpError(
  error: unknown,
  fallbackStatus: number
): {
  status: number;
  payload: HttpErrorPayload;
} {
  const message = error instanceof Error ? error.message : String(error);
  const code = authErrorCode(error) ?? "AUTH_ERROR";
  return {
    status: authErrorStatus(error) ?? statusForCode(code, fallbackStatus),
    payload: { error: message, code },
  };
}

export function sendAuthError(res: ServerResponse, error: unknown, fallbackStatus: number): void {
  const { status, payload } = authHttpError(error, fallbackStatus);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function statusForCode(code: string, fallbackStatus: number): number {
  if (code === "EACCES") return 403;
  if (code === "UNSUPPORTED_PRINCIPAL") return 400;
  if (code === "PRINCIPAL_GRANTS_UNAVAILABLE" || code === "PRINCIPAL_UNAVAILABLE") return 503;
  return fallbackStatus;
}
