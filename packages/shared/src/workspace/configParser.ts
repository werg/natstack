import YAML from "yaml";
import type {
  WorkspaceAppDecl,
  WorkspaceConfig,
  WorkspaceExtensionDecl,
} from "./types.js";
import { WORKSPACE_SOURCE_DIRS } from "./sourceDirs.js";

export function parseWorkspaceConfigContentWithId(content: string, id: string): WorkspaceConfig {
  const config = YAML.parse(content) as WorkspaceConfig;
  config.id = id;
  validateDeclaredUnits(config);
  return config;
}

const UNIT_SOURCE_NORMALIZE = /(^\/+|\.git(\/.*)?$|\/+$)/g;
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
    if (!/^[^/\s]+$/.test(sourceIdentity)) {
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
