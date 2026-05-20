import { z } from "zod";

export const execRequestSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional().default({}),
  shell: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(1).max(10 * 60_000).optional().default(30_000),
  stdin: z.string().max(64 * 1024).optional(),
  maxOutputBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional().default(1024 * 1024),
}).strict();

export const openRequestSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional().default({}),
  cols: z.number().int().min(1).max(1000).optional().default(80),
  rows: z.number().int().min(1).max(1000).optional().default(24),
  label: z.string().max(80).optional(),
}).strict();

export type ExecRequest = z.infer<typeof execRequestSchema>;
export type OpenRequest = z.infer<typeof openRequestSchema>;
export type ScrollCursor = string;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  ownerCallerId: string;
  label: string;
  command: { argv: string[]; cwd: string };
  gitBranch?: string;
  pid: number;
  pgid: number;
  cols: number;
  rows: number;
  startedAt: number;
  lastActivityAt: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  processTree: Array<{ pid: number; ppid: number; comm: string; args: string[] }>;
  listeningPorts: Array<{ proto: "tcp" | "tcp6" | "udp" | "udp6"; addr: string; port: number; pid: number }>;
  detectedPorts: number[];
  detectedUrls: string[];
  bytesOut: number;
  meta: Record<string, unknown>;
  detectedAgent?: { kind: "claude-code" | "codex" | "aider" | "opencode" | "test-runner" | "dev-server"; title?: string };
}

export type SessionInfoEvent =
  | { type: "snapshot-batch"; sessions: SessionInfo[] }
  | { type: "snapshot"; sessionId: string; info: SessionInfo }
  | { type: "opened"; sessionId: string; info: SessionInfo }
  | { type: "exit"; sessionId: string; exit: { code: number | null; signal?: string; at: number } }
  | { type: "disposed"; sessionId: string }
  | { type: "heartbeat"; at: number };
