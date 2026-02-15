/**
 * Context Template System Types
 *
 * Provides Docker-like layered filesystem inheritance for panel contexts.
 * Templates define git repositories to clone into specific paths within
 * a context's filesystem scope.
 */

/**
 * Git spec formats supported:
 * - "path/to/repo" - default branch
 * - "path/to/repo#branch" - specific branch
 * - "path/to/repo@v1.0.0" - tag
 * - "path/to/repo@abc1234" - commit hash (7+ hex chars)
 */
export type GitSpec = string;

/**
 * Raw template as parsed from YAML (context-template.yml)
 */
export interface ContextTemplateYaml {
  /** Optional human-readable name */
  name?: string;
  /** Optional description */
  description?: string;
  /** Git spec of parent template to extend */
  extends?: GitSpec;
  /** Target filesystem paths mapped to git specs */
  structure?: Record<string, GitSpec>;
}

/**
 * Parsed git spec with separated components
 */
export interface ParsedGitSpec {
  /** Repository path (relative to workspace or absolute URL) */
  repo: string;
  /** Optional ref: branch name, tag, or commit hash */
  ref?: string;
  /** Whether the ref appears to be a commit hash */
  isCommitHash: boolean;
}

/**
 * Git spec with resolved commit hash
 */
export interface ResolvedGitSpec {
  /** Original spec string from template */
  originalSpec: GitSpec;
  /** Repository path */
  repo: string;
  /** Original ref (branch/tag/hash) if specified */
  ref?: string;
  /** Always an exact commit SHA */
  resolvedCommit: string;
}

/**
 * Resolved template with all refs converted to commit hashes
 */
export interface ResolvedTemplate {
  /** Optional human-readable name */
  name?: string;
  /** Optional description */
  description?: string;
  /** Resolved parent template info if extends was specified */
  extends?: {
    spec: GitSpec;
    resolvedCommit: string;
    resolvedTemplate: ResolvedTemplate;
  };
  /** Structure with all git specs resolved to commits */
  structure: Record<string, ResolvedGitSpec>;
  /** Source spec that produced this template */
  sourceSpec: GitSpec;
  /** Resolved commit of the template itself */
  sourceCommit: string;
}

/**
 * Immutable template specification used for caching.
 * Two templates with the same specHash are guaranteed identical.
 */
export interface ImmutableTemplateSpec {
  /** SHA256 hash of the canonical JSON representation */
  specHash: string;
  /** Flattened structure with all commits resolved */
  structure: Record<string, ResolvedGitSpec>;
  /** Chain of extended templates (for debugging/tracing) */
  inheritanceChain: string[];
}

/**
 * Template build status
 */
export type TemplateBuildState =
  | "pending"
  | "resolving"
  | "cloning"
  | "ready"
  | "error";

/**
 * Metadata for a cached template build
 */
export interface TemplateBuild {
  /** SHA256 hash identifying this build */
  specHash: string;
  /** The immutable spec this build was created from */
  spec: ImmutableTemplateSpec;
  /** Absolute path to the build directory */
  buildPath: string;
  /** Timestamp when build was created */
  createdAt: number;
  /** Current build state */
  buildState: TemplateBuildState;
  /** Error message if buildState is "error" */
  error?: string;
}

/**
 * Template resolution conflict information
 */
export interface TemplateConflict {
  /** Target path that has conflicting specs */
  targetPath: string;
  /** All conflicting specs for this path */
  specs: Array<{
    /** Which template defined this spec */
    source: string;
    /** The original git spec */
    spec: GitSpec;
    /** Repository path */
    repo: string;
    /** Resolved commit hash */
    resolvedCommit: string;
  }>;
}

/**
 * Error thrown when template resolution encounters conflicts
 */
export class TemplateConflictError extends Error {
  public readonly conflicts: TemplateConflict[];

  constructor(conflicts: TemplateConflict[]) {
    const paths = conflicts.map((c) => c.targetPath).join(", ");
    super(`Template conflict at paths: ${paths}`);
    this.name = "TemplateConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Error thrown when circular template extends is detected
 */
export class CircularExtendsError extends Error {
  public readonly chain: string[];

  constructor(chain: string[]) {
    super(`Circular template extends detected: ${chain.join(" -> ")}`);
    this.name = "CircularExtendsError";
    this.chain = chain;
  }
}

/**
 * Error thrown when path validation fails
 */
export class PathValidationError extends Error {
  public readonly targetPath: string;

  constructor(targetPath: string, reason: string) {
    super(`Invalid target path "${targetPath}": ${reason}`);
    this.name = "PathValidationError";
    this.targetPath = targetPath;
  }
}

/**
 * Progress callback for template operations
 */
export interface TemplateProgress {
  /** Current operation stage */
  stage: "resolving" | "cloning" | "copying";
  /** Human-readable message */
  message: string;
  /** Current item index (for multi-item operations) */
  current?: number;
  /** Total items (for multi-item operations) */
  total?: number;
}

/**
 * Parsed context ID components
 */
export interface ParsedContextId {
  /** First 12 chars of template spec hash */
  templateSpecHash: string;
  /** Instance identifier (can contain underscores) */
  instanceId: string;
}

/**
 * Context initialization marker written to .template-initialized
 */
export interface ContextInitMarker {
  /** Full spec hash of the template */
  specHash: string;
  /** Timestamp when context was initialized */
  initializedAt: number;
}

/**
 * Options for template resolution
 */
export interface ResolveOptions {
  /** Git client to use for fetching */
  // gitClient?: GitClient; // Will be added when integrating with git package
  /** Progress callback */
  onProgress?: (progress: TemplateProgress) => void;
}

/**
 * Options for template building
 */
export interface BuildOptions {
  /** Progress callback */
  onProgress?: (progress: TemplateProgress) => void;
  /** Force rebuild even if build exists */
  force?: boolean;
}

/**
 * Options for context initialization
 */
export interface InitOptions {
  /** Progress callback */
  onProgress?: (progress: TemplateProgress) => void;
}

/**
 * Minimal git config needed for partition building.
 * Only serverUrl and token are needed to clone repos.
 */
export interface PartitionBuildGitConfig {
  /** Git server base URL */
  serverUrl: string;
  /** Authentication token */
  token: string;
}
