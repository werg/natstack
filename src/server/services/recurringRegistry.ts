import { createHash } from "node:crypto";
import { createDevLogger } from "@natstack/dev-log";
import { parseWorkspaceConfigContentWithId } from "@natstack/shared/workspace/configParser";
import type { WorkspaceHeartbeatDecl, WorkspaceRecurringDecl } from "@natstack/shared/workspace/types";
import type { UnitBatchEntry } from "@natstack/shared/approvals";
import type { UnitMetaChangeApprovalProvider } from "@natstack/unit-host";
import type { DODispatch, DORef } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { RecurringJobRow } from "../internalDOs/workspaceDO.js";

const log = createDevLogger("RecurringRegistry");

/** setTimeout caps out near 2^31 ms; clamp longer delays and re-evaluate on wake. */
const MAX_TIMER_MS = 2_000_000_000;
const DAY_MS = 24 * 3_600_000;
const DEFAULT_FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
const DEFAULT_FAILURE_BACKOFF_MAX_MS = 4 * 3_600_000;

export interface RecurringJobStatus {
  name: string;
  target: {
    source: string;
    className: string;
    objectKey: string;
    method: string;
  };
  args: unknown[];
  schedule: {
    intervalMs: number;
    atMinutes: number | null;
  };
  specHash: string;
  status: "scheduled" | "backing-off" | "failing";
  nextRunAt: number;
  lastRunAt: number | null;
  lastStartedAt: number | null;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  failCount: number;
  backoffUntil: number | null;
}

// ── schedule spec ────────────────────────────────────────────────────────────

export interface ParsedSchedule {
  intervalMs: number;
  /** Local-time anchor in minutes after midnight, or null for free-running. */
  atMinutes: number | null;
}

const DURATION_RE = /^(\d+)\s*(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS };
const MIN_INTERVAL_MS = 60_000;

/** Parse a `recurring[].schedule` declaration. Throws on invalid specs. */
export function parseScheduleSpec(schedule: WorkspaceRecurringDecl["schedule"]): ParsedSchedule {
  const match = DURATION_RE.exec(String(schedule.every ?? "").trim());
  if (!match) {
    throw new Error(
      `invalid schedule.every ${JSON.stringify(schedule.every)} — expected e.g. "30m", "6h", "1d"`
    );
  }
  const intervalMs = Number(match[1]) * UNIT_MS[match[2]!]!;
  if (intervalMs < MIN_INTERVAL_MS) {
    throw new Error(`schedule.every must be at least 1m (got ${schedule.every})`);
  }
  let atMinutes: number | null = null;
  if (schedule.at !== undefined) {
    const atMatch = /^(\d{1,2}):(\d{2})$/.exec(schedule.at.trim());
    if (!atMatch) {
      throw new Error(`invalid schedule.at ${JSON.stringify(schedule.at)} — expected "HH:MM"`);
    }
    const hours = Number(atMatch[1]);
    const minutes = Number(atMatch[2]);
    if (hours > 23 || minutes > 59) {
      throw new Error(`invalid schedule.at ${JSON.stringify(schedule.at)} — out of range`);
    }
    if (intervalMs % DAY_MS !== 0) {
      throw new Error(`schedule.at requires a whole-day interval (got every: ${schedule.every})`);
    }
    atMinutes = hours * 60 + minutes;
  }
  return { intervalMs, atMinutes };
}

/**
 * First run time for a (re)declared job. Anchored schedules start at the next
 * local HH:MM occurrence; free-running schedules start one interval out.
 */
export function computeNextRunAt(now: number, parsed: ParsedSchedule): number {
  if (parsed.atMinutes === null) return now + parsed.intervalMs;
  const anchor = new Date(now);
  anchor.setHours(Math.floor(parsed.atMinutes / 60), parsed.atMinutes % 60, 0, 0);
  let next = anchor.getTime();
  while (next <= now) next += DAY_MS;
  return next;
}

/** Run time after a completed run: skip forward past `now` without bursts. */
export function computeRunAfter(now: number, parsed: ParsedSchedule, scheduledAt: number): number {
  let next = scheduledAt + parsed.intervalMs;
  while (next <= now) next += parsed.intervalMs;
  return next;
}

export function computeFailureBackoffMs(
  failCount: number,
  baseMs = DEFAULT_FAILURE_BACKOFF_BASE_MS,
  maxMs = DEFAULT_FAILURE_BACKOFF_MAX_MS
): number {
  const normalized = Math.max(1, Math.floor(failCount));
  return Math.min(maxMs, Math.pow(2, normalized - 1) * baseMs);
}

// ── declaration → durable row ───────────────────────────────────────────────

export function recurringSpecHash(decl: WorkspaceRecurringDecl): string {
  const canonical = JSON.stringify({
    target: {
      source: decl.target.source,
      className: decl.target.className,
      objectKey: decl.target.objectKey ?? decl.name,
    },
    method: decl.method,
    args: decl.args ?? [],
    schedule: { every: decl.schedule.every, at: decl.schedule.at ?? null },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function heartbeatSpecHash(decl: WorkspaceHeartbeatDecl): string {
  return createHash("sha256").update(JSON.stringify(decl)).digest("hex");
}

export function declToJobRow(decl: WorkspaceRecurringDecl, now: number): RecurringJobRow {
  const parsed = parseScheduleSpec(decl.schedule);
  if (!decl.name || !/^[a-zA-Z0-9._-]+$/.test(decl.name)) {
    throw new Error(`invalid recurring job name ${JSON.stringify(decl.name)}`);
  }
  if (!decl.target?.source || !decl.target?.className || !decl.method) {
    throw new Error(`recurring job ${decl.name}: target.source, target.className, method required`);
  }
  return {
    name: decl.name,
    source: decl.target.source,
    className: decl.target.className,
    objectKey: decl.target.objectKey ?? decl.name,
    method: decl.method,
    argsJson: JSON.stringify(decl.args ?? []),
    intervalMs: parsed.intervalMs,
    atMinutes: parsed.atMinutes,
    specHash: recurringSpecHash(decl),
    initialNextRunAt: computeNextRunAt(now, parsed),
  };
}

// ── registry service ─────────────────────────────────────────────────────────

export interface RecurringRegistryDeps {
  doDispatch: DODispatch;
  workspaceId: string;
  /** Read the current `recurring:` declarations (from the loaded config). */
  loadRecurring: () => WorkspaceRecurringDecl[];
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/**
 * Server-driven declarative scheduled jobs ("cron"). Declarations live in
 * meta/natstack.yml `recurring:` (approval-gated via meta push); durable
 * next-run state lives in WorkspaceDO `recurring_jobs` so restarts neither
 * lose schedules nor re-fire missed runs as bursts. One timer tracks the
 * soonest pending run, mirroring AlarmDriver.
 */
export class RecurringRegistry {
  private readonly deps: RecurringRegistryDeps;
  private readonly workspaceRef: DORef;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private rescheduling: Promise<void> | null = null;

  constructor(deps: RecurringRegistryDeps) {
    this.deps = deps;
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
    this.backoffBaseMs = deps.backoffBaseMs ?? DEFAULT_FAILURE_BACKOFF_BASE_MS;
    this.backoffMaxMs = deps.backoffMaxMs ?? DEFAULT_FAILURE_BACKOFF_MAX_MS;
  }

  /** Sync declarations into durable state and arm the timer. Call on boot. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.sync();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Re-read declarations (e.g. after an approved meta push) and re-sync. */
  notifyChanged(): void {
    void this.sync();
  }

  async listJobs(now = Date.now()): Promise<RecurringJobStatus[]> {
    const rows = await this.dispatchWorkspace<RecurringJobRow[]>("recurringList");
    return rows.map((row) => recurringJobStatus(row, now));
  }

  private async sync(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const rows: RecurringJobRow[] = [];
    for (const decl of this.deps.loadRecurring()) {
      try {
        rows.push(declToJobRow(decl, now));
      } catch (err) {
        log.warn(`skipping invalid recurring job:`, err);
      }
    }
    try {
      await this.dispatchWorkspace("recurringSync", { jobs: rows });
    } catch (err) {
      log.warn("recurringSync failed; schedules unchanged:", err);
    }
    await this.reschedule();
  }

  private async reschedule(): Promise<void> {
    if (this.stopped) return;
    const run = async (): Promise<void> => {
      if (this.stopped) return;
      let next: number | null = null;
      try {
        next = await this.dispatchWorkspace<number | null>("recurringNextWakeAt");
      } catch (err) {
        log.warn("recurringNextWakeAt failed; will retry on next change:", err);
        return;
      }
      if (this.stopped) return;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (next === null) return;
      const delay = Math.max(0, Math.min(MAX_TIMER_MS, next - Date.now()));
      this.timer = setTimeout(() => void this.fire(), delay);
    };
    const prior = this.rescheduling ?? Promise.resolve();
    const mine = prior.then(run, run);
    this.rescheduling = mine;
    await mine;
    if (this.rescheduling === mine) this.rescheduling = null;
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    const now = Date.now();
    let due: RecurringJobRow[] = [];
    try {
      due = await this.dispatchWorkspace<RecurringJobRow[]>("recurringDue", now);
    } catch (err) {
      log.warn("recurringDue failed:", err);
      void this.reschedule();
      return;
    }
    for (const job of due) {
      // Mark the run BEFORE dispatching so a crashing/hanging target can't
      // wedge the job into an immediate-refire loop.
      const parsed: ParsedSchedule = {
        intervalMs: job.intervalMs,
        atMinutes: job.atMinutes ?? null,
      };
      const nextRunAt = computeRunAfter(now, parsed, job.nextRunAt ?? now);
      try {
        await this.dispatchWorkspace("recurringMarkRun", {
          name: job.name,
          lastRunAt: now,
          nextRunAt,
        });
      } catch (err) {
        log.warn(`recurringMarkRun failed for ${job.name}:`, err);
        continue;
      }
      const ref: DORef = { source: job.source, className: job.className, objectKey: job.objectKey };
      let args: unknown[] = [];
      try {
        args = JSON.parse(job.argsJson) as unknown[];
      } catch {
        /* declared args were validated at sync; treat garbage as none */
      }
      const startedAt = Date.now();
      try {
        await this.deps.doDispatch.dispatch(ref, job.method, ...args);
        const finishedAt = Date.now();
        await this.dispatchWorkspace("recurringMarkSucceeded", {
          name: job.name,
          finishedAt,
          durationMs: finishedAt - startedAt,
        }).catch((markErr: unknown) => {
          log.warn(`recurringMarkSucceeded failed for ${job.name}:`, markErr);
        });
        log.info(
          `ran scheduled job ${job.name} → ${job.source}:${job.className}/${job.objectKey}.${job.method}`
        );
      } catch (err) {
        const failedAt = Date.now();
        const failCount = (job.failCount ?? 0) + 1;
        const backoffMs = computeFailureBackoffMs(failCount, this.backoffBaseMs, this.backoffMaxMs);
        await this.dispatchWorkspace("recurringMarkFailed", {
          name: job.name,
          failedAt,
          nextRunAt: failedAt + backoffMs,
          failCount,
          error: formatError(err),
          durationMs: failedAt - startedAt,
        }).catch((markErr: unknown) => {
          log.warn(`recurringMarkFailed failed for ${job.name}:`, markErr);
        });
        log.warn(
          `scheduled job ${job.name} dispatch failed (attempt ${failCount}; retry in ${Math.round(backoffMs / 1000)}s):`,
          err
        );
      }
    }
    void this.reschedule();
  }

  private dispatchWorkspace<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.deps.doDispatch.dispatch(this.workspaceRef, method, ...args) as Promise<T>;
  }
}

export interface HeartbeatDeclarationRegistryDeps {
  doDispatch: DODispatch;
  workspaceId: string;
  loadHeartbeats: () => WorkspaceHeartbeatDecl[];
}

export class HeartbeatDeclarationRegistry {
  private stopped = false;
  private readonly workspaceRef: DORef;

  constructor(private readonly deps: HeartbeatDeclarationRegistryDeps) {
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.sync();
  }

  stop(): void {
    this.stopped = true;
  }

  notifyChanged(): void {
    void this.sync();
  }

  private async sync(): Promise<void> {
    if (this.stopped) return;
    const declarations = this.deps.loadHeartbeats();
    const desired = new Set(declarations.map((decl) => decl.name));
    await this.pruneRemoved(desired);
    for (const decl of declarations) {
      for (const ref of await this.refsForDeclaration(decl)) {
        try {
          await this.deps.doDispatch.dispatch(ref, "configureHeartbeat", decl);
        } catch (err) {
          log.warn(`heartbeat ${decl.name} configure dispatch failed:`, err);
        }
      }
    }
  }

  private async refsForDeclaration(decl: WorkspaceHeartbeatDecl): Promise<DORef[]> {
    if (decl.channel?.mode === "subscribed") {
      const rows = await this.listHeartbeatRows();
      const matches = rows.filter((row) => {
        if (row.kind !== "code-owned") return false;
        if (row.source !== decl.target.source || row.className !== decl.target.className) {
          return false;
        }
        if (decl.channel?.id && row.channelId !== decl.channel.id) return false;
        if (decl.channel?.handle && row.participantHandle !== decl.channel.handle) return false;
        return true;
      });
      return matches.map((row) => ({
        source: row.source,
        className: row.className,
        objectKey: row.objectKey,
      }));
    }
    return [
      {
        source: decl.target.source,
        className: decl.target.className,
        objectKey: decl.target.objectKey ?? decl.name,
      },
    ];
  }

  private async pruneRemoved(desired: Set<string>): Promise<void> {
    let rows: HeartbeatRegistryListRow[];
    try {
      rows = await this.listHeartbeatRows();
    } catch (err) {
      log.warn("heartbeat prune could not list registry:", err);
      return;
    }
    for (const row of rows) {
      const declarationName = heartbeatDeclarationNameFromRegistryRow(row.name);
      if (row.kind !== "declarative" || desired.has(declarationName)) continue;
      const ref: DORef = {
        source: row.source,
        className: row.className,
        objectKey: row.objectKey,
      };
      try {
        await this.deps.doDispatch.dispatch(ref, "removeHeartbeat", row.name);
      } catch (err) {
        log.warn(`heartbeat ${row.name} remove dispatch failed:`, err);
      }
      try {
        await this.deps.doDispatch.dispatch(this.workspaceRef, "heartbeatRemove", {
          name: row.name,
          source: row.source,
          className: row.className,
          objectKey: row.objectKey,
        });
      } catch (err) {
        log.warn(`heartbeat ${row.name} registry remove failed:`, err);
      }
    }
  }

  private async listHeartbeatRows(): Promise<HeartbeatRegistryListRow[]> {
    return (await this.deps.doDispatch.dispatch(
      this.workspaceRef,
      "heartbeatList"
    )) as HeartbeatRegistryListRow[];
  }
}

type HeartbeatRegistryListRow = {
  name: string;
  source: string;
  className: string;
  objectKey: string;
  channelId?: string | null;
  participantHandle?: string | null;
  kind: "declarative" | "code-owned";
};

function heartbeatDeclarationNameFromRegistryRow(name: string): string {
  const idx = name.indexOf("#");
  return idx >= 0 ? name.slice(0, idx) : name;
}

function parseArgs(argsJson: string): unknown[] {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function recurringJobStatus(row: RecurringJobRow, now: number): RecurringJobStatus {
  const backoffUntil = row.backoffUntil ?? null;
  const failCount = row.failCount ?? 0;
  const status =
    backoffUntil !== null && backoffUntil > now
      ? "backing-off"
      : failCount > 0
        ? "failing"
        : "scheduled";
  return {
    name: row.name,
    target: {
      source: row.source,
      className: row.className,
      objectKey: row.objectKey,
      method: row.method,
    },
    args: parseArgs(row.argsJson),
    schedule: {
      intervalMs: row.intervalMs,
      atMinutes: row.atMinutes ?? null,
    },
    specHash: row.specHash,
    status,
    nextRunAt: row.nextRunAt ?? row.initialNextRunAt,
    lastRunAt: row.lastRunAt ?? null,
    lastStartedAt: row.lastStartedAt ?? null,
    lastSucceededAt: row.lastSucceededAt ?? null,
    lastFailedAt: row.lastFailedAt ?? null,
    lastError: row.lastError ?? null,
    lastDurationMs: row.lastDurationMs ?? null,
    failCount,
    backoffUntil,
  };
}

// ── meta-change approval provider ────────────────────────────────────────────

export interface RecurringMetaChangeProviderDeps {
  workspaceId: string;
  getCurrentRecurring(): WorkspaceRecurringDecl[];
  getCurrentHeartbeats?: () => WorkspaceHeartbeatDecl[];
  readWorkspaceFileAtCommit(commit: string, filePath: string): Promise<string | null>;
}

async function readRecurringAtCommit(
  deps: RecurringMetaChangeProviderDeps,
  commit: string
): Promise<WorkspaceRecurringDecl[]> {
  try {
    const out = await deps.readWorkspaceFileAtCommit(commit, "meta/natstack.yml");
    if (!out) return [];
    return parseWorkspaceConfigContentWithId(out, deps.workspaceId).recurring ?? [];
  } catch {
    return [];
  }
}

async function readHeartbeatsAtCommit(
  deps: RecurringMetaChangeProviderDeps,
  commit: string
): Promise<WorkspaceHeartbeatDecl[]> {
  try {
    const out = await deps.readWorkspaceFileAtCommit(commit, "meta/natstack.yml");
    if (!out) return [];
    return parseWorkspaceConfigContentWithId(out, deps.workspaceId).heartbeats ?? [];
  } catch {
    return [];
  }
}

function scheduleLabel(decl: WorkspaceRecurringDecl): string {
  return decl.schedule.at
    ? `every ${decl.schedule.every} at ${decl.schedule.at}`
    : `every ${decl.schedule.every}`;
}

/**
 * Surfaces newly-added or respecified `recurring:` jobs in the meta-change
 * approval as scheduled-job entries, so installing a "cron job" is an
 * explicit, informed consent, not a silent config edit. Diffs the proposed
 * GAD state against the currently loaded workspace config.
 */
export function createRecurringMetaChangeProvider(
  deps: RecurringMetaChangeProviderDeps
): UnitMetaChangeApprovalProvider<UnitBatchEntry> {
  return {
    async metaChangeApprovalForCommit(
      commit: string
    ): Promise<{ units: UnitBatchEntry[]; identityKeys: string[] }> {
      const proposed = await readRecurringAtCommit(deps, commit);
      const proposedHeartbeats = await readHeartbeatsAtCommit(deps, commit);
      const current = new Map(
        deps.getCurrentRecurring().map((decl) => [decl.name, recurringSpecHash(decl)])
      );
      const currentHeartbeats = new Map(
        (deps.getCurrentHeartbeats?.() ?? []).map((decl) => [decl.name, heartbeatSpecHash(decl)])
      );
      const units: UnitBatchEntry[] = [];
      const identityKeys: string[] = [];
      for (const decl of proposed) {
        let hash: string;
        try {
          hash = recurringSpecHash(decl);
          parseScheduleSpec(decl.schedule);
        } catch {
          continue; // invalid decls are rejected at sync time, not approval time
        }
        if (current.get(decl.name) === hash) continue;
        const target = `${decl.target.source}:${decl.target.className}/${decl.target.objectKey ?? decl.name}`;
        units.push({
          unitKind: "scheduled-job",
          unitName: decl.name,
          displayName: `${decl.name} (${scheduleLabel(decl)})`,
          source: { kind: "workspace-repo", repo: "meta", ref: commit },
          capabilities: [`invokes ${target}.${decl.method} on schedule, unattended`],
        });
        identityKeys.push(`scheduled-job:${decl.name}:${hash}`);
      }
      for (const decl of proposedHeartbeats) {
        let hash: string;
        try {
          hash = heartbeatSpecHash(decl);
        } catch {
          continue;
        }
        if (currentHeartbeats.get(decl.name) === hash) continue;
        const target = `${decl.target.source}:${decl.target.className}/${decl.target.objectKey ?? decl.name}`;
        const delivery = decl.behavior?.delivery ?? "none";
        const maxModelCalls = decl.behavior?.maxModelCalls ?? 1;
        const tokenBudget = decl.context?.tokenBudget ?? 12_000;
        const label = decl.schedule.at
          ? `every ${decl.schedule.every} at ${decl.schedule.at}`
          : `every ${decl.schedule.every}`;
        units.push({
          unitKind: "agent-heartbeat",
          unitName: decl.name,
          displayName: `${decl.name} (${label})`,
          source: { kind: "workspace-repo", repo: "meta", ref: commit },
          capabilities: [
            `unattended agent wake ${label}, may invoke tools through ${target}, delivery ${delivery}, maxModelCalls ${maxModelCalls}, tokenBudget ${tokenBudget}`,
          ],
        });
        identityKeys.push(`agent-heartbeat:${decl.name}:${hash}`);
      }
      return { units, identityKeys };
    },
    acceptPreapprovedTrust() {
      // Scheduled jobs carry no build trust; durable state is the yml itself.
    },
  };
}
