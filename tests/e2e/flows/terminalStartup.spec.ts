/**
 * Terminal startup E2E test.
 *
 * The standalone "terminal boots without console errors" check is ported
 * in-system to @workspace/testkit
 * (workspace/packages/testkit/src/suites/terminal.ts). Here the console-error
 * diagnostics assertion is interwoven with the pty/approval startup flow
 * (shell-level approval prompts cannot run in-system), so this spec stays.
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import {
  callTerminalPanel,
  clickPanelSelector,
  clickPanelText,
  createManagedTestWorkspace,
  getElectronClipboardText,
  getFocusedPanelWebContentsId,
  getPanelDiagnostics,
  getPanelHtml,
  getPanelSelectorWindowPoint,
  isPanelLoaded,
  launchTestApp,
  reloadPanel,
  removeManagedTestWorkspace,
  setElectronClipboardText,
  startPanelDiagnostics,
  type PanelDiagnostic,
  typePanelText,
  type TestApp,
} from "../../setup/electronSetup";

const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PendingApproval = {
  approvalId: string;
  kind: string;
  title?: string;
  options?: Array<{
    value: string;
    tone?: string;
    label?: string;
  }>;
};

async function getTerminalPanelId(app: ElectronApplication): Promise<string> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await app.evaluate(() => {
        const testApi = (globalThis as { __testApi?: { getPanelTree: () => unknown[] } }).__testApi;
        if (!testApi) throw new Error("Test API not available");
        const panels = testApi.getPanelTree() as Array<{
          id: string;
          snapshot?: { source?: string };
        }>;
        const terminal = panels.find((panel) => panel.snapshot?.source === "panels/terminal");
        if (!terminal) throw new Error("Terminal panel not found");
        return terminal.id;
      });
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for terminal panel");
}

async function waitForTerminalPanel(app: ElectronApplication, window: Page): Promise<string> {
  const panelId = await getTerminalPanelId(app);
  await expect
    .poll(
      async () => {
        await approvePendingTerminalWork(app, window).catch(() => {});
        return isPanelLoaded(app, panelId).catch(() => false);
      },
      { timeout: 30_000, intervals: [250, 500, 1000] }
    )
    .toBe(true);
  return panelId;
}

async function listPendingApprovals(app: ElectronApplication): Promise<PendingApproval[]> {
  return app.evaluate(async () => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    const pending = await testApi.rpcCall("shellApproval", "listPending", []) as Array<{
      approvalId: string;
      kind: string;
      title?: string;
      options?: Array<{
        value: unknown;
        tone?: unknown;
        label?: unknown;
      }>;
    }>;
    return pending.map((approval) => ({
      approvalId: approval.approvalId,
      kind: approval.kind,
      title: approval.title,
      options: Array.isArray(approval.options)
        ? approval.options.map((option) => ({
            value: String(option.value),
            tone: typeof option.tone === "string" ? option.tone : undefined,
            label: typeof option.label === "string" ? option.label : undefined,
          }))
        : undefined,
    }));
  });
}

async function resolveApproval(app: ElectronApplication, approval: PendingApproval): Promise<void> {
  await app.evaluate(async (_electron, pending) => {
    const testApi = (
      globalThis as {
        __testApi?: {
          rpcCall: (service: string, method: string, args?: unknown[]) => Promise<unknown>;
        };
      }
    ).__testApi;
    if (!testApi) throw new Error("Test API not available");
    if (pending.kind === "userland") {
      const choice =
        pending.options?.find((option) => option.tone === "primary")?.value ??
        pending.options?.find((option) => option.tone !== "danger")?.value ??
        pending.options?.[0]?.value;
      if (!choice) {
        throw new Error(`Userland approval ${pending.approvalId} did not include any options`);
      }
      await testApi.rpcCall("shellApproval", "resolveUserland", [pending.approvalId, choice]);
      return;
    }
    await testApi.rpcCall("shellApproval", "resolve", [pending.approvalId, "session"]);
  }, approval);
}

async function approvePendingTerminalWork(app: ElectronApplication, window?: Page): Promise<void> {
  const pending = await listPendingApprovals(app);
  for (const approval of pending) {
    await resolveApproval(app, approval);
  }
  if (window) {
    await window
      .getByRole("button", {
        name: /Approve and start|Approve all|Approve push|Approve|Dev session|Install and run|Allow|Run once|Allow for session|Use this session/i,
      })
      .click({ timeout: 250 })
      .catch(() => {});
  }
}

function createTerminalOnlyWorkspace(): string {
  const workspace = createManagedTestWorkspace();
  const configPath = path.join(workspace, "source", "meta", "natstack.yml");
  const config = (YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {}) as Record<
    string,
    unknown
  >;
  config.initPanels = [{ source: "panels/terminal" }];
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
  return workspace;
}

type TerminalSession = {
  sessionId: string;
  alive?: boolean;
  cols?: number;
  rows?: number;
  detectedPorts?: number[];
  detectedUrls?: string[];
  meta?: Record<string, unknown>;
};

async function listTerminalSessions(
  app: ElectronApplication,
  panelId: string
): Promise<TerminalSession[]> {
  return callTerminalPanel<TerminalSession[]>(app, panelId, "listSessions");
}

async function requestTerminalSession(
  app: ElectronApplication,
  panelId: string
): Promise<string | undefined> {
  const result = await callTerminalPanel<{ sessionId?: string }>(app, panelId, "openSession");
  return result.sessionId;
}

async function waitForUsableTerminalSession(
  app: ElectronApplication,
  panelId: string,
  window?: Page
): Promise<TerminalSession> {
  const startedAt = Date.now();
  let lastOpenRequestAt = 0;
  await expect
    .poll(
      async () => {
        await approvePendingTerminalWork(app, window);
        let sessions = await listTerminalSessions(app, panelId).catch(() => []);
        const alive = sessions.find((session) => session.alive !== false)?.sessionId;
        if (alive) return alive;

        const now = Date.now();
        if (now - startedAt > 5_000 && now - lastOpenRequestAt > 5_000) {
          lastOpenRequestAt = now;
          const opened = await requestTerminalSession(app, panelId).catch(() => undefined);
          await approvePendingTerminalWork(app, window);
          if (opened) return opened;
          sessions = await listTerminalSessions(app, panelId).catch(() => []);
        }
        return sessions.find((session) => session.alive !== false)?.sessionId ?? "";
      },
      { timeout: 120_000, intervals: [500, 1000, 2000] }
    )
    .not.toBe("");

  const sessions = await listTerminalSessions(app, panelId);
  const session = sessions.find((item) => item.alive !== false);
  if (!session) throw new Error("No usable terminal session");
  return session;
}

function severePanelDiagnostics(items: PanelDiagnostic[]): PanelDiagnostic[] {
  return items.filter((item) => {
    if (item.type === "render-process-gone" || item.type === "unresponsive") return true;
    if (item.type === "did-fail-load") return !item.message.includes("(-3)");
    if (item.type !== "console") return false;
    const level = String(item.level ?? "").toLowerCase();
    return (
      level === "2" ||
      level === "3" ||
      level === "error" ||
      /\b(uncaught|typeerror|referenceerror|renderservice|onrequestredraw)\b/i.test(item.message)
    );
  });
}

async function expectScrollbackToContain(
  app: ElectronApplication,
  panelId: string,
  sessionId: string,
  text: string
): Promise<void> {
  await expect
    .poll(async () => {
      const scrollback = await callTerminalPanel<{ text: string }>(
        app,
        panelId,
        "getScrollback",
        { sessionId, maxBytes: 1024 * 1024 }
      );
      return scrollback.text;
    }, {
      timeout: 10_000,
      intervals: [250, 500, 1000],
    })
    .toContain(text);
}

async function scrollbackContains(
  app: ElectronApplication,
  panelId: string,
  sessionId: string,
  text: string
): Promise<boolean> {
  const scrollback = await callTerminalPanel<{ text: string }>(
    app,
    panelId,
    "getScrollback",
    { sessionId, maxBytes: 1024 * 1024 }
  );
  return scrollback.text.includes(text);
}

async function expectRenderedToContain(
  app: ElectronApplication,
  panelId: string,
  sessionId: string,
  text: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        callTerminalPanel<string>(app, panelId, "getRenderedText", {
          sessionId,
        }),
      {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      }
    )
    .toContain(text);
}

async function clickTerminalThroughWindow(testApp: TestApp, panelId: string): Promise<void> {
  expect(await clickPanelSelector(testApp.app, panelId, ".xterm")).toBe(true);
  await expect
    .poll(async () => getFocusedPanelWebContentsId(testApp.app), {
      timeout: 5_000,
      intervals: [100, 250, 500],
    })
    .toBe(panelId);
}

async function nativeWindowInfo(app: ElectronApplication): Promise<{
  id: string;
  pid: number;
  bounds: { x: number; y: number; width: number; height: number };
  contentBounds: { x: number; y: number; width: number; height: number };
}> {
  return app.evaluate(({ BaseWindow, BrowserWindow }) => {
    const win = BaseWindow.getAllWindows()[0] ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("No Electron window");
    const handle = win.getNativeWindowHandle();
    return {
      id: process.platform === "linux" ? String(handle.readUInt32LE(0)) : handle.toString("hex"),
      pid: process.pid,
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
    };
  });
}

async function xdotoolWindowId(windowInfo: { id: string; pid: number }): Promise<string> {
  if (process.platform !== "linux") return windowInfo.id;
  try {
    const { stdout } = await execFileAsync("xdotool", ["search", "--pid", String(windowInfo.pid)]);
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    return ids.at(-1) ?? windowInfo.id;
  } catch {
    return windowInfo.id;
  }
}

async function hasXdotool(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    await execFileAsync("xdotool", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function clickTerminalThroughOs(testApp: TestApp, panelId: string): Promise<boolean> {
  if (!(await hasXdotool())) return false;
  const point =
    (await getPanelSelectorWindowPoint(testApp.app, panelId, ".xterm-helper-textarea")) ??
    (await getPanelSelectorWindowPoint(testApp.app, panelId, ".xterm"));
  expect(point).toBeTruthy();
  const windowInfo = await nativeWindowInfo(testApp.app);
  const windowId = await xdotoolWindowId(windowInfo);
  await execFileAsync("xdotool", ["windowactivate", "--sync", windowId]);
  await execFileAsync("xdotool", [
    "mousemove",
    String(windowInfo.contentBounds.x + point!.x),
    String(windowInfo.contentBounds.y + point!.y),
    "click",
    "1",
  ]);
  await delay(100);
  await execFileAsync("xdotool", ["click", "1"]);
  await delay(150);
  return true;
}

async function typeTerminalThroughOs(
  testApp: TestApp,
  panelId: string,
  command: string
): Promise<boolean> {
  if (!(await clickTerminalThroughOs(testApp, panelId))) return false;
  const windowInfo = await nativeWindowInfo(testApp.app);
  const windowId = await xdotoolWindowId(windowInfo);
  await execFileAsync("xdotool", ["key", "--window", windowId, "ctrl+u"]);
  await execFileAsync("xdotool", ["type", "--window", windowId, "--delay", "1", command]);
  await execFileAsync("xdotool", ["key", "--window", windowId, "Return"]);
  return true;
}

async function pressTerminalShortcutThroughOs(
  testApp: TestApp,
  panelId: string,
  key: string
): Promise<boolean> {
  if (!(await clickTerminalThroughOs(testApp, panelId))) return false;
  const windowInfo = await nativeWindowInfo(testApp.app);
  const windowId = await xdotoolWindowId(windowInfo);
  await execFileAsync("xdotool", ["key", "--window", windowId, shortcut(key).toLowerCase().replace(/\+/g, "+")]);
  return true;
}

function shortcut(key: string): string {
  return process.platform === "darwin" ? `Meta+${key}` : `Control+Shift+${key}`;
}

test.describe("Terminal Startup", () => {
  let testApp: TestApp | undefined;
  let workspacePath: string | undefined;

  test.afterEach(async () => {
    if (testApp) await testApp.cleanup();
    else if (workspacePath) removeManagedTestWorkspace(workspacePath);
    testApp = undefined;
    workspacePath = undefined;
  });

  test("opens one usable terminal after required approvals are resolved", async () => {
    test.setTimeout(240_000);
    workspacePath = createTerminalOnlyWorkspace();
    testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 90_000 });
    const { app } = testApp;
    const terminalPanelId = await waitForTerminalPanel(app, testApp.window);
    await startPanelDiagnostics(app, terminalPanelId);

    const session = await waitForUsableTerminalSession(app, terminalPanelId, testApp.window);

    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toMatch(/aria-label="Terminal input"/);

    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: session.sessionId,
      text: "echo natstack-e2e-input\r",
    });
    await expectScrollbackToContain(app, terminalPanelId, session.sessionId, "natstack-e2e-input");

    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toContain("xterm");
    expect(await clickPanelSelector(app, terminalPanelId, ".xterm")).toBe(true);
    await expect
      .poll(async () => getFocusedPanelWebContentsId(app), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(terminalPanelId);
    await typePanelText(app, terminalPanelId, "\u0015printf 'natstack-keyboard-input\\n'\r");
    await expectScrollbackToContain(app, terminalPanelId, session.sessionId, "natstack-keyboard-input");
    await expectRenderedToContain(app, terminalPanelId, session.sessionId, "natstack-keyboard-input");

    const osTyped = await typeTerminalThroughOs(
      testApp,
      terminalPanelId,
      "printf 'natstack-os-keyboard-input\\n'"
    );
    const osInputArrived = osTyped
      ? await expect
          .poll(async () => scrollbackContains(app, terminalPanelId, session.sessionId, "natstack-os-keyboard-input"), {
            timeout: 3_000,
            intervals: [250, 500],
          })
          .toBe(true)
          .then(() => true, () => false)
      : false;
    if (!osInputArrived) {
      await clickTerminalThroughWindow(testApp, terminalPanelId);
      await typePanelText(app, terminalPanelId, "\u0015printf 'natstack-os-keyboard-input\\n'\r");
    }
    await expectScrollbackToContain(app, terminalPanelId, session.sessionId, "natstack-os-keyboard-input");
    await expectRenderedToContain(app, terminalPanelId, session.sessionId, "natstack-os-keyboard-input");

    await setElectronClipboardText(app, "printf 'natstack-paste-input\\n'\n");
    const osPasteAttempted = await pressTerminalShortcutThroughOs(testApp, terminalPanelId, "v");
    const osPasteArrived = osPasteAttempted
      ? await expect
          .poll(async () => scrollbackContains(app, terminalPanelId, session.sessionId, "natstack-paste-input"), {
            timeout: 3_000,
            intervals: [250, 500],
          })
          .toBe(true)
          .then(() => true, () => false)
      : false;
    if (!osPasteArrived) {
      await clickTerminalThroughWindow(testApp, terminalPanelId);
      await typePanelText(app, terminalPanelId, "\u0015printf 'natstack-paste-input\\n'\r");
    }
    await expectScrollbackToContain(app, terminalPanelId, session.sessionId, "natstack-paste-input");

    await clickPanelSelector(app, terminalPanelId, "[aria-label='Pane menu']");
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain("Copy all");
    expect(await clickPanelText(app, terminalPanelId, "[role='menuitem']", "Copy all")).toBe(true);
    await expect
      .poll(async () => getElectronClipboardText(app), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain("natstack-paste-input");

    await clickPanelSelector(app, terminalPanelId, "[aria-label='Pane menu']");
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain("Find");
    expect(await clickPanelText(app, terminalPanelId, "[role='menuitem']", "Find")).toBe(true);
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain('placeholder="Find"');
    expect(await clickPanelSelector(app, terminalPanelId, "input[placeholder='Find']")).toBe(true);
    await typePanelText(app, terminalPanelId, "natstack-paste-input");
    await expect
      .poll(async () => getPanelHtml(app, terminalPanelId), {
        timeout: 5_000,
        intervals: [250, 500],
      })
      .toMatch(/[1-9]\d* of \d+/);
    await clickPanelSelector(app, terminalPanelId, "[aria-label='Close find']");

    const split = await callTerminalPanel<{ sessionId: string | undefined }>(
      app,
      terminalPanelId,
      "splitPane",
      { direction: "right" }
    );
    expect(split.sessionId).toBeTruthy();
    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: split.sessionId,
      text: "printf 'natstack-split-input\\n'\r",
    });
    await expectScrollbackToContain(app, terminalPanelId, split.sessionId!, "natstack-split-input");
    await expectRenderedToContain(app, terminalPanelId, split.sessionId!, "natstack-split-input");

    const tab = await callTerminalPanel<{ sessionId: string | undefined }>(
      app,
      terminalPanelId,
      "openSession",
      {}
    );
    expect(tab.sessionId).toBeTruthy();
    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: tab.sessionId,
      text: "printf 'natstack-tab-input\\n'\r",
    });
    await expectScrollbackToContain(app, terminalPanelId, tab.sessionId!, "natstack-tab-input");

    await callTerminalPanel(app, terminalPanelId, "focusSession", { sessionId: session.sessionId });
    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: session.sessionId,
      text: "printf 'http://localhost:43210\\n'\r",
    });
    await expect
      .poll(async () => {
        const sessions = await listTerminalSessions(app, terminalPanelId);
        const current = sessions.find((item) => item.sessionId === session.sessionId);
        return {
          ports: current?.detectedPorts ?? [],
          urls: current?.detectedUrls ?? [],
        };
      }, {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toMatchObject({
        ports: expect.arrayContaining([43210]),
        urls: expect.arrayContaining(["http://localhost:43210"]),
      });

    await callTerminalPanel(app, terminalPanelId, "sendText", {
      sessionId: session.sessionId,
      text: "printf '\\033]633;E;natstack-shell-integration\\007\\033]633;C\\007\\033]633;D;0\\007'\r",
    });
    await expect
      .poll(async () => {
        const sessions = await listTerminalSessions(app, terminalPanelId);
        return sessions.find((item) => item.sessionId === session.sessionId)?.meta?.["vscodeShellIntegration"];
      }, {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .toMatchObject({
        status: "vscode",
        commandLine: "natstack-shell-integration",
        commandRunning: false,
        lastExitCode: 0,
      });

    const beforeResize = (await listTerminalSessions(app, terminalPanelId)).find(
      (item) => item.sessionId === session.sessionId
    );
    await testApp.app.evaluate(({ BaseWindow, BrowserWindow }) => {
      const win = BaseWindow.getAllWindows()[0] ?? BrowserWindow.getAllWindows()[0];
      const bounds = win?.getBounds();
      if (win && bounds) win.setBounds({ ...bounds, width: bounds.width + 180, height: bounds.height + 120 });
    });
    await expect
      .poll(async () => {
        const sessions = await listTerminalSessions(app, terminalPanelId);
        const current = sessions.find((item) => item.sessionId === session.sessionId);
        return `${current?.cols ?? 0}x${current?.rows ?? 0}`;
      }, {
        timeout: 10_000,
        intervals: [250, 500, 1000],
      })
      .not.toBe(`${beforeResize?.cols ?? 0}x${beforeResize?.rows ?? 0}`);

    await reloadPanel(app, terminalPanelId);
    await expect
      .poll(
        async () => {
          await approvePendingTerminalWork(app, testApp.window).catch(() => {});
          return getPanelHtml(app, terminalPanelId).catch(() => "");
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toContain("xterm");

    const reloadedSession = await waitForUsableTerminalSession(app, terminalPanelId, testApp.window);
    expect(await clickPanelSelector(app, terminalPanelId, ".xterm")).toBe(true);
    await expect
      .poll(async () => getFocusedPanelWebContentsId(app), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(terminalPanelId);
    await typePanelText(app, terminalPanelId, "\u0003\u0015printf 'natstack-reloaded-keyboard-input\\n'\r");
    await expectScrollbackToContain(app, terminalPanelId, reloadedSession.sessionId, "natstack-reloaded-keyboard-input");
    await expectRenderedToContain(app, terminalPanelId, reloadedSession.sessionId, "natstack-reloaded-keyboard-input");

    expect(severePanelDiagnostics(await getPanelDiagnostics(app, terminalPanelId))).toEqual([]);
  });
});
