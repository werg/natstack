import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedNotification } from "./notificationParser.js";
import { VscodeTerminalInstance } from "./vscodeTerminalInstance.js";
import type { TerminalFrontend, TerminalFrontendFactory } from "./terminalFrontend.js";
import type { ShellApi } from "./types.js";
import type { VscodeShellIntegrationEvent } from "./vscodeShellIntegration.js";

const attachWithScrollback = vi.fn();

vi.mock("./shellAttach.js", () => ({
  attachWithScrollback: (...args: unknown[]) => attachWithScrollback(...args),
}));

describe("VscodeTerminalInstance", () => {
  beforeEach(() => {
    vi.useRealTimers();
    attachWithScrollback.mockReset();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
  });

  it("routes frontend input to the owning shell session", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    attachWithScrollback.mockResolvedValue(responseFromChunks([]));
    const instance = createInstance({ frontend, shell, sessionId: "session-a" });

    await instance.attach(hostElement());
    frontend.emitInput("echo hello\r");

    expect(shell.write).toHaveBeenCalledWith("session-a", "echo hello\r");
  });

  it("writes attached output to the frontend and parses notifications", async () => {
    vi.useFakeTimers();
    const frontend = createFakeFrontend();
    const shell = createShell();
    const onNotification = vi.fn();
    attachWithScrollback.mockResolvedValue(
      responseFromChunks([encoder.encode("ready\x1b]9;[done] complete\x07\n")])
    );
    const instance = createInstance({ frontend, shell, onNotification });

    await instance.attach(hostElement());
    await vi.advanceTimersByTimeAsync(8);

    expect(textFromWrites(frontend.writes)).toContain("ready");
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "done", message: "complete" })
    );
  });

  it("keeps focus, fit, theme, find, and selection behind the frontend boundary", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    attachWithScrollback.mockResolvedValue(responseFromChunks([]));
    const instance = createInstance({ frontend, shell, focused: true });

    await instance.attach(hostElement());
    instance.fit();
    instance.setTheme(theme("next"));
    instance.findNext("abc", { caseSensitive: true });
    instance.selectAll();

    expect(frontend.focus).toHaveBeenCalledTimes(1);
    expect(frontend.fit).toHaveBeenCalledTimes(1);
    expect(frontend.setTheme).toHaveBeenCalledWith(theme("next"));
    expect(frontend.findNext).toHaveBeenCalledWith("abc", { caseSensitive: true });
    expect(frontend.selectAll).toHaveBeenCalledTimes(1);
  });

  it("contains frontend dispose failures during unmount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const frontend = createFakeFrontend();
    frontend.dispose.mockImplementation(() => {
      throw new Error("dispose failed");
    });
    const shell = createShell();
    attachWithScrollback.mockResolvedValue(responseFromChunks([]));
    const instance = createInstance({ frontend, shell });

    await instance.attach(hostElement());

    expect(() => instance.dispose()).not.toThrow();
    expect(warn).toHaveBeenCalledWith("Terminal cleanup failed", expect.any(Error));
    warn.mockRestore();
  });

  it("forwards frontend shell integration events through the instance boundary", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    const onShellIntegrationEvent = vi.fn();
    attachWithScrollback.mockResolvedValue(responseFromChunks([]));
    const instance = createInstance({ frontend, shell, onShellIntegrationEvent });

    await instance.attach(hostElement());
    frontend.emitShellIntegrationEvent({ type: "cwd", source: "vscode", cwd: "/repo" });

    expect(onShellIntegrationEvent).toHaveBeenCalledWith({
      type: "cwd",
      source: "vscode",
      cwd: "/repo",
    });
  });

  it("forwards frontend line data through the instance boundary", async () => {
    const frontend = createFakeFrontend();
    const shell = createShell();
    const onLineData = vi.fn();
    attachWithScrollback.mockResolvedValue(responseFromChunks([]));
    const instance = createInstance({ frontend, shell, onLineData });

    await instance.attach(hostElement());
    frontend.emitLineData("build complete");

    expect(onLineData).toHaveBeenCalledWith("build complete");
  });
});

const encoder = new TextEncoder();

function createInstance(opts: {
  frontend: FakeFrontend;
  shell: ShellApi;
  sessionId?: string;
  focused?: boolean;
  onNotification?: (notification: ParsedNotification) => void;
  onShellIntegrationEvent?: (event: VscodeShellIntegrationEvent) => void;
  onLineData?: (line: string) => void;
}): VscodeTerminalInstance {
  const frontendFactory: TerminalFrontendFactory = vi.fn(async () => opts.frontend);
  return new VscodeTerminalInstance({
    sessionId: opts.sessionId ?? "session-1",
    shell: opts.shell,
    frontendFactory,
    fontFamily: "monospace",
    fontSize: 13,
    theme: theme("base"),
    focused: opts.focused ?? false,
    onError: vi.fn(),
    onNotification: opts.onNotification ?? vi.fn(),
    onShellIntegrationEvent: opts.onShellIntegrationEvent,
    onLineData: opts.onLineData,
  });
}

function hostElement(): HTMLElement {
  return {} as HTMLElement;
}

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    })
  );
}

function createShell(): ShellApi {
  return {
    exec: vi.fn(),
    open: vi.fn(),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    getSessionInfo: vi.fn(),
    watchSessionInfo: vi.fn(),
    attach: vi.fn(),
    awaitExit: vi.fn(),
    getScrollback: vi.fn(),
  } as unknown as ShellApi;
}

type FakeFrontend = TerminalFrontend & {
  writes: Uint8Array[];
  emitInput(data: string): void;
  emitResize(size: { cols: number; rows: number }): void;
  emitShellIntegrationEvent(event: VscodeShellIntegrationEvent): void;
  emitLineData(line: string): void;
  focus: ReturnType<typeof vi.fn>;
  fit: ReturnType<typeof vi.fn>;
  setTheme: ReturnType<typeof vi.fn>;
  findNext: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

function createFakeFrontend(): FakeFrontend {
  let input: ((data: string) => void) | undefined;
  let resize: ((size: { cols: number; rows: number }) => void) | undefined;
  let shellIntegrationEvent: ((event: VscodeShellIntegrationEvent) => void) | undefined;
  let lineData: ((line: string) => void) | undefined;
  const writes: Uint8Array[] = [];
  return {
    writes,
    open: vi.fn(),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      callback?.();
    }),
    onInput: vi.fn((cb) => {
      input = cb;
      return { dispose: vi.fn() };
    }),
    onResize: vi.fn((cb) => {
      resize = cb;
      return { dispose: vi.fn() };
    }),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onShellIntegrationEvent: vi.fn((cb) => {
      shellIntegrationEvent = cb;
      return { dispose: vi.fn() };
    }),
    onLineData: vi.fn((cb) => {
      lineData = cb;
      return { dispose: vi.fn() };
    }),
    fit: vi.fn(),
    focus: vi.fn(),
    setTheme: vi.fn(),
    getSelection: vi.fn(() => "selection"),
    selectAll: vi.fn(),
    scrollToBottom: vi.fn(),
    isScrolledUp: vi.fn(() => false),
    getBufferLength: vi.fn(() => 0),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearSearch: vi.fn(),
    serialize: vi.fn(() => textFromWrites(writes)),
    dispose: vi.fn(),
    emitInput(data: string) {
      input?.(data);
    },
    emitResize(size: { cols: number; rows: number }) {
      resize?.(size);
    },
    emitShellIntegrationEvent(event: VscodeShellIntegrationEvent) {
      shellIntegrationEvent?.(event);
    },
    emitLineData(line: string) {
      lineData?.(line);
    },
  };
}

function textFromWrites(writes: Uint8Array[]): string {
  return writes.map((chunk) => new TextDecoder().decode(chunk)).join("");
}

function theme(seed: string) {
  return {
    background: seed,
    foreground: seed,
    cursor: seed,
    selectionBackground: seed,
    black: seed,
    red: seed,
    green: seed,
    yellow: seed,
    blue: seed,
    magenta: seed,
    cyan: seed,
    white: seed,
    brightBlack: seed,
    brightRed: seed,
    brightGreen: seed,
    brightYellow: seed,
    brightBlue: seed,
    brightMagenta: seed,
    brightCyan: seed,
    brightWhite: seed,
  };
}
