import * as fs from "node:fs";
import * as path from "node:path";
import type { RegistryEntry } from "./types.js";

interface RegistryFile {
  entries: RegistryEntry[];
}

export class ExtensionRegistry {
  private entries = new Map<string, RegistryEntry>();
  private readonly filePath: string;

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "extensions", "registry.json");
    this.load();
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  get(name: string): RegistryEntry | null {
    const entry = this.entries.get(name);
    return entry ? { ...entry } : null;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  upsert(entry: RegistryEntry): void {
    this.entries.set(entry.name, { ...entry });
    this.save();
  }

  patch(name: string, patch: Partial<RegistryEntry>): RegistryEntry {
    const current = this.entries.get(name);
    if (!current) throw new Error(`Extension is not installed: ${name}`);
    const next = { ...current, ...patch, name };
    this.entries.set(name, next);
    this.save();
    return { ...next };
  }

  delete(name: string): boolean {
    const deleted = this.entries.delete(name);
    if (deleted) this.save();
    return deleted;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as RegistryFile;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(isRegistryEntry).map(normalizeRegistryEntry)
        : [];
      this.entries = new Map(entries.map((entry) => [entry.name, entry]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[ExtensionRegistry] Failed to load registry:", err);
      }
      this.entries = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const payload: RegistryFile = { entries: this.list() };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

function normalizeRegistryEntry(entry: RegistryEntry): RegistryEntry {
  return {
    ...entry,
    activeDependencyEvs: entry.activeDependencyEvs ?? {},
    activeExternalDeps: entry.activeExternalDeps ?? {},
  };
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RegistryEntry>;
  return (
    typeof entry.name === "string"
    && typeof entry.version === "string"
    && !!entry.source
    && entry.source.kind === "internal-git"
    && typeof entry.source.repo === "string"
    && typeof entry.source.ref === "string"
    && typeof entry.installedAt === "number"
    && typeof entry.enabled === "boolean"
    && typeof entry.status === "string"
  );
}
