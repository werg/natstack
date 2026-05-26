import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const processMocks = vi.hoisted(() => ({
  createProcessAdapter: vi.fn(),
}));

vi.mock("@natstack/process-adapter", () => ({
  createProcessAdapter: processMocks.createProcessAdapter,
}));

import { TerminalAppRunner } from "./terminalAppRunner.js";

class MockProcess extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid = 1234;
  killed = false;
  messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null);
    return true;
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  processMocks.createProcessAdapter.mockReset();
});

function tempBuild() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-terminal-runner-"));
  roots.push(root);
  const dir = path.join(root, "build");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.mjs"), "console.log('terminal app');\n");
  return {
    dir,
    metadata: { ev: "ev-cli" },
    artifacts: [{ path: "index.mjs", role: "primary" }],
  };
}

describe("TerminalAppRunner", () => {
  it("launches terminal app artifacts with app principal bootstrap env", async () => {
    const proc = new MockProcess();
    processMocks.createProcessAdapter.mockReturnValue(proc);
    const statuses: unknown[] = [];
    const logs: unknown[] = [];
    const grants = {
      grant: vi.fn(() => ({ token: "grant-token", expiresAt: Date.now() + 1000 })),
      revokeForPrincipal: vi.fn(),
    };
    const runner = new TerminalAppRunner({
      connectionGrants: grants,
      onStatus: (appId, status, error) => statuses.push({ appId, status, error }),
      onLog: (appId, level, message, source) => logs.push({ appId, level, message, source }),
    });

    await runner.start({
      appId: "@workspace-apps/remote-cli",
      source: "apps/remote-cli",
      buildKey: "build-cli",
      effectiveVersion: "ev-cli",
      gatewayUrl: "http://127.0.0.1:1234",
      build: tempBuild(),
    });

    expect(grants.grant).toHaveBeenCalledWith(
      "@workspace-apps/remote-cli",
      "terminal-app-runner",
      expect.any(Number)
    );
    expect(processMocks.createProcessAdapter).toHaveBeenCalledWith(
      expect.stringMatching(/index\.mjs$/),
      expect.objectContaining({
        NATSTACK_TERMINAL_APP_ID: "@workspace-apps/remote-cli",
        NATSTACK_TERMINAL_APP_SOURCE: "apps/remote-cli",
        NATSTACK_TERMINAL_APP_BUILD_KEY: "build-cli",
        NATSTACK_TERMINAL_APP_EFFECTIVE_VERSION: "ev-cli",
        NATSTACK_TERMINAL_APP_GATEWAY_URL: "http://127.0.0.1:1234",
        NATSTACK_TERMINAL_APP_RPC_TOKEN: "grant-token",
        NATSTACK_TERMINAL_APP_CONNECTION_ID: "terminal:@workspace-apps/remote-cli:build-cli",
      }),
      { preferNode: true }
    );
    expect(statuses).toContainEqual({
      appId: "@workspace-apps/remote-cli",
      status: "running",
      error: null,
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        appId: "@workspace-apps/remote-cli",
        level: "info",
        source: "runner",
      })
    );
  });

  it("marks unexpected exits as errors and revokes app grants", async () => {
    const proc = new MockProcess();
    processMocks.createProcessAdapter.mockReturnValue(proc);
    const statuses: unknown[] = [];
    const grants = {
      grant: vi.fn(() => ({ token: "grant-token", expiresAt: Date.now() + 1000 })),
      revokeForPrincipal: vi.fn(),
    };
    const runner = new TerminalAppRunner({
      connectionGrants: grants,
      onStatus: (appId, status, error) => statuses.push({ appId, status, error }),
      onLog: vi.fn(),
    });
    await runner.start({
      appId: "@workspace-apps/remote-cli",
      source: "apps/remote-cli",
      buildKey: "build-cli",
      effectiveVersion: "ev-cli",
      gatewayUrl: "http://127.0.0.1:1234",
      build: tempBuild(),
    });

    proc.emit("exit", 7);

    expect(grants.revokeForPrincipal).toHaveBeenCalledWith("@workspace-apps/remote-cli");
    expect(statuses).toContainEqual({
      appId: "@workspace-apps/remote-cli",
      status: "error",
      error: "Terminal app exited with code 7",
    });
  });
});
