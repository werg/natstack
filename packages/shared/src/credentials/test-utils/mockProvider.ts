import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface MockProviderOpts {
  fixtures?: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>;
  defaultResponse?: { status: number; body: unknown };
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export class MockProvider {
  readonly port: number;
  readonly baseUrl: string;
  private readonly server: Server;
  private readonly recorded: RecordedRequest[] = [];
  private readonly fixtures: NonNullable<MockProviderOpts["fixtures"]>;
  private readonly defaultResponse: NonNullable<MockProviderOpts["defaultResponse"]>;

  private constructor(server: Server, port: number, opts: MockProviderOpts) {
    this.server = server;
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.fixtures = opts.fixtures ?? {};
    this.defaultResponse = opts.defaultResponse ?? { status: 200, body: { ok: true } };
  }

  static async start(opts: MockProviderOpts = {}): Promise<MockProvider> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to bind mock provider"));
          return;
        }
        const provider = new MockProvider(server, addr.port, opts);
        server.on("request", (req, res) => provider.handleRequest(req, res));
        resolve(provider);
      });
      server.on("error", reject);
    });
  }

  get requests(): RecordedRequest[] {
    return [...this.recorded];
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : undefined;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }

      this.recorded.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        body,
      });

      const urlPath = req.url ?? "/";
      const fixture = this.findFixture(urlPath);
      const status = fixture?.status ?? this.defaultResponse.status;
      const responseBody = fixture?.body ?? this.defaultResponse.body;
      const responseHeaders = fixture?.headers ?? {};

      res.writeHead(status, {
        "Content-Type": "application/json",
        ...responseHeaders,
      });
      res.end(JSON.stringify(responseBody));
    });
  }

  private findFixture(urlPath: string): MockProviderOpts["fixtures"] extends undefined ? undefined : { status?: number; body: unknown; headers?: Record<string, string> } | undefined {
    for (const [pattern, fixture] of Object.entries(this.fixtures)) {
      if (urlPath === pattern || urlPath.startsWith(pattern)) {
        return fixture;
      }
    }
    return undefined;
  }
}
