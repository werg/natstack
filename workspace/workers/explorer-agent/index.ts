import { SilentAgentWorker } from "../silent-agent-worker/index.js";
import { installMessageTypes } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import { defaultPolicies } from "@workspace/agent-loop";
import type { RespondPolicy, StepPolicy } from "@workspace/agent-loop";
import { rpc } from "@workspace/runtime/worker";
import { taxonomyRepoForPath } from "@natstack/shared/runtime/entitySpec";
import { EXPLORER_SYSTEM_PROMPT, SCHEDULED_SWEEP_PROMPT } from "./prompts.js";
import {
  buildCardState,
  findingsCardKey,
  findingsFilePath,
  renderFindingsFile,
  FINDINGS_KEY_PREFIX,
  FINDINGS_MESSAGE_TYPES,
  FINDINGS_TYPE_ID,
  FINDINGS_UI_IMPORTS,
  FINDINGS_UI_INSTALL_VERSION,
  type FindingClass,
  type FindingDetail,
  type FindingSeverity,
} from "./findings-card.js";

const FINDING_CLASSES: readonly FindingClass[] = ["BUG", "DOC-MISMATCH", "SURPRISING"];
const SEVERITIES: readonly FindingSeverity[] = ["low", "medium", "high"];

export interface ExplorerPublishStatus {
  repoPath?: string;
  files?: Array<{ path?: unknown }>;
}

interface ExplorerPushResult {
  status?: string;
}

export function unrelatedFindingPublishPaths(
  status: ExplorerPublishStatus,
  allowedPath: string
): string[] {
  return [
    ...new Set(
      (status.files ?? [])
        .map((file) => file.path)
        .filter((path): path is string => typeof path === "string" && path !== allowedPath)
    ),
  ].sort();
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function repoScopeForPath(filePath: string): { repoPath: string; repoRelPath: string } {
  const normalized = filePath.replace(/^\/+/, "");
  const repoPath = taxonomyRepoForPath(normalized);
  if (!repoPath) throw new Error(`No repo owns findings path ${JSON.stringify(filePath)}`);
  return {
    repoPath,
    repoRelPath: normalized === repoPath ? "" : normalized.slice(repoPath.length + 1),
  };
}

/**
 * The explorer agent: a silent agent variant that agentically tests the workspace's
 * own capability surface. It inherits silence + the `say` tool from
 * `SilentAgentWorker`, and adds (a) the explorer system prompt (the oracle loop —
 * full methodology in `skills/explorer/SKILL.md`), (b) a recurring autonomous sweep
 * driven by the `natstack.yml recurring:` registry, and (c) a `report_finding` tool
 * that durably logs findings (commit + push) and aggregates them into a findings
 * card in the connected chat panel.
 *
 * Runs as a `do` caller with the full `services.*` surface (NOT read-only) — the
 * sandbox is the safety boundary.
 */
export class ExplorerAgentWorker extends SilentAgentWorker {
  static override schemaVersion = SilentAgentWorker.schemaVersion;

  /** Channels whose findings message-type has been installed this lifetime. */
  private readonly installedUi = new Set<string>();

  constructor(ctx: ConstructorParameters<typeof SilentAgentWorker>[0], env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Explorer");
    // Source of truth for both the per-run findings file AND the findings card.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS explorer_findings (
         channel_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
         id TEXT NOT NULL, ts TEXT NOT NULL, cls TEXT NOT NULL, surface TEXT NOT NULL,
         title TEXT NOT NULL, severity TEXT NOT NULL, expected TEXT NOT NULL,
         actual TEXT NOT NULL, repro TEXT,
         PRIMARY KEY (channel_id, run_id, seq))`
    );
  }

  protected override getParticipantInfo(
    channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const base = super.getParticipantInfo(channelId, config);
    return { ...base, handle: "explorer", name: "Explorer" };
  }

  protected override getAgentPrompt(_channelId: string): string {
    return EXPLORER_SYSTEM_PROMPT;
  }

  /**
   * Stay silent in conversation: only run a turn when explicitly addressed (@explorer)
   * or following up our own message. Scheduled sweeps use `submitAgentInitiatedTurn`,
   * which bypasses this gate. AgentWorkerBase defaults to `"all"` (respond to every
   * message) — which would pile a concurrent explorer turn onto every channel message
   * alongside other agents, diverging the channel log (GAD id-collision/replay-mismatch).
   */
  protected override getDefaultRespondPolicy(): RespondPolicy {
    return "mentioned-or-followup";
  }

  /**
   * Visible when it responds. "Stays quiet unless addressed" is enforced by the respond
   * policy above — NOT by suppressing output. SilentAgentWorker's silent step policy hid
   * the ENTIRE turn (speak-only-via-`say`), which made an addressed explorer look
   * unresponsive even when it ran. Drop it so an addressed (or scheduled) run SHOWS its
   * work; findings still go to the committed file + the findings card.
   */
  protected override getStepPolicies(_channelId: string): StepPolicy[] {
    return defaultPolicies();
  }

  protected override getLoopTools(channelId: string): AgentTool[] {
    return [...super.getLoopTools(channelId), this.createReportFindingTool(channelId)];
  }

  /**
   * Recurring autonomous sweep: kick a self-initiated turn in every subscribed
   * channel so the agent runs its loop without a user message. Wired via the
   * `natstack.yml recurring:` registry (server/harness caller only).
   */
  @rpc({ callers: ["server"] })
  async runScheduledJob(_args: unknown): Promise<{ ok: boolean; channels: number }> {
    const channelIds = this.subscriptions.listChannelIds();
    for (const channelId of channelIds) {
      if (!this.subscriptions.getParticipantId(channelId)) continue;
      await this.submitAgentInitiatedTurn(
        channelId,
        { content: SCHEDULED_SWEEP_PROMPT },
        { mode: "sequential", steeringId: `explorer-sweep:${channelId}:${Date.now()}` }
      );
    }
    return { ok: true, channels: channelIds.length };
  }

  // ── report_finding ────────────────────────────────────────────────────────

  private createReportFindingTool(channelId: string): AgentTool<any> {
    return {
      name: "report_finding",
      label: "report_finding",
      description:
        "Record one discrepancy found while exploring. Appends it to this run's findings " +
        "file (committed + pushed for a durable, searchable history) and aggregates it into " +
        "the findings card in the connected chat panel. Call once per finding; group a run's " +
        "findings under a stable `runId`.",
      parameters: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description:
              'Stable id grouping this run\'s findings into one file + card, e.g. "2026-06-22-blobstore".',
          },
          class: {
            type: "string",
            enum: [...FINDING_CLASSES],
            description:
              "BUG = violates the contract/an invariant; DOC-MISMATCH = docs wrong/incomplete/misleading; SURPRISING = works but unexpected.",
          },
          surface: {
            type: "string",
            description: "The catalog id, e.g. service:blobstore.putText or runtime:vcs.",
          },
          title: { type: "string", description: "One-line summary of the finding." },
          expected: {
            type: "string",
            description: "What you expected (from the docs/contract) BEFORE the call.",
          },
          actual: { type: "string", description: "What actually happened." },
          repro: { type: "string", description: "Optional minimal steps/code to reproduce." },
          severity: {
            type: "string",
            enum: [...SEVERITIES],
            description: "Impact severity (default medium).",
          },
        },
        required: ["runId", "class", "surface", "title", "expected", "actual"],
      } as never,
      execute: async (_toolCallId, params) => {
        const p = (params ?? {}) as Record<string, unknown>;
        const runId = str(p["runId"]).trim();
        const cls = str(p["class"]) as FindingClass;
        const surface = str(p["surface"]).trim();
        const title = str(p["title"]).trim();
        const expected = str(p["expected"]).trim();
        const actual = str(p["actual"]).trim();
        const repro = str(p["repro"]).trim() || undefined;
        const severityRaw = str(p["severity"]) as FindingSeverity;
        const severity: FindingSeverity = SEVERITIES.includes(severityRaw)
          ? severityRaw
          : "medium";

        if (!runId) throw new Error("report_finding requires a runId");
        if (!FINDING_CLASSES.includes(cls)) {
          throw new Error(`report_finding class must be one of ${FINDING_CLASSES.join(", ")}`);
        }
        if (!surface || !title || !expected || !actual) {
          throw new Error("report_finding requires surface, title, expected, and actual");
        }

        const detail: FindingDetail = {
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          cls,
          surface,
          title,
          severity,
          expected,
          actual,
          ...(repro ? { repro } : {}),
        };

        const filePath = findingsFilePath(runId);
        await this.assertFindingsPublishScope(filePath);

        await this.ensureFindingsUi(channelId);
        this.persistFinding(channelId, runId, detail);
        const rows = this.loadFindings(channelId, runId);

        // Durable log: rebuild the whole per-run file from the table, then
        // edit → commit → push (record the working edit, seal a messaged
        // snapshot, build-gate it into main).
        const fileText = renderFindingsFile(runId, rows);
        const { repoPath } = repoScopeForPath(filePath);
        await this.rpc.call("main", "vcs.edit", [
          { edits: [{ kind: "write", path: filePath, content: { kind: "text", text: fileText } }] },
        ]);
        await this.rpc.call("main", "vcs.commit", [
          { message: `explorer: ${cls} on ${surface} (${runId})`, repoPaths: [repoPath] },
        ]);
        // After committing, the findings file is the only change ahead of main —
        // refuse to push if anything UNRELATED is also ahead (scoped publish).
        await this.assertFindingsPublishScope(filePath);
        const push = await this.rpc
          .call<ExplorerPushResult>("main", "vcs.push", [{ repoPaths: [repoPath] }])
          .catch((error: unknown) => ({ status: `error: ${String(error)}` }));

        // Aggregate into the (single, per-run) findings card in the chat panel.
        await this.publishFindingsCard(
          channelId,
          runId,
          buildCardState(runId, filePath, rows, detail.ts)
        );

        return {
          content: [
            {
              type: "text",
              text: `recorded ${cls} on ${surface} — ${rows.length} finding(s) in ${filePath} (push: ${push?.status ?? "?"})`,
            },
          ],
          details: { id: detail.id, filePath, total: rows.length, push: push?.status },
        };
      },
    };
  }

  private async assertFindingsPublishScope(filePath: string): Promise<void> {
    const { repoPath, repoRelPath } = repoScopeForPath(filePath);
    const statuses = await this.rpc.call<ExplorerPublishStatus[]>("main", "vcs.pushStatus", [
      [repoPath],
    ]);
    const status = statuses.find((s) => s.repoPath === repoPath) ?? statuses[0] ?? { files: [] };
    const unrelated = unrelatedFindingPublishPaths(status, repoRelPath);
    if (unrelated.length === 0) return;
    throw new Error(
      "report_finding refused to publish because this context has unrelated unpublished " +
        `changes: ${unrelated.join(", ")}. Only ${filePath} may be published by this tool.`
    );
  }

  private persistFinding(channelId: string, runId: string, detail: FindingDetail): void {
    const prev = this.sql
      .exec(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM explorer_findings WHERE channel_id = ? AND run_id = ?`,
        channelId,
        runId
      )
      .toArray()[0];
    const seq = Number(prev?.["m"] ?? 0) + 1;
    this.sql.exec(
      `INSERT INTO explorer_findings
         (channel_id, run_id, seq, id, ts, cls, surface, title, severity, expected, actual, repro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      runId,
      seq,
      detail.id,
      detail.ts,
      detail.cls,
      detail.surface,
      detail.title,
      detail.severity,
      detail.expected,
      detail.actual,
      detail.repro ?? null
    );
  }

  private loadFindings(channelId: string, runId: string): FindingDetail[] {
    return this.sql
      .exec(
        `SELECT * FROM explorer_findings WHERE channel_id = ? AND run_id = ? ORDER BY seq`,
        channelId,
        runId
      )
      .toArray()
      .map((r) => ({
        id: String(r["id"]),
        ts: String(r["ts"]),
        cls: String(r["cls"]) as FindingClass,
        surface: String(r["surface"]),
        title: String(r["title"]),
        severity: String(r["severity"]) as FindingSeverity,
        expected: String(r["expected"]),
        actual: String(r["actual"]),
        ...(r["repro"] == null ? {} : { repro: String(r["repro"]) }),
      }));
  }

  private async ensureFindingsUi(channelId: string): Promise<void> {
    if (this.installedUi.has(channelId)) return;
    await installMessageTypes({
      channel: this.createChannelClient(channelId),
      actor: { kind: "agent", id: this.participantId(), participantId: this.participantId() },
      specs: FINDINGS_MESSAGE_TYPES,
      imports: FINDINGS_UI_IMPORTS,
      version: FINDINGS_UI_INSTALL_VERSION,
      keyPrefix: FINDINGS_KEY_PREFIX,
      cards: this.cards,
      channelId,
      readFile: async (path) => {
        try {
          const raw = await this.rpc.call<unknown>("main", "fs.readFile", [path, "utf8"]);
          return typeof raw === "string" ? raw : null;
        } catch {
          return null;
        }
      },
    });
    this.installedUi.add(channelId);
  }

  private async publishFindingsCard(
    channelId: string,
    runId: string,
    state: ReturnType<typeof buildCardState>
  ): Promise<void> {
    const key = findingsCardKey(runId);
    const existing = this.cards.find(channelId, key);
    if (existing) {
      await existing.update(state);
      return;
    }
    await this.cards.getOrCreate(channelId, FINDINGS_TYPE_ID, key, state, { displayMode: "inline" });
  }
}

export default {
  fetch(_req: Request) {
    return new Response("explorer-agent DO service");
  },
};
