export class AuthRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "AuthRouteError";
  }
}

export function authError(code: string, message: string, status?: number): AuthRouteError {
  return new AuthRouteError(code, message, status);
}

export function authErrorCode(error: unknown): string | null {
  if (error instanceof AuthRouteError) return error.code;
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 ? code : null;
}

export function authErrorStatus(error: unknown): number | null {
  return error instanceof AuthRouteError && typeof error.status === "number" ? error.status : null;
}
