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
  it("prints the WebRTC pairing banner from the structured ready file", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";

    runPairServer(config, ["--port", "3456"], {
      spawnServer({ serverArgs }: { serverArgs: string[] }) {
        const readyIndex = serverArgs.indexOf("--ready-file");
        readyFile = serverArgs[readyIndex + 1] ?? "";
        setTimeout(() => {
          fs.writeFileSync(
            readyFile,
            JSON.stringify({
              pairing: {
                room: "room-ready-7f3a9c2b",
                fp: "4f8b2a1c9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
                sig: "wss://signal.natstack.dev",
              },
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
    expect(output).toContain("Room:");
    expect(output).toContain("room-ready-7f3a9c2b");
    expect(output).toContain("Fingerprint:");
    expect(output).toContain(
      "4f8b2a1c9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a"
    );
    expect(output).toContain("Signaling:");
    expect(output).toContain("wss://signal.natstack.dev");
    expect(output).toMatch(/Pair code:\s+PAIRING_READY_CODE_123/);
    expect(output).toMatch(/QR code:\s+PAIRING_QR_CODE_123/);
    expect(output).toContain(
      "natstack://connect?room=room-ready-7f3a9c2b&fp=4f8b2a1c9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a&code=PAIRING_READY_CODE_123&sig=wss%3A%2F%2Fsignal.natstack.dev&v=1&ice=all"
    );
    expect(output).toContain(
      "natstack://connect?room=room-ready-7f3a9c2b&fp=4f8b2a1c9d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a&code=PAIRING_QR_CODE_123&sig=wss%3A%2F%2Fsignal.natstack.dev&v=1&ice=all"
    );
    expect(output).toContain("Pair from test.");

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
      runPairServer(config, ["--port", "3456"], {
        buildServerArgs() {
          return ["dist/server.mjs", "--ready-file", readyFile];
        },
        spawnServer({ serverArgs }: { serverArgs: string[] }) {
          expect(serverArgs).toEqual(["dist/server.mjs", "--ready-file", readyFile]);
          setTimeout(() => {
            fs.writeFileSync(
              readyFile,
              JSON.stringify({
                pairing: {
                  room: "room-custom-1a2b3c4d",
                  fp: "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66",
                  sig: "ws://127.0.0.1:8787",
                },
                pairingCode: "PAIRING_CUSTOM_CODE_123",
              })
            );
          }, 10);
          return child;
        },
        onChildExit: () => true,
      });

      await waitFor(() => logText(logSpy).includes("PAIRING_CUSTOM_CODE_123"));
      const output = logText(logSpy);
      expect(output).toMatch(/Pair code:\s+PAIRING_CUSTOM_CODE_123/);
      expect(output).toContain(
        "natstack://connect?room=room-custom-1a2b3c4d&fp=aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66&code=PAIRING_CUSTOM_CODE_123&sig=ws%3A%2F%2F127.0.0.1%3A8787&v=1&ice=all"
      );
      child.emit("exit", 0, null);
      expect(fs.existsSync(readyDir)).toBe(true);
    } finally {
      fs.rmSync(readyDir, { recursive: true, force: true });
    }
  });

  it("passes remote-serve readiness gates through to the server and prints the pairing banner", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();
    let readyFile = "";

    runPairServer(
      {
        ...config,
        commandName: "natstack remote serve",
        requireMobileReady: true,
        requireElectronReady: true,
      },
      ["--port", "3456"],
      {
        spawnServer({ serverArgs }: { serverArgs: string[] }) {
          expect(serverArgs).toContain("--require-mobile-ready");
          expect(serverArgs).toContain("--require-electron-ready");
          const readyIndex = serverArgs.indexOf("--ready-file");
          readyFile = serverArgs[readyIndex + 1] ?? "";
          setTimeout(() => {
            fs.writeFileSync(
              readyFile,
              JSON.stringify({
                pairing: {
                  room: "room-remote-9z8y7x6w",
                  fp: "11aa22bb33cc44dd55ee66ff77001122334455667788990011223344556677ab",
                  sig: "wss://signal.example.org",
                },
                pairingCode: "PAIRING_REMOTE_CODE_123",
                qrPairingCode: "PAIRING_REMOTE_QR_123",
              })
            );
          }, 10);
          return child;
        },
        onChildExit: () => true,
      }
    );

    await waitFor(() => logText(logSpy).includes("PAIRING_REMOTE_CODE_123"));
    const output = logText(logSpy);
    expect(output).toContain("Signaling:");
    expect(output).toContain("wss://signal.example.org");
    expect(output).toMatch(/Pair code:\s+PAIRING_REMOTE_CODE_123/);
    expect(output).toContain(
      "natstack://connect?room=room-remote-9z8y7x6w&fp=11aa22bb33cc44dd55ee66ff77001122334455667788990011223344556677ab&code=PAIRING_REMOTE_CODE_123&sig=wss%3A%2F%2Fsignal.example.org&v=1&ice=all"
    );
    expect(output).toContain(
      "natstack://connect?room=room-remote-9z8y7x6w&fp=11aa22bb33cc44dd55ee66ff77001122334455667788990011223344556677ab&code=PAIRING_REMOTE_QR_123&sig=wss%3A%2F%2Fsignal.example.org&v=1&ice=all"
    );

    child.emit("exit", 0, null);
  });

  it("rejects raw server flag forwarding", () => {
    expect(() =>
      runPairServer(config, ["--", "--workspace", "dev"], {
        spawnServer() {
          throw new Error("should not spawn");
        },
      })
    ).toThrow(/Forwarding raw server flags is no longer supported/);
  });

  it("reads pairing material and a distinct QR pairing code from stdout", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const child = new FakeChild();

    runPairServer(config, ["--port", "3456"], {
      spawnServer() {
        setTimeout(() => {
          child.stdout.write("NATSTACK_PAIRING_ROOM=room-stdout-5q6r7s8t\n");
          child.stdout.write(
            "NATSTACK_PAIRING_FP=deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb\n"
          );
          child.stdout.write("NATSTACK_PAIRING_SIG=wss://signal.stdout.test\n");
          // The QR-specific code arrives before the primary code; the banner only
          // prints once room/fp/sig + a pairing code are all present, so by then
          // both deep links carry their respective codes.
          child.stdout.write("QR pairing code: PAIRING_STDOUT_QR_123\n");
          child.stdout.write("Pairing code: PAIRING_STDOUT_CODE_123\n");
        }, 10);
        return child;
      },
      onChildExit: () => true,
    });

    await waitFor(() => logText(logSpy).includes("PAIRING_STDOUT_QR_123"));
    const output = logText(logSpy);
    expect(output).toContain(
      "natstack://connect?room=room-stdout-5q6r7s8t&fp=deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb&code=PAIRING_STDOUT_CODE_123&sig=wss%3A%2F%2Fsignal.stdout.test&v=1&ice=all"
    );
    expect(output).toContain(
      "natstack://connect?room=room-stdout-5q6r7s8t&fp=deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb&code=PAIRING_STDOUT_QR_123&sig=wss%3A%2F%2Fsignal.stdout.test&v=1&ice=all"
    );

    child.emit("exit", 0, null);
  });

  it("uses the live TypeScript server entry when requested", async () => {
    vi.stubEnv("NATSTACK_SERVER_ENTRY", "live");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const child = new FakeChild();

    runPairServer(config, ["--port", "3456"], {
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

  it("rejects --host as no longer supported (loopback-only WebRTC cutover)", () => {
    expect(() =>
      runPairServer(config, ["--host", "127.0.0.1"], {
        spawnServer() {
          throw new Error("should not spawn");
        },
      })
    ).toThrow(/--host is no longer supported; remote reach is WebRTC and the server binds loopback only/);
  });

  it("rejects --protocol as no longer supported (loopback-only WebRTC cutover)", () => {
    expect(() =>
      runPairServer(config, ["--protocol", "https"], {
        spawnServer() {
          throw new Error("should not spawn");
        },
      })
    ).toThrow(/--protocol is no longer supported; remote reach is WebRTC and the server binds loopback only/);
  });

  it("rejects --public-url as no longer supported (loopback-only WebRTC cutover)", () => {
    expect(() =>
      runPairServer(config, ["--public-url", "https://example.org"], {
        spawnServer() {
          throw new Error("should not spawn");
        },
      })
    ).toThrow(/--public-url is no longer supported; remote reach is WebRTC and the server binds loopback only/);
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
