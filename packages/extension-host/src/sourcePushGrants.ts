import * as fs from "node:fs";
import * as path from "node:path";

interface SourcePushGrantFile {
  grants: Array<{ key: string; expiresAt: number }>;
}

/**
 * Persistent per-extension dev-session push grants.
 *
 * Spec puts the 4-hour "Allow extension pushes for the next 4 hours" decision
 * in the git-push approval system. We store it in a small JSON sidecar so the
 * grant survives server restarts within its TTL.
 */
export class SourcePushGrantStore {
  private readonly filePath: string;
  private grants = new Map<string, number>();

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "extensions", "source-push-grants.json");
    this.load();
  }

  /** Returns true if a non-expired grant exists; lazily clears stale entries. */
  hasActive(key: string, now = Date.now()): boolean {
    const expiresAt = this.grants.get(key);
    if (!expiresAt) return false;
    if (expiresAt > now) return true;
    this.grants.delete(key);
    this.save();
    return false;
  }

  grant(key: string, ttlMs: number, now = Date.now()): void {
    this.grants.set(key, now + ttlMs);
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SourcePushGrantFile;
      const now = Date.now();
      this.grants = new Map(
        (Array.isArray(parsed.grants) ? parsed.grants : [])
          .filter((g) => typeof g.key === "string" && typeof g.expiresAt === "number" && g.expiresAt > now)
          .map((g) => [g.key, g.expiresAt]),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[SourcePushGrantStore] Failed to load grants:", err);
      }
      this.grants = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const payload: SourcePushGrantFile = {
      grants: [...this.grants.entries()].map(([key, expiresAt]) => ({ key, expiresAt })),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
