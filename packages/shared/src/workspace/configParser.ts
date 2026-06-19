import YAML from "yaml";
import type {
  WorkspaceAppDecl,
  WorkspaceConfig,
  WorkspaceExtensionDecl,
  WorkspaceHeartbeatDecl,
} from "./types.js";
import { WORKSPACE_SOURCE_DIRS } from "./sourceDirs.js";

export function parseWorkspaceConfigContentWithId(content: string, id: string): WorkspaceConfig {
  const config = YAML.parse(content) as WorkspaceConfig;
  config.id = id;
  validateDeclaredUnits(config);
  return config;
}

const UNIT_SOURCE_NORMALIZE = /(^\/+|\/+$)/g;
const UNIT_PACKAGE_NAME = /^@[^/\s]+\/[^/\s]+$/;
const WORKSPACE_SOURCE_DIR_SET = new Set<string>(WORKSPACE_SOURCE_DIRS);

interface DeclaredUnitDescriptor<Decl extends { source: string }> {
  section: "extensions" | "apps";
  sourceRoot: "extensions" | "apps";
  packageScope: "@workspace-extensions/" | "@workspace-apps/";
  singular: "extension" | "app";
  values: Decl[] | undefined;
  validate?: (decl: Decl) => void;
}

function normalizeDeclaredUnitSourceKey<Decl extends { source: string }>(
  source: string,
  descriptor: DeclaredUnitDescriptor<Decl>,
): string {
  const normalized = normalizeDeclaredUnitSource(source);
  const sourceRootPrefix = `${descriptor.sourceRoot}/`;
  if (normalized.startsWith(sourceRootPrefix)) {
    return normalized.slice(sourceRootPrefix.length);
  }
  if (normalized.startsWith(descriptor.packageScope)) {
    return normalized.slice(descriptor.packageScope.length);
  }
  return normalized;
}

function normalizeDeclaredUnitSource(source: string): string {
  return source
    .trim()
    .replace(UNIT_SOURCE_NORMALIZE, "")
    .replace(/^workspace\//, "");
}

function validateDeclaredUnitSource<Decl extends { source: string }>(
  source: string,
  descriptor: DeclaredUnitDescriptor<Decl>,
): void {
  const normalized = normalizeDeclaredUnitSource(source);
  const [firstSegment] = normalized.split("/");
  const sourceRootPrefix = `${descriptor.sourceRoot}/`;
  if (firstSegment && WORKSPACE_SOURCE_DIR_SET.has(firstSegment) && firstSegment !== descriptor.sourceRoot) {
    throw new Error(
      `meta/natstack.yml: \`${descriptor.section}[].source\` must point under \`${descriptor.sourceRoot}/name\` or use a \`${descriptor.packageScope}name\` package name`,
    );
  }
  if (normalized.startsWith(sourceRootPrefix)) {
    const sourceIdentity = normalized.slice(sourceRootPrefix.length);
    if (!/^[^/\s]+$/.test(sourceIdentity) || sourceIdentity.endsWith(".git")) {
      throw new Error(
        `meta/natstack.yml: \`${descriptor.section}[].source\` must be \`${descriptor.sourceRoot}/name\` or \`${descriptor.packageScope}name\``,
      );
    }
    return;
  }
  if (!UNIT_PACKAGE_NAME.test(normalized) || !normalized.startsWith(descriptor.packageScope)) {
    throw new Error(
      `meta/natstack.yml: \`${descriptor.section}[].source\` must be \`${descriptor.sourceRoot}/name\` or \`${descriptor.packageScope}name\``,
    );
  }
}

function validateDeclaredUnitList<Decl extends { source: string }>(
  descriptor: DeclaredUnitDescriptor<Decl>,
): void {
  const declarations = descriptor.values;
  if (declarations === undefined) return;
  if (!Array.isArray(declarations)) {
    throw new Error(`meta/natstack.yml: \`${descriptor.section}\` must be a list`);
  }
  const seen = new Set<string>();
  for (const decl of declarations) {
    if (!decl || typeof decl.source !== "string" || decl.source.trim().length === 0) {
      throw new Error(`meta/natstack.yml: every \`${descriptor.section}\` entry needs a non-empty \`source\``);
    }
    const ref = (decl as { ref?: unknown }).ref;
    if (ref !== undefined && (typeof ref !== "string" || ref.trim().length === 0)) {
      throw new Error(`meta/natstack.yml: \`${descriptor.section}[].ref\` must be a non-empty string when provided`);
    }
    validateDeclaredUnitSource(decl.source, descriptor);
    descriptor.validate?.(decl);
    const key = normalizeDeclaredUnitSourceKey(decl.source, descriptor);
    if (seen.has(key)) {
      throw new Error(`meta/natstack.yml: duplicate ${descriptor.singular} declaration for "${decl.source}"`);
    }
    seen.add(key);
  }
}

function validateDeclaredUnits(config: WorkspaceConfig): void {
  validateDeclaredUnitList<WorkspaceExtensionDecl>({
    section: "extensions",
    sourceRoot: "extensions",
    packageScope: "@workspace-extensions/",
    singular: "extension",
    values: config.extensions,
  });
  validateDeclaredUnitList<WorkspaceAppDecl>({
    section: "apps",
    sourceRoot: "apps",
    packageScope: "@workspace-apps/",
    singular: "app",
    values: config.apps,
  });
  validateHeartbeats(config.heartbeats);
}

const DECL_NAME_RE = /^[A-Za-z0-9._:-]+$/;
const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

function parseDurationMs(value: string, field: string): number {
  const match = value.match(DURATION_RE);
  if (!match) {
    throw new Error(`meta/natstack.yml: \`${field}\` must be a duration like 30s, 5m, 1h, or 1d`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}

function validateClock(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`meta/natstack.yml: \`${field}\` must be HH:MM`);
  }
}

function validateHeartbeats(heartbeats: WorkspaceHeartbeatDecl[] | undefined): void {
  if (heartbeats === undefined) return;
  if (!Array.isArray(heartbeats)) {
    throw new Error("meta/natstack.yml: `heartbeats` must be a list");
  }
  const seen = new Set<string>();
  for (const heartbeat of heartbeats) {
    if (!heartbeat || typeof heartbeat.name !== "string" || !DECL_NAME_RE.test(heartbeat.name)) {
      throw new Error("meta/natstack.yml: every `heartbeats` entry needs a stable name");
    }
    if (seen.has(heartbeat.name)) {
      throw new Error(`meta/natstack.yml: duplicate heartbeat declaration "${heartbeat.name}"`);
    }
    seen.add(heartbeat.name);
    if (
      !heartbeat.target ||
      typeof heartbeat.target.source !== "string" ||
      !heartbeat.target.source.trim() ||
      typeof heartbeat.target.className !== "string" ||
      !heartbeat.target.className.trim()
    ) {
      throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} target.source and target.className are required`);
    }
    if (
      heartbeat.target.objectKey !== undefined &&
      (typeof heartbeat.target.objectKey !== "string" || !heartbeat.target.objectKey.trim())
    ) {
      throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} target.objectKey must be a non-empty string`);
    }
    if (!heartbeat.schedule || typeof heartbeat.schedule.every !== "string") {
      throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} schedule.every is required`);
    }
    const everyMs = parseDurationMs(heartbeat.schedule.every, `heartbeats[].schedule.every`);
    if (everyMs < 60_000 || everyMs > 30 * 86_400_000) {
      throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} schedule.every must be between 1m and 30d`);
    }
    if (heartbeat.schedule.jitter !== undefined) {
      const jitterMs = parseDurationMs(heartbeat.schedule.jitter, `heartbeats[].schedule.jitter`);
      if (jitterMs < 0 || jitterMs > everyMs) {
        throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} schedule.jitter must be no larger than schedule.every`);
      }
    }
    if (heartbeat.schedule.at !== undefined) {
      validateClock(heartbeat.schedule.at, `heartbeats[].schedule.at`);
      if (everyMs % 86_400_000 !== 0) {
        throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} schedule.at only applies to day-multiple intervals`);
      }
    }
    if (heartbeat.schedule.activeHours) {
      validateClock(heartbeat.schedule.activeHours.start, `heartbeats[].schedule.activeHours.start`);
      validateClock(heartbeat.schedule.activeHours.end, `heartbeats[].schedule.activeHours.end`);
    }
    const tokenBudget = heartbeat.context?.tokenBudget;
    if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget < 1000 || tokenBudget > 200_000)) {
      throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} context.tokenBudget is out of range`);
    }
    const maxModelCalls = heartbeat.behavior?.maxModelCalls;
    if (maxModelCalls !== undefined && (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 10)) {
      throw new Error(`meta/natstack.yml: heartbeat ${heartbeat.name} behavior.maxModelCalls is out of range`);
    }
    if (heartbeat.behavior?.failureBackoff?.base !== undefined) {
      parseDurationMs(heartbeat.behavior.failureBackoff.base, `heartbeats[].behavior.failureBackoff.base`);
    }
    if (heartbeat.behavior?.failureBackoff?.max !== undefined) {
      parseDurationMs(heartbeat.behavior.failureBackoff.max, `heartbeats[].behavior.failureBackoff.max`);
    }
  }
}

export function resolveDeclaredExtensions(
  config: WorkspaceConfig,
): Array<{ source: string; ref: string }> {
  return resolveDeclaredUnits(config.extensions ?? []).map((decl) => ({
    source: decl.source,
    ref: decl.ref,
  }));
}

export function resolveDeclaredApps(
  config: WorkspaceConfig,
): Array<{ source: string; ref: string }> {
  return (config.apps ?? []).map((decl) => ({
    source: decl.source.trim(),
    ref: (decl.ref ?? "main").trim(),
  }));
}

function resolveDeclaredUnits<Decl extends { source: string; ref?: string }>(
  declarations: Decl[],
): Array<Decl & { source: string; ref: string }> {
  return declarations.map((decl) => ({
    ...decl,
    source: decl.source.trim(),
    ref: (decl.ref ?? "main").trim(),
  }));
}
