/**
 * Base HTTP client for DO outbound calls.
 *
 * Shared by PubSubDOClient and ServerDOClient — provides authenticated
 * JSON POST/GET with consistent error handling.
 */

export class HttpClient {
  constructor(
    protected baseUrl: string,
    protected authToken: string,
    private label: string,
  ) {}

  protected async post(path: string, body: unknown): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${this.label} ${resp.status}: ${text}`);
    }
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return resp.json();
    }
    return undefined;
  }

  protected async get(path: string): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.authToken}`,
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${this.label} ${resp.status}: ${text}`);
    }
    return resp.json();
  }
}
