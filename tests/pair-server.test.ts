// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { runPairServer } from "../scripts/cli/lib/pair-server.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals | string) => {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  });
}

const config = {
  commandName: "pair-test",
  usage: ["pair-test"],
  logPrefix: "pair-test",
  hostEnv: ["NATSTACK_PAIR_TEST_HOST"],
  portEnv: ["NATSTACK_PAIR_TEST_PORT"],
  devEnv: "NATSTACK_PAIR_TEST_DEV",
  restartCommand: "pnpm pair-test",
  bannerTitle: "Pair Test",
  deepLinkLabel: "Deep link",
  instructions: "Pair from test.",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pair-server runner", () => {
  it("prints the pairing banner from the structured ready file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";

    runPairServer(config, ["--host", "127.0.0.1", "--port", "3456"], {
      spawnServer({ serverArgs }: { serverArgs: string[] }) {
        const readyIndex = serverArgs.indexOf("--ready-file");
        readyFile = serverArgs[readyIndex + 1] ?? "";
        setTimeout(() => {
          fs.writeFileSync(
            readyFile,
            JSON.stringify({
              connectUrl: "http://127.0.0.1:3456",
              pairingCode: "PAIRING_READY_CODE_123",
              qrPairingCode: "PAIRING_QR_CODE_123",
            })
          );
        }, 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => logText(logSpy).includes("PAIRING_READY_CODE_123"));
    const output = logText(logSpy);
    expect(output).toContain("Pair Test");
    expect(output).toContain("Gateway:    http://127.0.0.1:3456");
    expect(output).toContain("Pair code:  PAIRING_READY_CODE_123");
    expect(output).toContain("QR code:    PAIRING_QR_CODE_123");
    expect(output).toContain(
      "natstack://connect?url=http%3A%2F%2F127.0.0.1%3A3456&code=PAIRING_READY_CODE_123"
    );
    expect(output).toContain(
      "natstack://connect?url=http%3A%2F%2F127.0.0.1%3A3456&code=PAIRING_QR_CODE_123"
    );

    child.emit("exit", 0, null);
    expect(fs.existsSync(path.dirname(readyFile))).toBe(false);
  });

  it("polls a custom server --ready-file instead of an unused generated file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    const readyDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-pair-custom-"));
    const readyFile = path.join(readyDir, "server-ready.json");
    try {
      runPairServer(config, ["--host", "127.0.0.1", "--port", "3456"], {
        buildServerArgs() {
          return ["dist/server.mjs", "--ready-file", readyFile];
        },
        spawnServer({ serverArgs }: { serverArgs: string[] }) {
          expect(serverArgs).toEqual(["dist/server.mjs", "--ready-file", readyFile]);
          setTimeout(() => {
            fs.writeFileSync(
              readyFile,
              JSON.stringify({
                connectUrl: "http://127.0.0.1:3456",
                pairingCode: "PAIRING_CUSTOM_CODE_123",
              })
            );
          }, 10);
          return child;
        },
        onChildExit: () => true,
      });

      await waitFor(() => logText(logSpy).includes("PAIRING_CUSTOM_CODE_123"));
      child.emit("exit", 0, null);
      expect(fs.existsSync(readyDir)).toBe(true);
    } finally {
      fs.rmSync(readyDir, { recursive: true, force: true });
    }
  });

  it("waits briefly for a QR-specific pairing code when reading stdout", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const child = new FakeChild();

    runPairServer(config, ["--host", "127.0.0.1", "--port", "3456"], {
      spawnServer() {
        setTimeout(() => {
          child.stdout.write("Mobile URL: http://127.0.0.1:3456\n");
          child.stdout.write("Pairing code: PAIRING_STDOUT_CODE_123\n");
          child.stdout.write("QR pairing code: PAIRING_STDOUT_QR_123\n");
        }, 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => logText(logSpy).includes("PAIRING_STDOUT_QR_123"));
    const output = logText(logSpy);
    expect(output).toContain(
      "natstack://connect?url=http%3A%2F%2F127.0.0.1%3A3456&code=PAIRING_STDOUT_CODE_123"
    );
    expect(output).toContain(
      "natstack://connect?url=http%3A%2F%2F127.0.0.1%3A3456&code=PAIRING_STDOUT_QR_123"
    );

    child.emit("exit", 0, null);
  });

  it("uses the live TypeScript server entry when requested", async () => {
    vi.stubEnv("NATSTACK_SERVER_ENTRY", "live");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();

    runPairServer(config, ["--host", "127.0.0.1", "--port", "3456"], {
      spawnServer({
        serverArgs,
        invocation,
      }: {
        serverArgs: string[];
        invocation: { command: string; args: string[] };
      }) {
        expect(serverArgs[0]).toBe("src/server/index.ts");
        const pnpmExecutable =
          invocation.command === process.execPath ? invocation.args[0] : invocation.command;
        expect(path.basename(pnpmExecutable ?? "")).toMatch(/^pnpm(\.(cmd|cjs|js|mjs))?$/);
        const pnpmArgs =
          invocation.command === process.execPath ? invocation.args.slice(1) : invocation.args;
        expect(pnpmArgs).toEqual(["exec", "tsx", ...serverArgs]);
        setTimeout(() => child.emit("exit", 0, null), 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => child.listenerCount("exit") > 0);
    child.emit("exit", 0, null);
  });
});

function logText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .flat()
    .map((value) => String(value))
    .join("\n");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
