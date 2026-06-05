type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CdpEvent = {
  method: string;
  params?: unknown;
};

export type LightweightConsoleEvent = {
  type: string;
  text: string;
  args: unknown[];
};

export type LightweightDomInspection = {
  selector: string;
  found: boolean;
  tagName?: string;
  id?: string;
  className?: string;
  text?: string;
  visible?: boolean;
  attributes?: Record<string, string>;
  boundingBox?: { x: number; y: number; width: number; height: number };
};

type WebSocketCtor = new (url: string) => WebSocket;

function getWebSocketCtor(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in this worker runtime");
  }
  return ctor;
}

function once(
  ws: WebSocket,
  event: "open" | "message" | "error" | "close"
): Promise<Event | MessageEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener(event, handle);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
    };
    const handle = (ev: Event | MessageEvent) => {
      cleanup();
      resolve(ev);
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`CDP WebSocket ${event} failed`));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error(`CDP WebSocket closed before ${event}`));
    };
    ws.addEventListener(event, handle);
    if (event !== "error") ws.addEventListener("error", handleError);
    if (event !== "close") ws.addEventListener("close", handleClose);
  });
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data && typeof (data as Blob).text === "function") {
    return (data as Blob).text();
  }
  return String(data);
}

function decodeBase64(data: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const bufferCtor = (globalThis as { Buffer?: { from(data: string, enc: string): Uint8Array } })
    .Buffer;
  if (bufferCtor) return bufferCtor.from(data, "base64");
  throw new Error("No base64 decoder is available in this runtime");
}

class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private eventListeners = new Map<string, Set<(params: unknown) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      const error = new Error("CDP WebSocket closed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async connect(wsEndpoint: string, authToken?: string): Promise<CdpConnection> {
    const WebSocketImpl = getWebSocketCtor();
    const ws = new WebSocketImpl(wsEndpoint);
    await once(ws, "open");
    if (authToken) {
      ws.send(JSON.stringify({ type: "natstack:cdp-auth", token: authToken }));
      const event = (await once(ws, "message")) as MessageEvent;
      const parsed = JSON.parse(await messageText(event.data)) as { type?: string };
      if (parsed.type !== "natstack:cdp-auth-ok") {
        throw new Error("CDP authentication failed");
      }
    }
    return new CdpConnection(ws);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message = params ? { id, method, params } : { id, method };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.ws.close();
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(method);
    };
  }

  private async handleMessage(data: unknown): Promise<void> {
    const parsed = JSON.parse(await messageText(data)) as CdpResponse & CdpEvent;
    if (typeof parsed.id !== "number") {
      if (parsed.method) {
        for (const listener of this.eventListeners.get(parsed.method) ?? []) {
          listener(parsed.params);
        }
      }
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? parsed.error.data ?? "CDP command failed"));
      return;
    }
    pending.resolve(parsed.result);
  }
}

class WorkerCdpPage {
  private currentUrl = "";
  private readonly consoleBuffer: LightweightConsoleEvent[] = [];

  constructor(private readonly connection: CdpConnection) {
    this.connection.on("Runtime.consoleAPICalled", (params) => {
      const event = params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string; type?: string }>;
      };
      const args = (event.args ?? []).map((arg) =>
        Object.prototype.hasOwnProperty.call(arg, "value") ? arg.value : arg.description
      );
      this.consoleBuffer.push({
        type: event.type ?? "log",
        text: args.map((arg) => String(arg)).join(" "),
        args,
      });
    });
  }

  async initialize(): Promise<void> {
    await Promise.allSettled([
      this.connection.send("Page.enable"),
      this.connection.send("Runtime.enable"),
      this.connection.send("DOM.enable"),
    ]);
    this.currentUrl = String((await this.evaluate(() => location.href).catch(() => "")) ?? "");
  }

  async goto(url: string): Promise<unknown> {
    const result = await this.connection.send("Page.navigate", { url });
    this.currentUrl = url;
    return result;
  }

  async title(): Promise<string> {
    return String((await this.evaluate(() => document.title)) ?? "");
  }

  url(): string {
    return this.currentUrl;
  }

  async content(): Promise<string> {
    return String(
      (await this.evaluate(() => document.documentElement?.outerHTML ?? "")) ?? ""
    );
  }

  async evaluate(pageFunction: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<unknown> {
    const expression =
      typeof pageFunction === "function"
        ? `(${pageFunction.toString()})(${JSON.stringify(arg)})`
        : pageFunction;
    const result = (await this.connection.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
    }
    return result.result?.value;
  }

  locator(selector: string): WorkerCdpLocator {
    return new WorkerCdpLocator(this, selector);
  }

  async waitForTimeout(timeout: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeout));
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.evaluate(
      `(function(selector, value) {
        const el = document.querySelector(selector);
        if (!el) throw new Error("No element matches selector: " + selector);
        if (!("value" in el)) throw new Error("Element is not fillable: " + selector);
        el.focus?.();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })(${JSON.stringify(selector)}, ${JSON.stringify(value)})`
    );
  }

  async type(selector: string, text: string): Promise<void> {
    const current = await this.evaluate(
      `(function(selector) {
        const el = document.querySelector(selector);
        if (!el) throw new Error("No element matches selector: " + selector);
        return "value" in el ? el.value : "";
      })(${JSON.stringify(selector)})`
    );
    await this.fill(selector, `${current ?? ""}${text}`);
  }

  async querySelector(selector: string): Promise<WorkerCdpElementHandle | null> {
    const exists = await this.evaluate(
      `(function(selector) { return Boolean(document.querySelector(selector)); })(${JSON.stringify(
        selector
      )})`
    );
    return exists ? new WorkerCdpElementHandle(this, selector) : null;
  }

  async isVisible(selector: string): Promise<boolean> {
    return Boolean(
      await this.evaluate(
        `(function(selector) {
          const el = document.querySelector(selector);
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        })(${JSON.stringify(selector)})`
      )
    );
  }

  consoleEvents(): LightweightConsoleEvent[] {
    return [...this.consoleBuffer];
  }

  clearConsoleEvents(): void {
    this.consoleBuffer.length = 0;
  }

  async inspect(selector: string): Promise<LightweightDomInspection> {
    return (await this.evaluate(
      `(function(selector) {
        const el = document.querySelector(selector);
        if (!el) return { selector, found: false };
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const attributes = {};
        for (const attr of Array.from(el.attributes ?? [])) attributes[attr.name] = attr.value;
        return {
          selector,
          found: true,
          tagName: el.tagName,
          id: el.id || "",
          className: typeof el.className === "string" ? el.className : "",
          text: (el.innerText ?? el.textContent ?? "").slice(0, 4000),
          visible: style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0,
          attributes,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })(${JSON.stringify(selector)})`
    )) as LightweightDomInspection;
  }

  async waitForSelector(
    selector: string,
    options: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number } = {}
  ): Promise<WorkerCdpElementHandle | null> {
    const state = options.state ?? "visible";
    const timeout = options.timeout ?? 30_000;
    const found = await this.evaluate(
      `(async function(selector, state, timeout) {
        const deadline = Date.now() + timeout;
        function matches() {
          const el = document.querySelector(selector);
          if (state === "detached") return !el;
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          if (state === "hidden") return !visible;
          if (state === "attached") return true;
          return visible;
        }
        while (Date.now() <= deadline) {
          if (matches()) return state === "detached" || state === "hidden" ? null : true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Timeout " + timeout + "ms exceeded waiting for selector " + JSON.stringify(selector) + " to be " + state);
      })(${JSON.stringify(selector)}, ${JSON.stringify(state)}, ${JSON.stringify(timeout)})`
    );
    return found ? new WorkerCdpElementHandle(this, selector) : null;
  }

  async textContent(selector: string): Promise<string | null> {
    return this.locator(selector).textContent();
  }

  async innerText(selector: string): Promise<string> {
    return this.locator(selector).innerText();
  }

  async click(selector: string): Promise<void> {
    const point = (await this.evaluate(
      `(function(selector) {
        const el = document.querySelector(selector);
        if (!el) throw new Error("No element matches selector: " + selector);
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })(${JSON.stringify(selector)})`
    )) as { x?: number; y?: number };
    if (typeof point?.x !== "number" || typeof point?.y !== "number") {
      throw new Error(`No clickable point for selector: ${selector}`);
    }
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }

  async screenshot(options: { type?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    const result = (await this.connection.send("Page.captureScreenshot", options)) as {
      data?: string;
    };
    if (!result.data) throw new Error("CDP screenshot did not return image data");
    return decodeBase64(result.data);
  }

  async waitForLoadState(
    state: "load" | "domcontentloaded" | "networkidle" = "load",
    options: { timeout?: number } = {}
  ): Promise<void> {
    const timeout = options.timeout ?? 30_000;
    await this.evaluate(
      `(async function(state, timeout) {
        const deadline = Date.now() + timeout;
        function reached() {
          const ready = document.readyState;
          if (state === "domcontentloaded") return ready === "interactive" || ready === "complete";
          return ready === "complete";
        }
        while (Date.now() <= deadline) {
          if (reached()) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Timeout " + timeout + "ms exceeded waiting for load state " + state);
      })(${JSON.stringify(state)}, ${JSON.stringify(timeout)})`
    );
  }
}

class WorkerCdpLocator {
  constructor(private readonly page: WorkerCdpPage, private readonly selector: string) {}

  async click(): Promise<void> {
    await this.page.click(this.selector);
  }

  async fill(value: string): Promise<void> {
    await this.page.fill(this.selector, value);
  }

  async type(text: string): Promise<void> {
    await this.page.type(this.selector, text);
  }

  async isVisible(): Promise<boolean> {
    return this.page.isVisible(this.selector);
  }

  async inspect(): Promise<LightweightDomInspection> {
    return this.page.inspect(this.selector);
  }

  async innerText(): Promise<string> {
    return String(
      (await this.page.evaluate(
        `(function(selector) {
          const el = document.querySelector(selector);
          if (!el) throw new Error("No element matches selector: " + selector);
          return el.innerText ?? el.textContent ?? "";
        })(${JSON.stringify(this.selector)})`
      )) ?? ""
    );
  }

  async textContent(): Promise<string | null> {
    const value = await this.page.evaluate(
      `(function(selector) {
        const el = document.querySelector(selector);
        return el ? el.textContent : null;
      })(${JSON.stringify(this.selector)})`
    );
    return value == null ? null : String(value);
  }

  async count(): Promise<number> {
    return Number(
      (await this.page.evaluate(
        `(function(selector) { return document.querySelectorAll(selector).length; })(${JSON.stringify(
          this.selector
        )})`
      )) ?? 0
    );
  }
}

class WorkerCdpElementHandle extends WorkerCdpLocator {}

class WorkerBrowser {
  constructor(private readonly page: WorkerCdpPage, private readonly connection: CdpConnection) {}

  contexts(): Array<{ pages(): WorkerCdpPage[] }> {
    return [{ pages: () => [this.page] }];
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}

export const BrowserImpl = {
  async connect(
    wsEndpoint: string,
    options: { transportOptions?: { authToken?: string } } = {}
  ): Promise<WorkerBrowser> {
    const connection = await CdpConnection.connect(
      wsEndpoint,
      options.transportOptions?.authToken
    );
    const page = new WorkerCdpPage(connection);
    await page.initialize();
    return new WorkerBrowser(page, connection);
  },
};
