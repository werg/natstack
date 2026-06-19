// Public type surface for @workspace/cdp-client — a lightweight, workerd-native
// CDP client with a Playwright-style Page/Locator API implemented over raw CDP.
// Kept in sync with src/worker.ts (the implementation for the worker/workerd and
// natstack-panel conditions).

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LightweightConsoleEvent {
  type: string;
  text: string;
  args: unknown[];
}

export interface LightweightDomInspection {
  selector: string;
  found: boolean;
  tagName?: string;
  id?: string;
  className?: string;
  text?: string;
  visible?: boolean;
  attributes?: Record<string, string>;
  boundingBox?: BoundingBox;
}

export type WaitState = "attached" | "detached" | "visible" | "hidden";
export interface ActionOptions {
  timeout?: number;
}
export interface ByTextOptions {
  exact?: boolean;
}
export interface ByRoleOptions {
  name?: string;
  exact?: boolean;
}

/** A Playwright-style locator. Actions auto-wait for the element to be ready. */
export interface CdpLocator {
  // Scoping / chaining
  locator(selector: string): CdpLocator;
  getByRole(role: string, options?: ByRoleOptions): CdpLocator;
  getByText(text: string, options?: ByTextOptions): CdpLocator;
  getByLabel(text: string, options?: ByTextOptions): CdpLocator;
  getByPlaceholder(text: string, options?: ByTextOptions): CdpLocator;
  getByTestId(testId: string): CdpLocator;
  getByAltText(text: string, options?: ByTextOptions): CdpLocator;
  getByTitle(text: string, options?: ByTextOptions): CdpLocator;
  filter(options?: { hasText?: string; hasTextExact?: boolean }): CdpLocator;
  nth(index: number): CdpLocator;
  first(): CdpLocator;
  last(): CdpLocator;
  all(): Promise<CdpLocator[]>;
  // Actions (auto-waiting)
  click(opts?: ActionOptions): Promise<void>;
  dblclick(opts?: ActionOptions): Promise<void>;
  hover(opts?: ActionOptions): Promise<void>;
  fill(value: string, opts?: ActionOptions): Promise<void>;
  type(text: string, opts?: ActionOptions): Promise<void>;
  clear(opts?: ActionOptions): Promise<void>;
  press(key: string, opts?: ActionOptions): Promise<void>;
  check(opts?: ActionOptions): Promise<void>;
  uncheck(opts?: ActionOptions): Promise<void>;
  setChecked(checked: boolean, opts?: ActionOptions): Promise<void>;
  selectOption(value: string | string[], opts?: ActionOptions): Promise<string[]>;
  focus(opts?: ActionOptions): Promise<void>;
  blur(opts?: ActionOptions): Promise<void>;
  selectText(opts?: ActionOptions): Promise<void>;
  scrollIntoViewIfNeeded(opts?: ActionOptions): Promise<void>;
  dispatchEvent(type: string, opts?: ActionOptions): Promise<void>;
  // State / reads
  waitFor(options?: { state?: WaitState; timeout?: number }): Promise<void>;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isChecked(opts?: ActionOptions): Promise<boolean>;
  isEnabled(opts?: ActionOptions): Promise<boolean>;
  isDisabled(opts?: ActionOptions): Promise<boolean>;
  isEditable(opts?: ActionOptions): Promise<boolean>;
  getAttribute(name: string, opts?: ActionOptions): Promise<string | null>;
  inputValue(opts?: ActionOptions): Promise<string>;
  innerText(opts?: ActionOptions): Promise<string>;
  textContent(): Promise<string | null>;
  allInnerTexts(): Promise<string[]>;
  allTextContents(): Promise<string[]>;
  boundingBox(): Promise<BoundingBox | null>;
  inspect(): Promise<LightweightDomInspection>;
  /** Playwright-style description, e.g. `getByRole("button", { name: "Go" })`. */
  toString(): string;
}

/** A Playwright-style page bound to one CDP target. */
export interface CdpPage {
  goto(url: string): Promise<unknown>;
  reload(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  title(): Promise<string>;
  url(): string;
  content(): Promise<string>;
  /** Set the default timeout (ms) for auto-waiting actions/reads. Default 30000. */
  setDefaultTimeout(timeoutMs: number): void;
  evaluate(pageFunction: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<unknown>;
  /** Find by CSS selector. Prefer the `getBy*` helpers for resilient locators. */
  locator(selector: string): CdpLocator;
  /** Find by ARIA role, optionally narrowed by accessible name. */
  getByRole(role: string, options?: ByRoleOptions): CdpLocator;
  getByText(text: string, options?: ByTextOptions): CdpLocator;
  getByLabel(text: string, options?: ByTextOptions): CdpLocator;
  getByPlaceholder(text: string, options?: ByTextOptions): CdpLocator;
  getByTestId(testId: string): CdpLocator;
  getByAltText(text: string, options?: ByTextOptions): CdpLocator;
  getByTitle(text: string, options?: ByTextOptions): CdpLocator;
  waitForTimeout(timeout: number): Promise<void>;
  waitForFunction(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
    options?: { timeout?: number; polling?: number | "raf" }
  ): Promise<unknown>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    options?: { timeout?: number }
  ): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { state?: WaitState; timeout?: number }
  ): Promise<CdpLocator | null>;
  pressKey(key: string): Promise<void>;
  // Back-compat string-selector convenience
  click(selector: string, opts?: ActionOptions): Promise<void>;
  fill(selector: string, value: string, opts?: ActionOptions): Promise<void>;
  type(selector: string, text: string, opts?: ActionOptions): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  inspect(selector: string): Promise<LightweightDomInspection>;
  textContent(selector: string): Promise<string | null>;
  innerText(selector: string): Promise<string>;
  querySelector(selector: string): Promise<CdpLocator | null>;
  consoleEvents(): LightweightConsoleEvent[];
  clearConsoleEvents(): void;
  screenshot(options?: { type?: "png" | "jpeg"; quality?: number }): Promise<Uint8Array>;
}

/** Low-level raw CDP connection. Use for protocol-level work beyond the Page API. */
export class CdpConnection {
  static connect(wsEndpoint: string, authToken?: string): Promise<CdpConnection>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, listener: (params: unknown) => void): () => void;
  close(): void;
}

/** Error thrown by locator actions/reads; the message names the target locator. */
export class CdpError extends Error {
  readonly locator?: string;
  constructor(message: string, options?: { cause?: unknown; locator?: string });
}

export interface Browser {
  contexts(): Array<{ pages(): CdpPage[] }>;
  close(): Promise<void>;
}

export const BrowserImpl: {
  connect(
    wsEndpoint: string,
    options?: { transportOptions?: { authToken?: string } }
  ): Promise<Browser>;
};

export type Options = {
  headless?: boolean;
};

export function connect(
  wsEndpoint: string,
  browserName: string,
  options?: Options & { authToken?: string }
): Promise<Browser>;
