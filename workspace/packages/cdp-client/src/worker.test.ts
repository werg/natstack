import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserImpl, CdpConnection, CdpError } from "./worker";

/**
 * Fake CDP transport. Understands two kinds of Runtime.evaluate:
 *  - direct arrow-function evals (title/url/content/readyState), matched by substring;
 *  - op evals of the form `(async function(P){ <INPAGE> ... })(<JSON>)`, whose trailing
 *    JSON payload `{op, descriptor, arg, ...}` is decoded and simulated against a tiny
 *    fixed DOM.
 * Records every dispatched CDP method so pointer/key actions can be asserted.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static sent: Array<{ method: string; params?: Record<string, unknown> }> = [];

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
      params?: Record<string, unknown>;
    };
    if (message.type === "natstack:cdp-auth") {
      setTimeout(
        () =>
          this.dispatch("message", {
            data: JSON.stringify({ type: "natstack:cdp-auth-ok" }),
          }),
        0
      );
      return;
    }
    if (typeof message.id !== "number") return;
    if (message.method) FakeWebSocket.sent.push({ method: message.method, params: message.params });
    if (message.method === "Runtime.enable") {
      setTimeout(
        () =>
          this.dispatch("message", {
            data: JSON.stringify({
              method: "Runtime.consoleAPICalled",
              params: { type: "log", args: [{ value: "ready" }, { value: 42 }] },
            }),
          }),
        0
      );
    }
    const result = this.resultFor(message.method, message.params);
    setTimeout(
      () => this.dispatch("message", { data: JSON.stringify({ id: message.id, result }) }),
      0
    );
  }

  close(): void {
    this.dispatch("close", {});
  }

  private resultFor(method?: string, params?: Record<string, unknown>): unknown {
    if (method === "Page.navigate") {
      this.nextUrl = (params?.["url"] as string) ?? this.nextUrl;
      return {};
    }
    if (method === "Page.getNavigationHistory") {
      return { currentIndex: 1, entries: [{ id: 0 }, { id: 1 }, { id: 2 }] };
    }
    if (method === "Page.captureScreenshot") return { data: "AAAA" };
    if (method !== "Runtime.evaluate") return {};

    const expression = (params?.["expression"] as string) ?? "";
    // Op-protocol eval: decode the trailing JSON payload and simulate __nsRun.
    if (expression.includes("__nsRun")) {
      return { result: { value: this.runOp(expression) } };
    }
    // Direct arrow-function evals.
    if (expression.includes("location.href")) return { result: { value: this.nextUrl } };
    if (expression.includes("document.title")) return { result: { value: this.nextTitle } };
    if (expression.includes("document.readyState")) return { result: { value: true } };
    if (expression.includes("document.documentElement")) return { result: { value: this.html } };
    return { result: { value: undefined } };
  }

  private runOp(expression: string): unknown {
    const marker = "})(";
    const start = expression.lastIndexOf(marker) + marker.length;
    const end = expression.lastIndexOf(")");
    const payload = JSON.parse(expression.slice(start, end)) as {
      op: string;
      arg: { name?: string; value?: string; values?: string[]; checked?: boolean } | null;
      descriptor: { steps: Array<Record<string, unknown>> };
    };
    const targetsMissing = payload.descriptor.steps.some(
      (s) => s["by"] === "testid" && s["value"] === "missing"
    );
    switch (payload.op) {
      case "probe":
        return targetsMissing
          ? { ok: false, reason: "not found" }
          : { ok: true, x: 50, y: 10, box: { x: 0, y: 0, width: 100, height: 20 } };
      case "waitFor":
        return true;
      case "count":
        return 1;
      case "exists":
        return true;
      case "isVisible":
      case "isEnabled":
      case "isEditable":
        return true;
      case "isChecked":
      case "isDisabled":
        return false;
      case "textContent":
        return "Hello text";
      case "innerText":
        return "Hello";
      case "inputValue":
        return this.inputValue;
      case "getAttribute":
        return payload.arg?.name === "id" ? "main" : null;
      case "boundingBox":
        return { x: 0, y: 0, width: 100, height: 20 };
      case "allTextContents":
        return ["Hello text"];
      case "allInnerTexts":
        return ["Hello"];
      case "inspect":
        return {
          found: true,
          tagName: "BODY",
          id: "",
          className: "ready",
          text: "Hello",
          visible: true,
          attributes: { class: "ready" },
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        };
      case "fill":
        this.inputValue = payload.arg?.value ?? "";
        return true;
      case "clear":
        this.inputValue = "";
        return true;
      case "selectOption":
        return payload.arg?.values ?? [];
      case "setChecked":
      case "focus":
      case "blur":
      case "scrollIntoView":
      case "selectText":
      case "dispatchEvent":
      case "focusForKey":
        return true;
      default:
        return undefined;
    }
  }

  private dispatch(event: string, payload: { data?: string }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function installFakeWebSocket(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
}

describe("worker CDP client", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.sent = [];
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  it("authenticates and exposes page navigation + console capture", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp", {
      transportOptions: { authToken: "token" },
    });
    const page = browser.contexts()[0]!.pages()[0]!;

    await expect(page.title()).resolves.toBe("Example");
    expect(page.url()).toBe("https://example.com/current");
    await expect(page.content()).resolves.toBe("<html><body>Hello</body></html>");
    await page.goto("https://example.com/next");
    expect(page.url()).toBe("https://example.com/next");
    await expect(page.waitForLoadState("domcontentloaded")).resolves.toBeUndefined();
    await expect(page.waitForFunction(() => document.readyState === "complete")).resolves.toBe(
      true
    );

    expect(page.consoleEvents()).toEqual([{ type: "log", text: "ready 42", args: ["ready", 42] }]);
    page.clearConsoleEvents();
    expect(page.consoleEvents()).toEqual([]);
  });

  it("supports CSS + getBy locators and reads", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await expect(page.locator("body").count()).resolves.toBe(1);
    await expect(page.locator("body").textContent()).resolves.toBe("Hello text");
    await expect(page.getByText("Hello").innerText()).resolves.toBe("Hello");
    await expect(page.getByRole("button", { name: "Sign in" }).isVisible()).resolves.toBe(true);
    await expect(page.getByTestId("widget").isEnabled()).resolves.toBe(true);
    await expect(page.getByLabel("Email").getAttribute("id")).resolves.toBe("main");
    await expect(page.locator("li").allInnerTexts()).resolves.toEqual(["Hello"]);
    await expect(page.locator("body").inspect()).resolves.toMatchObject({
      found: true,
      tagName: "BODY",
      className: "ready",
    });
    // Back-compat string-selector convenience forms still work.
    await expect(page.innerText("body")).resolves.toBe("Hello");
    await expect(page.isVisible("body")).resolves.toBe(true);
  });

  it("dispatches a real CDP mouse sequence for click (auto-waited)", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await page.getByRole("button", { name: "Go" }).click();

    const mouse = FakeWebSocket.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(mouse.map((m) => m.params?.["type"])).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(mouse[1]?.params).toMatchObject({ x: 50, y: 10, button: "left", clickCount: 1 });
  });

  it("fills and reads back input value, and toggles a checkbox", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    await page.getByPlaceholder("Name").fill("abc");
    await expect(page.locator("input").inputValue()).resolves.toBe("abc");
    await page.locator("input").type("123");
    await expect(page.locator("input").inputValue()).resolves.toBe("abc123");

    await page.getByRole("checkbox").check();
    await expect(page.getByRole("combobox").selectOption("two")).resolves.toEqual(["two"]);
  });

  it("captures a screenshot via Page.captureScreenshot", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;
    const shot = await page.screenshot();
    expect(shot).toBeInstanceOf(Uint8Array);
    expect(shot.length).toBeGreaterThan(0);
  });

  it("exposes a raw CdpConnection for protocol-level work", async () => {
    installFakeWebSocket();
    const conn = await CdpConnection.connect("ws://cdp", "token");
    const events: unknown[] = [];
    conn.on("Custom.event", (p) => events.push(p));
    await expect(conn.send("Page.navigate", { url: "https://x" })).resolves.toBeDefined();
    conn.close();
  });

  it("renders Playwright-style locator descriptions via toString()", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    expect(page.getByRole("button", { name: "Go" }).toString()).toBe(
      'getByRole("button", { name: "Go" })'
    );
    expect(page.getByText("Hello").nth(2).toString()).toBe('getByText("Hello").nth(2)');
    expect(page.locator("div").first().toString()).toBe('locator("div").first()');
    expect(page.getByTestId("save").toString()).toBe('getByTestId("save")');
  });

  it("throws a CdpError that names the locator when an element is not actionable", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;

    const err = await page
      .getByTestId("missing")
      .click()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect((err as CdpError).message).toContain('getByTestId("missing")');
    expect((err as CdpError).locator).toBe('getByTestId("missing")');
  });

  it("honors setDefaultTimeout in actionability errors", async () => {
    installFakeWebSocket();
    const browser = await BrowserImpl.connect("ws://cdp");
    const page = browser.contexts()[0]!.pages()[0]!;
    page.setDefaultTimeout(1234);

    const err = await page
      .getByTestId("missing")
      .click()
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("1234ms");
  });
});
