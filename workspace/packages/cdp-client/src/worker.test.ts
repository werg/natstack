import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserImpl } from "./worker";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  private listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  private nextTitle = "Example";
  private nextUrl = "https://example.com/current";
  private html = "<html><body>Hello</body></html>";
  private inputValue = "";

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.dispatch("open", {}), 0);
  }

  addEventListener(event: string, handler: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(handler);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, handler: (event: { data?: string }) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      type?: string;
      method?: string;
      params?: { expression?: string; url?: string };
    };
    if (message.type === "natstack:cdp-auth") {
      setTimeout(() => this.dispatch("message", { data: JSON.stringify({ type: "natstack:cdp-auth-ok" }) }), 0);
      return;
    }
    if (typeof message.id !== "number") return;
    const result = this.resultFor(message.method, message.params);
    if (message.method === "Runtime.enable") {
      setTimeout(
        () =>
          this.dispatch("message", {
            data: JSON.stringify({
              method: "Runtime.consoleAPICalled",
              params: {
                type: "log",
                args: [{ value: "ready" }, { value: 42 }],
              },
            }),
          }),
        0
      );
    }
    setTimeout(
      () => this.dispatch("message", { data: JSON.stringify({ id: message.id, result }) }),
      0
    );
  }

  close(): void {
    this.dispatch("close", {});
  }

  private resultFor(method?: string, params?: { expression?: string; url?: string }): unknown {
    if (method === "Page.navigate") {
      this.nextUrl = params?.url ?? this.nextUrl;
      return {};
    }
    if (method !== "Runtime.evaluate") return {};
    const expression = params?.expression ?? "";
    if (expression.includes("location.href")) return { result: { value: this.nextUrl } };
    if (expression.includes("document.title")) return { result: { value: this.nextTitle } };
    if (expression.includes("document.readyState")) return { result: { value: true } };
    if (expression.includes("document.documentElement")) return { result: { value: this.html } };
    if (expression.includes("attributes = {}")) {
      return {
        result: {
          value: {
            selector: "body",
            found: true,
            tagName: "BODY",
            id: "",
            className: "ready",
            text: "Hello",
            visible: true,
            attributes: { class: "ready" },
            boundingBox: { x: 0, y: 0, width: 100, height: 20 },
          },
        },
      };
    }
    if (expression.includes("getComputedStyle")) return { result: { value: true } };
    if (expression.includes("innerText")) return { result: { value: "Hello" } };
    if (expression.includes("textContent")) return { result: { value: "Hello text" } };
    if (expression.includes('"value" in el ? el.value')) return { result: { value: this.inputValue } };
    if (expression.includes("el.value = value")) {
      const match = expression.match(/\), ("[^"]*")\)$/);
      this.inputValue = match ? JSON.parse(match[1]!) : this.inputValue;
      return { result: { value: undefined } };
    }
    if (expression.includes("querySelectorAll")) return { result: { value: 1 } };
    if (expression.includes("querySelector")) return { result: { value: true } };
    return { result: { value: undefined } };
  }

  private dispatch(event: string, payload: { data?: string }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

describe("worker Playwright compatibility client", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  it("exposes core Playwright-like page helpers over raw CDP", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });

    const browser = await BrowserImpl.connect("ws://cdp", {
      transportOptions: { authToken: "token" },
    });
    const page = browser.contexts()[0]!.pages()[0]!;

    await expect(page.title()).resolves.toBe("Example");
    expect(page.url()).toBe("https://example.com/current");
    await expect(page.content()).resolves.toBe("<html><body>Hello</body></html>");
    await page.goto("https://example.com/next");
    expect(page.url()).toBe("https://example.com/next");
    await expect(page.waitForSelector("body")).resolves.toBeTruthy();
    await expect(page.querySelector("body")).resolves.toBeTruthy();
    await expect(page.locator("body").count()).resolves.toBe(1);
    await expect(page.locator("body").innerText()).resolves.toBe("Hello");
    await expect(page.locator("body").textContent()).resolves.toBe("Hello text");
    await expect(page.locator("body").isVisible()).resolves.toBe(true);
    await expect(page.innerText("body")).resolves.toBe("Hello");
    await expect(page.textContent("body")).resolves.toBe("Hello text");
    await expect(page.isVisible("body")).resolves.toBe(true);
    await expect(page.inspect("body")).resolves.toMatchObject({
      found: true,
      tagName: "BODY",
      className: "ready",
      visible: true,
    });
    await expect(page.locator("body").inspect()).resolves.toMatchObject({
      found: true,
      text: "Hello",
    });
    expect(page.consoleEvents()).toEqual([
      { type: "log", text: "ready 42", args: ["ready", 42] },
    ]);
    page.clearConsoleEvents();
    expect(page.consoleEvents()).toEqual([]);
    await expect(page.waitForLoadState("domcontentloaded")).resolves.toBeUndefined();
    await page.fill("input", "abc");
    await page.type("input", "123");
    await expect(page.locator("input").isVisible()).resolves.toBe(true);
  });
});
