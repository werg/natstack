/**
 * Base HTTP client for DO outbound calls.
 *
 * Shared by PubSubDOClient and ServerDOClient — provides authenticated
 * JSON POST/GET with consistent error handling and retry with exponential backoff.
 */

function isTransient(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network errors
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|socket hang up/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  constructor(
    protected baseUrl: string,
    protected authToken: string,
    private label: string,
  ) {}

  protected async post(path: string, body: unknown, opts?: { retries?: number }): Promise<unknown> {
    const maxRetries = opts?.retries ?? 2;
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(url, init);
        if (resp.ok) {
          const ct = resp.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) {
            return resp.json();
          }
          return undefined;
        }
        if (resp.status >= 500 && attempt < maxRetries) {
          await sleep(100 * Math.pow(2, attempt));
          continue;
        }
        const text = await resp.text();
        throw new Error(`${this.label} ${resp.status}: ${text}`);
      } catch (err) {
        if (attempt < maxRetries && isTransient(err)) {
          await sleep(100 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
    // Unreachable, but satisfies TypeScript
    throw new Error(`${this.label}: exhausted retries`);
  }

  protected async get(path: string, opts?: { retries?: number }): Promise<unknown> {
    const maxRetries = opts?.retries ?? 2;
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.authToken}`,
      },
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(url, init);
        if (resp.ok) {
          return resp.json();
        }
        if (resp.status >= 500 && attempt < maxRetries) {
          await sleep(100 * Math.pow(2, attempt));
          continue;
        }
        const text = await resp.text();
        throw new Error(`${this.label} ${resp.status}: ${text}`);
      } catch (err) {
        if (attempt < maxRetries && isTransient(err)) {
          await sleep(100 * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${this.label}: exhausted retries`);
  }
}
