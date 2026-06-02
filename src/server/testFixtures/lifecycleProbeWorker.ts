import {
  DurableObjectBase,
  type LifecyclePrepareInput,
  type LifecyclePrepareResult,
  type LifecycleResumeInput,
} from "@workspace/runtime/worker";

export class LifecycleProbeDO extends DurableObjectBase {
  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_probe_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        input_json TEXT NOT NULL,
        boot_generation TEXT
      )
    `);
  }

  override async prepareForRestart(input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
    this.record("prepare", input);
    return { status: "ready" };
  }

  override async resumeAfterRestart(input: LifecycleResumeInput): Promise<void> {
    this.record("resume", input);
  }

  lifecycleEvents(): Array<{ kind: string; input: unknown; bootGeneration: string | null }> {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT kind, input_json, boot_generation
         FROM lifecycle_probe_events
         ORDER BY id`
      )
      .toArray()
      .map((row) => ({
        kind: String(row["kind"]),
        input: JSON.parse(String(row["input_json"])),
        bootGeneration: typeof row["boot_generation"] === "string" ? row["boot_generation"] : null,
      }));
  }

  currentBootGeneration(): string | null {
    const value = this.env["WORKERD_BOOT_GENERATION"];
    return typeof value === "string" ? value : null;
  }

  private record(kind: "prepare" | "resume", input: unknown): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT INTO lifecycle_probe_events (kind, input_json, boot_generation)
       VALUES (?, ?, ?)`,
      kind,
      JSON.stringify(input),
      this.currentBootGeneration()
    );
  }
}

export default {
  fetch() {
    return new Response("lifecycle probe");
  },
};
