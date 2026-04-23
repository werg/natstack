import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

interface RecordedInteraction {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  timestamp: number;
}

interface FixtureCassette {
  name: string;
  recordedAt: string;
  interactions: RecordedInteraction[];
}

export class FixtureRecorder {
  private cassette: FixtureCassette;
  private readonly fixturePath: string;
  private playbackIndex = 0;
  private mode: "record" | "playback";

  constructor(opts: { name: string; fixturePath: string; mode?: "record" | "playback" }) {
    this.fixturePath = opts.fixturePath;
    this.mode = opts.mode ?? "record";
    this.cassette = {
      name: opts.name,
      recordedAt: new Date().toISOString(),
      interactions: [],
    };
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.fixturePath, "utf-8");
      this.cassette = JSON.parse(raw) as FixtureCassette;
      this.mode = "playback";
      this.playbackIndex = 0;
    } catch {
      this.mode = "record";
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.fixturePath), { recursive: true });
    await writeFile(this.fixturePath, JSON.stringify(this.cassette, null, 2));
  }

  createFetch(): typeof fetch {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (this.mode === "playback") {
        return this.replay();
      }
      return this.recordAndForward(input, init);
    };
  }

  get interactions(): RecordedInteraction[] {
    return [...this.cassette.interactions];
  }

  private replay(): Response {
    const interaction = this.cassette.interactions[this.playbackIndex];
    if (!interaction) {
      throw new Error(`No more recorded interactions (index ${this.playbackIndex})`);
    }
    this.playbackIndex++;

    return new Response(interaction.response.body, {
      status: interaction.response.status,
      headers: interaction.response.headers,
    });
  }

  private async recordAndForward(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers: Record<string, string> = {};
    const headerSource = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (headerSource) {
      const h = new Headers(headerSource);
      h.forEach((v, k) => { headers[k] = v; });
    }

    let body: string | undefined;
    if (init?.body) {
      body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }

    const response = await globalThis.fetch(input, init);
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { responseHeaders[k] = v; });

    this.cassette.interactions.push({
      request: { url, method, headers, body },
      response: {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
      },
      timestamp: Date.now(),
    });

    return new Response(responseBody, {
      status: response.status,
      headers: responseHeaders,
    });
  }
}
