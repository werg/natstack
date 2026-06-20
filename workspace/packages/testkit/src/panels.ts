/**
 * Panel automation helpers — thin, composable wrappers over the runtime's
 * panelTree/PanelHandle APIs, designed for eval one-shots and ported E2E
 * suites.
 *
 * Reads prefer the approval-free agentApi snapshot path
 * (handle.snapshot() → _agent.snapshot inside the panel); CDP is the
 * escalation for input, viewport emulation and layout measurement.
 */
import { openPanel as runtimeOpenPanel, panelTree } from "@workspace/runtime";
import type { PanelHandle } from "@workspace/runtime";
import { activeTestContext } from "./run.js";
import { withCdpSession } from "./cdp.js";
import { TestAssertionError } from "./expect.js";

export interface OpenPanelOptions {
  parentId?: string | null;
  name?: string;
  focus?: boolean;
  stateArgs?: Record<string, unknown>;
  /** Wait until the panel's runtime lease reports loaded (default true). */
  waitLoaded?: boolean;
  timeoutMs?: number;
}

interface PanelSnapshot {
  kind: string;
  text: string;
  structure: unknown;
}

function assertNotSelf(handle: PanelHandle | string): void {
  const id = typeof handle === "string" ? handle : handle.id;
  let selfId: string | null = null;
  try {
    selfId = panelTree.self().id;
  } catch {
    return; // No self (e.g. before runtime init in unit tests) — nothing to guard.
  }
  if (id === selfId) {
    throw new Error(
      `testkit refuses to automate the panel it is running in (${id}); open a separate target panel instead`
    );
  }
}

function assertNotAborted(signal: AbortSignal | undefined, label: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
  throw new TestAssertionError(`${label} aborted${reason ? `: ${reason}` : ""}`);
}

function sleep(ms: number, signal: AbortSignal | undefined, label: string): Promise<void> {
  assertNotAborted(signal, label);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      try {
        assertNotAborted(signal, label);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Generic poll-until-defined helper. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  opts?: { timeoutMs?: number; intervalMs?: number; label?: string }
): Promise<T> {
  const signal = activeTestContext()?.signal;
  const label = `waitFor${opts?.label ? ` "${opts.label}"` : ""}`;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    assertNotAborted(signal, label);
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value as T;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError
        ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
        : "";
      throw new TestAssertionError(`${label} timed out after ${timeoutMs}ms${suffix}`);
    }
    await sleep(intervalMs, signal, label);
  }
}

/** Open a panel, auto-watch it with the active test's supervisor, wait for load. */
export async function openPanel(source: string, opts: OpenPanelOptions = {}): Promise<PanelHandle> {
  const handle = await runtimeOpenPanel(source, {
    parentId: opts.parentId,
    name: opts.name,
    focus: opts.focus,
    stateArgs: opts.stateArgs,
  });
  activeTestContext()?.supervisor.watchPanel(handle);
  if (opts.waitLoaded !== false) {
    await waitFor(() => handle.isLoaded(), {
      timeoutMs: opts.timeoutMs ?? 30_000,
      label: `panel ${source} loaded`,
    });
  }
  return handle;
}

/** Open a panel, run `fn`, always close the panel afterwards. */
export async function withPanel<T>(
  source: string,
  fn: (handle: PanelHandle) => Promise<T>,
  opts?: OpenPanelOptions
): Promise<T> {
  const handle = await openPanel(source, opts);
  try {
    return await fn(handle);
  } finally {
    try {
      await handle.close();
    } catch {
      // Panel may already be gone (e.g. the test closed it) — fine.
    }
  }
}

/** Visible text of a panel via the approval-free agentApi snapshot. */
export async function panelText(handle: PanelHandle): Promise<string> {
  const snapshot = (await handle.snapshot()) as PanelSnapshot | undefined;
  return snapshot?.text ?? "";
}

/** Wait until the panel's visible text matches. */
export async function waitForText(
  handle: PanelHandle,
  text: string | RegExp,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  await waitFor(
    async () => {
      const current = await panelText(handle);
      return typeof text === "string" ? current.includes(text) : text.test(current);
    },
    { ...opts, label: `panel ${handle.id} shows ${String(text)}` }
  );
}

export interface ViewportSpec {
  width: number;
  height: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
}

/** Emulate a viewport on the panel via CDP Emulation.setDeviceMetricsOverride. */
export async function setViewport(handle: PanelHandle, viewport: ViewportSpec): Promise<void> {
  assertNotSelf(handle);
  await withCdpSession(handle, async (session) => {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      mobile: viewport.mobile ?? false,
    });
  });
}

export async function clearViewport(handle: PanelHandle): Promise<void> {
  assertNotSelf(handle);
  await withCdpSession(handle, async (session) => {
    await session.send("Emulation.clearDeviceMetricsOverride");
  });
}

export interface PanelAudit {
  viewport: { width: number; height: number };
  scrollWidth: number;
  scrollHeight: number;
  horizontalOverflow: boolean;
  overflowElements: Array<{ tag: string; className: string; width: number }>;
  consoleErrors: number;
}

const AUDIT_EXPRESSION = `(() => {
  const vw = window.innerWidth;
  const overflow = [];
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && (rect.right > vw + 1 || rect.left < -1)) {
      overflow.push({
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === "string" ? el.className.slice(0, 80) : "",
        width: Math.round(rect.width),
      });
      if (overflow.length >= 10) break;
    }
  }
  return JSON.stringify({
    viewport: { width: vw, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    horizontalOverflow: document.documentElement.scrollWidth > vw + 1 || overflow.length > 0,
    overflowElements: overflow,
  });
})()`;

/** Layout + console-health audit of a panel (CDP-based measurement). */
export async function audit(handle: PanelHandle): Promise<PanelAudit> {
  assertNotSelf(handle);
  const layout = await withCdpSession(handle, async (session) => {
    const result = (await session.send("Runtime.evaluate", {
      expression: AUDIT_EXPRESSION,
      returnByValue: true,
    })) as { result?: { value?: string } };
    return JSON.parse(result.result?.value ?? "{}") as Omit<PanelAudit, "consoleErrors">;
  });
  let consoleErrors = 0;
  try {
    const history = await handle.cdp.consoleHistory();
    consoleErrors = history.errors.length;
  } catch {
    // Console history may be unavailable for some targets.
  }
  return { ...layout, consoleErrors };
}

/** Evaluate an expression in the panel's page context, returning by value. */
export async function evalInPanel<T = unknown>(handle: PanelHandle, expression: string): Promise<T> {
  assertNotSelf(handle);
  return withCdpSession(handle, async (session) => {
    const result = (await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "evalInPanel failed"
      );
    }
    return result.result?.value as T;
  });
}
