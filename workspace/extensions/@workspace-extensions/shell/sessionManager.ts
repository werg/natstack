import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { OpenRequest, ScrollCursor, SessionInfo } from "./types.js";

type PtyProcess = {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

type Listener = (chunk: Uint8Array | null) => void;

interface Session {
  id: string;
  ownerCallerId: string;
  ownerKind: string;
  label: string;
  command: { argv: string[]; cwd: string };
  pid: number;
  cols: number;
  rows: number;
  startedAt: number;
  lastActivityAt: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  pty?: PtyProcess;
  child?: ChildProcessWithoutNullStreams;
  chunks: Array<{ start: number; end: number; bytes: Uint8Array }>;
  cursor: number;
  listeners: Set<Listener>;
  exitWaiters: Array<(value: { exitCode: number | null; signal?: string }) => void>;
}

const SCROLLBACK_BYTES = 256 * 1024;

function loadNodePty(): { spawn: (file: string, args: string[], opts: unknown) => PtyProcess } | null {
  try {
    const req = createRequire(import.meta.url);
    return req("node-pty") as { spawn: (file: string, args: string[], opts: unknown) => PtyProcess };
  } catch {
    return null;
  }
}

function cursorFrom(value: ScrollCursor | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private readonly pty = loadNodePty();

  get ptyAvailable(): boolean {
    return !!this.pty;
  }

  open(req: Omit<OpenRequest, "cwd" | "env"> & { cwd: string; env: NodeJS.ProcessEnv }, owner: { callerId: string; callerKind: string }): { sessionId: string } {
    const id = randomUUID();
    const command = req.command ?? process.env["SHELL"] ?? "/bin/bash";
    const args = req.args ?? [];
    const label = req.label ?? [command, ...args].join(" ");
    const session: Session = {
      id,
      ownerCallerId: owner.callerId,
      ownerKind: owner.callerKind,
      label,
      command: { argv: [command, ...args], cwd: req.cwd },
      pid: -1,
      cols: req.cols,
      rows: req.rows,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      alive: true,
      chunks: [],
      cursor: 0,
      listeners: new Set(),
      exitWaiters: [],
    };

    if (this.pty) {
      const pty = this.pty.spawn(command, args, {
        name: "xterm-256color",
        cols: req.cols,
        rows: req.rows,
        cwd: req.cwd,
        env: req.env,
      });
      session.pid = pty.pid;
      session.pty = pty;
      pty.onData((data) => this.record(session, Buffer.from(data)));
      pty.onExit((event) => this.markExit(session, event.exitCode, event.signal ? `SIG${event.signal}` : undefined));
    } else {
      const child = spawn(command, args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      session.pid = child.pid ?? -1;
      session.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.record(session, chunk));
      child.stderr.on("data", (chunk: Buffer) => this.record(session, chunk));
      child.on("close", (code, signal) => this.markExit(session, code, signal ?? undefined));
    }
    this.sessions.set(id, session);
    return { sessionId: id };
  }

  requireOwner(sessionId: string, ownerCallerId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Unknown session"), { code: "ENOENT" });
    if (session.ownerCallerId !== ownerCallerId) {
      throw Object.assign(new Error("Not the session owner"), { code: "EACCES" });
    }
    return session;
  }

  list(ownerCallerId: string): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((session) => session.ownerCallerId === ownerCallerId)
      .map((session) => this.info(session));
  }

  info(session: Session): SessionInfo {
    return {
      sessionId: session.id,
      ownerCallerId: session.ownerCallerId,
      label: session.label,
      command: session.command,
      pid: session.pid,
      pgid: session.pid,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      alive: session.alive,
      ...(session.exit ? { exit: session.exit } : {}),
      processTree: [],
      listeningPorts: [],
      detectedAgent: detectAgent(session.command.argv),
    };
  }

  write(session: Session, data: string): void {
    session.pty?.write(data);
    session.child?.stdin.write(data);
  }

  resize(session: Session, cols: number, rows: number): void {
    session.cols = cols;
    session.rows = rows;
    session.pty?.resize(cols, rows);
  }

  kill(session: Session, signal: NodeJS.Signals = "SIGTERM"): void {
    session.pty?.kill(signal);
    session.child?.kill(signal);
  }

  getScrollback(session: Session, maxBytes = SCROLLBACK_BYTES): { text: string; cursor: ScrollCursor } {
    const start = Math.max(0, session.cursor - maxBytes);
    const parts = session.chunks
      .filter((chunk) => chunk.end > start)
      .map((chunk) => chunk.start < start ? chunk.bytes.subarray(start - chunk.start) : chunk.bytes);
    return {
      text: Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8"),
      cursor: String(session.cursor),
    };
  }

  attach(session: Session, opts?: { after?: ScrollCursor }): Response {
    const after = cursorFrom(opts?.after);
    const startCursor = after ?? session.cursor;
    const replay = session.chunks
      .filter((chunk) => chunk.end > startCursor)
      .map((chunk) => chunk.start < startCursor ? chunk.bytes.subarray(startCursor - chunk.start) : chunk.bytes);
    let listener: Listener | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const bytes of replay) controller.enqueue(bytes);
        if (!session.alive) {
          controller.close();
          return;
        }
        listener = (chunk) => {
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        };
        session.listeners.add(listener);
      },
      cancel: () => {
        if (listener) session.listeners.delete(listener);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  awaitExit(session: Session): Promise<{ exitCode: number | null; signal?: string }> {
    if (!session.alive) return Promise.resolve({ exitCode: session.exit?.code ?? null, signal: session.exit?.signal });
    return new Promise((resolve) => session.exitWaiters.push(resolve));
  }

  watchInfo(session: Session): Response {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = () => controller.enqueue(encoder.encode(`${JSON.stringify(this.info(session))}\n`));
        send();
        timer = setInterval(send, 1000);
      },
      cancel: () => {
        if (timer) clearInterval(timer);
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  }

  private record(session: Session, bytes: Uint8Array): void {
    const chunk = new Uint8Array(bytes);
    const start = session.cursor;
    session.cursor += chunk.byteLength;
    session.lastActivityAt = Date.now();
    session.chunks.push({ start, end: session.cursor, bytes: chunk });
    while (session.chunks.length && session.chunks[0]!.end < session.cursor - SCROLLBACK_BYTES) {
      session.chunks.shift();
    }
    for (const listener of session.listeners) listener(chunk);
  }

  private markExit(session: Session, code: number | null, signal?: string): void {
    session.alive = false;
    session.exit = { code, ...(signal ? { signal } : {}), at: Date.now() };
    for (const waiter of session.exitWaiters.splice(0)) waiter({ exitCode: code, signal });
    for (const listener of session.listeners) listener(null);
    session.listeners.clear();
  }
}

function detectAgent(argv: string[]): SessionInfo["detectedAgent"] {
  const joined = argv.join(" ");
  if (/\bclaude(-code)?\b/.test(joined)) return { kind: "claude-code", title: "Claude Code" };
  if (/\bcodex\b/.test(joined)) return { kind: "codex", title: "Codex" };
  if (/\baider\b/.test(joined)) return { kind: "aider", title: "Aider" };
  if (/\bopencode\b/.test(joined)) return { kind: "opencode", title: "OpenCode" };
  if (/\b(vitest|jest|pnpm test)\b/.test(joined)) return { kind: "test-runner", title: "Tests" };
  if (/\b(vite|next dev|tsx watch)\b/.test(joined)) return { kind: "dev-server", title: "Dev server" };
  return undefined;
}
