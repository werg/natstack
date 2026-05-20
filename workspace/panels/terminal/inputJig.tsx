import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { createVscodeTerminalFrontend } from "./vscodeTerminalFrontend.js";
import { VscodeTerminalInstance } from "./vscodeTerminalInstance.js";
import { resolveTerminalTheme } from "./paneTheme.js";
import type { SessionInfo, ShellApi } from "./types.js";

type JigEvent = {
  at: number;
  kind: "focus" | "blur" | "keydown" | "write" | "resize" | "attach" | "error";
  value: string;
};

type JigState = {
  events: JigEvent[];
  writes: string[];
  activeElement: string;
  xtermTextareaFocused: boolean;
};

class JigShell implements ShellApi {
  readonly session: SessionInfo = {
    sessionId: "jig-session",
    label: "Input Jig",
    command: { argv: ["jig"], cwd: "/tmp" },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: Date.now(),
    bytesOut: 0,
    meta: {},
  };

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();

  constructor(private readonly onEvent: (event: JigEvent) => void) {}

  async exec(): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async open(): Promise<{ sessionId: string }> {
    return { sessionId: this.session.sessionId };
  }

  async write(_sessionId: string, data: string): Promise<void> {
    this.onEvent({ at: Date.now(), kind: "write", value: data });
    this.controller?.enqueue(this.encoder.encode(data));
  }

  async resize(_sessionId: string, cols: number, rows: number): Promise<void> {
    this.session.cols = cols;
    this.session.rows = rows;
    this.onEvent({ at: Date.now(), kind: "resize", value: `${cols}x${rows}` });
  }

  async kill(): Promise<void> {}

  async list(): Promise<SessionInfo[]> {
    return [this.session];
  }

  async get(): Promise<SessionInfo> {
    return this.session;
  }

  async getSessionInfo(): Promise<SessionInfo> {
    return this.session;
  }

  async watchSessionInfo(): Promise<Response> {
    return new Response(new ReadableStream<Uint8Array>());
  }

  async attach(): Promise<Response> {
    this.onEvent({ at: Date.now(), kind: "attach", value: this.session.sessionId });
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
          controller.enqueue(
            this.encoder.encode(
              "terminal input jig ready\r\nclick the terminal, type, and watch the write log\r\n$ "
            )
          );
        },
        cancel: () => {
          this.controller = null;
        },
      })
    );
  }

  async awaitExit(): Promise<{ exitCode: number | null }> {
    return { exitCode: null };
  }

  async getScrollback(): Promise<{ text: string; cursor: string }> {
    return { text: "", cursor: "0" };
  }
}

function activeElementLabel(): string {
  const active = document.activeElement;
  if (!active) return "<none>";
  const classes =
    active instanceof HTMLElement && active.className ? `.${String(active.className).trim()}` : "";
  return `${active.tagName.toLowerCase()}${classes}`;
}

function isXtermTextareaFocused(): boolean {
  return document.activeElement instanceof HTMLTextAreaElement
    && document.activeElement.classList.contains("xterm-helper-textarea");
}

function InputJig() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<VscodeTerminalInstance | null>(null);
  const [state, setState] = useState<JigState>({
    events: [],
    writes: [],
    activeElement: activeElementLabel(),
    xtermTextareaFocused: isXtermTextareaFocused(),
  });

  const appendEvent = (event: JigEvent) => {
    setState((prev) => ({
      activeElement: activeElementLabel(),
      xtermTextareaFocused: isXtermTextareaFocused(),
      writes: event.kind === "write" ? [...prev.writes, event.value] : prev.writes,
      events: [...prev.events, event].slice(-80),
    }));
  };

  const shell = useMemo(() => new JigShell(appendEvent), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new VscodeTerminalInstance({
      sessionId: shell.session.sessionId,
      shell,
      frontendFactory: createVscodeTerminalFrontend,
      fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
      fontSize: 14,
      theme: resolveTerminalTheme("dark", host),
      focused: true,
      onError: (message) => appendEvent({ at: Date.now(), kind: "error", value: message }),
      onNotification: () => {},
    });
    terminalRef.current = terminal;
    void terminal.attach(host);

    return () => {
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [shell]);

  useEffect(() => {
    const updateActive = () =>
      setState((prev) => ({
        ...prev,
        activeElement: activeElementLabel(),
        xtermTextareaFocused: isXtermTextareaFocused(),
      }));
    const onKeyDown = (event: KeyboardEvent) => {
      appendEvent({
        at: Date.now(),
        kind: "keydown",
        value: `${event.key} target=${activeElementLabel()}`,
      });
    };
    window.addEventListener("focusin", updateActive);
    window.addEventListener("focusout", updateActive);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("focusin", updateActive);
      window.removeEventListener("focusout", updateActive);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    window.__terminalInputJig = {
      focusTerminal: () => terminalRef.current?.focus(),
      focusTextarea: () => {
        const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        textarea?.focus();
      },
      snapshot: () => state,
    };
  }, [state]);

  return (
    <Theme appearance="dark" accentColor="blue" grayColor="slate" radius="small">
      <main className="jig-shell">
        <section className="terminal-region">
          <div className="toolbar">
            <button type="button" onClick={() => terminalRef.current?.focus()}>
              Focus terminal
            </button>
            <input placeholder="control input" aria-label="control input" />
            <span>
              active: {state.activeElement} xterm textarea:{" "}
              {state.xtermTextareaFocused ? "focused" : "not focused"}
            </span>
          </div>
          <div ref={hostRef} className="terminal-host" />
        </section>
        <aside className="event-log">
          <h1>Terminal Input Jig</h1>
          <p>
            The terminal uses a fake shell. If typing works, every key appears in the write log and
            echoes back into xterm.
          </p>
          <h2>Writes</h2>
          <pre data-testid="writes">
            {state.writes.map((write) => JSON.stringify(write)).join("\n") || "<none>"}
          </pre>
          <h2>Events</h2>
          <pre data-testid="events">
            {state.events
              .map((event) => `${new Date(event.at).toISOString()} ${event.kind} ${event.value}`)
              .join("\n") || "<none>"}
          </pre>
        </aside>
      </main>
    </Theme>
  );
}

declare global {
  interface Window {
    __terminalInputJig?: {
      focusTerminal(): void;
      focusTextarea(): void;
      snapshot(): JigState;
    };
  }
}

createRoot(document.getElementById("root") ?? document.body).render(<InputJig />);
