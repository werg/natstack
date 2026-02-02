/**
 * Shared Zod schemas for standard agentic tools.
 *
 * These schemas define the API contract for file, search, directory, and git tools
 * that can be exposed via pubsub RPC. They ensure compatibility between:
 * - Panel implementations (providers)
 * - Worker tool definitions (consumers)
 * - Claude Code expected tool APIs
 */

import { z } from "zod";

// ============================================================================
// File Operations
// ============================================================================

/**
 * file_read - Read file contents with optional pagination
 * Matches Claude Code `Read` tool behavior
 */
export const FileReadArgsSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to read"),
  offset: z.number().optional().describe("Line number to start from (1-indexed, default: 1)"),
  limit: z.number().optional().describe("Number of lines to read (default: 2000)"),
});
export type FileReadArgs = z.infer<typeof FileReadArgsSchema>;

/**
 * file_write - Create or overwrite a file
 * Matches Claude Code `Write` tool behavior
 */
export const FileWriteArgsSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to write"),
  content: z.string().describe("Content to write to the file"),
});
export type FileWriteArgs = z.infer<typeof FileWriteArgsSchema>;

/**
 * file_edit - String replacement editing
 * Matches Claude Code `Edit` tool behavior
 */
export const FileEditArgsSchema = z.object({
  file_path: z.string().describe("Absolute path to the file to edit"),
  old_string: z.string().describe("Text to find and replace"),
  new_string: z.string().describe("Replacement text (must differ from old_string)"),
  replace_all: z.boolean().optional().default(false).describe("Replace all occurrences (default: false)"),
});
export type FileEditArgs = z.infer<typeof FileEditArgsSchema>;

/**
 * rm - Delete files or directories
 */
export const RmArgsSchema = z.object({
  path: z.string().describe("Path to file or directory to delete"),
  recursive: z.boolean().optional().default(false).describe("Required true for non-empty directories"),
});
export type RmArgs = z.infer<typeof RmArgsSchema>;

// ============================================================================
// Search & Discovery
// ============================================================================

/**
 * glob - Find files by pattern
 * Matches Claude Code `Glob` tool behavior
 */
export const GlobArgsSchema = z.object({
  pattern: z.string().describe("Glob pattern to match files against (e.g., '**/*.ts', 'src/**/*.tsx')"),
  path: z.string().optional().describe("Directory to search in (default: workspace root)"),
});
export type GlobArgs = z.infer<typeof GlobArgsSchema>;

/**
 * grep - Search file contents
 * Matches Claude Code `Grep` tool behavior (ripgrep-compatible)
 */
export const GrepArgsSchema = z.object({
  pattern: z.string().describe("Regular expression pattern to search for"),
  path: z.string().optional().describe("File or directory to search in (default: workspace root)"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional().default("files_with_matches")
    .describe("Output mode: 'content' shows lines, 'files_with_matches' shows paths (default), 'count' shows counts"),
  glob: z.string().optional().describe("Filter by glob pattern (e.g., '*.ts')"),
  type: z.string().optional().describe("Filter by file type: 'js', 'ts', 'py', 'go', 'rust', 'java', etc."),
  "-i": z.boolean().optional().describe("Case insensitive search"),
  "-n": z.boolean().optional().default(true).describe("Show line numbers (default: true for content mode)"),
  "-A": z.number().optional().describe("Lines after match (context)"),
  "-B": z.number().optional().describe("Lines before match (context)"),
  "-C": z.number().optional().describe("Lines before AND after match"),
  "-w": z.boolean().optional().describe("Match whole words only (word boundary matching)"),
  "-F": z.boolean().optional().describe("Fixed string matching (treat pattern as literal, not regex)"),
  head_limit: z.number().optional().describe("Limit results"),
  offset: z.number().optional().describe("Skip first N results"),
  multiline: z.boolean().optional().describe("Enable multiline matching"),
});
export type GrepArgs = z.infer<typeof GrepArgsSchema>;

// ============================================================================
// Directory Tools
// ============================================================================

/**
 * tree - Show directory structure
 */
export const TreeArgsSchema = z.object({
  path: z.string().optional().describe("Directory to list (default: workspace root)"),
  depth: z.number().optional().default(3).describe("Max depth (default: 3)"),
  show_hidden: z.boolean().optional().default(false).describe("Include hidden files (default: false)"),
  dirs_only: z.boolean().optional().default(false).describe("Only show directories (default: false)"),
});
export type TreeArgs = z.infer<typeof TreeArgsSchema>;

/**
 * list_directory - List directory contents
 * Matches `ls -la` output format
 */
export const ListDirectoryArgsSchema = z.object({
  path: z.string().describe("Directory to list"),
});
export type ListDirectoryArgs = z.infer<typeof ListDirectoryArgsSchema>;

// ============================================================================
// Git Operations (via isomorphic-git)
// ============================================================================

/**
 * git_status - Repository status
 */
export const GitStatusArgsSchema = z.object({
  path: z.string().optional().describe("Repository path (default: workspace root)"),
});
export type GitStatusArgs = z.infer<typeof GitStatusArgsSchema>;

/**
 * git_diff - Show file changes
 */
export const GitDiffArgsSchema = z.object({
  path: z.string().optional().describe("Repository path"),
  staged: z.boolean().optional().describe("Show staged changes (like --cached)"),
  file: z.string().optional().describe("Specific file to diff"),
});
export type GitDiffArgs = z.infer<typeof GitDiffArgsSchema>;

/**
 * git_log - Commit history
 */
export const GitLogArgsSchema = z.object({
  path: z.string().optional().describe("Repository path"),
  limit: z.number().optional().default(10).describe("Number of commits (default: 10)"),
  format: z.enum(["oneline", "full"]).optional().default("oneline").describe("Output format"),
});
export type GitLogArgs = z.infer<typeof GitLogArgsSchema>;

/**
 * git_add - Stage files
 */
export const GitAddArgsSchema = z.object({
  files: z.array(z.string()).describe("Files to stage"),
  path: z.string().optional().describe("Repository path"),
});
export type GitAddArgs = z.infer<typeof GitAddArgsSchema>;

/**
 * git_commit - Create commits
 */
export const GitCommitArgsSchema = z.object({
  message: z.string().describe("Commit message"),
  path: z.string().optional().describe("Repository path"),
});
export type GitCommitArgs = z.infer<typeof GitCommitArgsSchema>;

/**
 * git_checkout - Switch branches or restore files
 */
export const GitCheckoutArgsSchema = z.object({
  branch: z.string().optional().describe("Branch to checkout"),
  file: z.string().optional().describe("File to restore"),
  create: z.boolean().optional().describe("Create new branch (-b flag)"),
  path: z.string().optional().describe("Repository path"),
});
export type GitCheckoutArgs = z.infer<typeof GitCheckoutArgsSchema>;

// ============================================================================
// Workspace Discovery Tools
// ============================================================================

/**
 * workspace_list - List available repos in the workspace
 */
export const WorkspaceListArgsSchema = z.object({
  category: z.enum(["panels", "workers", "contexts", "packages", "skills", "all"])
    .optional()
    .default("all")
    .describe("Filter by workspace category (skills are repos with SKILL.md providing agent instructions)"),
});
export type WorkspaceListArgs = z.infer<typeof WorkspaceListArgsSchema>;

/**
 * workspace_clone - Clone a repo into the current context's OPFS
 */
export const WorkspaceCloneArgsSchema = z.object({
  repo_spec: z.string().describe("Repo spec like 'panels/editor', 'panels/editor#main', or 'panels/editor@v1.0.0'"),
  mount_path: z.string().optional().describe("Mount path in context (default: /workspace/<repo_path>)"),
});
export type WorkspaceCloneArgs = z.infer<typeof WorkspaceCloneArgsSchema>;

/**
 * context_info - Show what repos are mounted in the current context
 */
export const ContextInfoArgsSchema = z.object({});
export type ContextInfoArgs = z.infer<typeof ContextInfoArgsSchema>;

/**
 * context_template_list - List available context templates in the workspace
 */
export const ContextTemplateListArgsSchema = z.object({});
export type ContextTemplateListArgs = z.infer<typeof ContextTemplateListArgsSchema>;

/**
 * context_template_read - Read a context template's YAML
 */
export const ContextTemplateReadArgsSchema = z.object({
  template_spec: z.string().describe("Template spec to read (e.g., 'contexts/default')"),
});
export type ContextTemplateReadArgs = z.infer<typeof ContextTemplateReadArgsSchema>;

// ============================================================================
// Plan Mode Tools
// ============================================================================

/**
 * Allowed prompt for bash permissions requested during plan mode exit.
 * These are semantic descriptions of actions, not literal commands.
 */
export const AllowedPromptSchema = z.object({
  tool: z.literal("Bash"),
  prompt: z.string().describe("Semantic description of the action, e.g. 'run tests', 'install dependencies'"),
});
export type AllowedPrompt = z.infer<typeof AllowedPromptSchema>;

/**
 * exit_plan_mode - Exit plan mode and request approval to proceed
 * Matches Claude Code `ExitPlanMode` tool behavior.
 *
 * When Claude exits plan mode, it can optionally request bash permissions
 * that will be auto-approved during implementation.
 *
 * Note: The SDK may pass additional undocumented fields like planFilePath.
 * We accept those via passthrough() to display them in the UI.
 */
export const ExitPlanModeArgsSchema = z.object({
  allowedPrompts: z.array(AllowedPromptSchema).optional()
    .describe("Bash permissions needed to implement the plan"),
}).passthrough(); // Accept additional SDK fields like planFilePath

export type ExitPlanModeArgs = z.infer<typeof ExitPlanModeArgsSchema> & {
  /** Path to the plan file (may be passed by SDK) */
  planFilePath?: string;
  /** The plan content itself (Markdown) */
  plan?: string;
};

/**
 * enter_plan_mode - Enter plan mode for exploration and planning
 * Matches Claude Code `EnterPlanMode` tool behavior.
 *
 * When Claude enters plan mode, it switches to read-only exploration
 * and creates a plan file for user review.
 */
export const EnterPlanModeArgsSchema = z.object({}).passthrough();

export type EnterPlanModeArgs = z.infer<typeof EnterPlanModeArgsSchema>;

// ============================================================================
// Type Checking Tools
// ============================================================================

/**
 * check_types - Run TypeScript type checking on panel/worker files
 * Returns diagnostics (errors, warnings) from the TypeScript compiler
 */
export const CheckTypesArgsSchema = z.object({
  panel_path: z.string().describe("Root path of the panel/worker being developed"),
  file_path: z.string().optional().describe("Specific file to check (checks all if omitted)"),
});
export type CheckTypesArgs = z.infer<typeof CheckTypesArgsSchema>;

/**
 * get_type_info - Get TypeScript type information at a position
 * Useful for understanding types and getting documentation
 */
export const GetTypeInfoArgsSchema = z.object({
  panel_path: z.string().describe("Root path of the panel/worker"),
  file_path: z.string().describe("Path to the file"),
  line: z.number().describe("Line number (1-indexed)"),
  column: z.number().describe("Column number (1-indexed)"),
});
export type GetTypeInfoArgs = z.infer<typeof GetTypeInfoArgsSchema>;

/**
 * get_completions - Get code completions at a position
 */
export const GetCompletionsArgsSchema = z.object({
  panel_path: z.string().describe("Root path of the panel/worker"),
  file_path: z.string().describe("Path to the file"),
  line: z.number().describe("Line number (1-indexed)"),
  column: z.number().describe("Column number (1-indexed)"),
});
export type GetCompletionsArgs = z.infer<typeof GetCompletionsArgsSchema>;

// ============================================================================
// File type mappings for grep
// ============================================================================

export const FILE_TYPE_MAPPINGS: Record<string, string[]> = {
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  py: ["*.py", "*.pyw"],
  go: ["*.go"],
  rust: ["*.rs"],
  java: ["*.java"],
  c: ["*.c", "*.h"],
  cpp: ["*.cpp", "*.cc", "*.cxx", "*.hpp", "*.hh", "*.hxx"],
  ruby: ["*.rb"],
  php: ["*.php"],
  swift: ["*.swift"],
  kotlin: ["*.kt", "*.kts"],
  scala: ["*.scala"],
  html: ["*.html", "*.htm"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  json: ["*.json"],
  yaml: ["*.yaml", "*.yml"],
  md: ["*.md", "*.markdown"],
  sql: ["*.sql"],
  shell: ["*.sh", "*.bash", "*.zsh"],
};

// ============================================================================
// TOOL NAMING CONVENTIONS - READ THIS BEFORE MODIFYING TOOL CODE
// ============================================================================
//
// This codebase uses THREE naming conventions for tools:
//
// | Convention | Example | Where Used |
// |------------|---------|------------|
// | snake_case | file_read | Wire protocol, method registration, execution |
// | PascalCase | Read | LLM system prompts, tool descriptions |
// | Prefixed | pubsub_abc_file_read | createToolsForAgentSDK() internal |
//
// KEY FUNCTIONS:
// - getCanonicalToolName(snake) → PascalCase (for LLM display)
// - getPubsubMethodName(Pascal) → snake_case (for execution)
// - createToolsForAgentSDK() generates prefixed names internally
//
// When adding new tools:
// 1. Define schema with snake_case name
// 2. Add mapping in CANONICAL_TOOL_MAPPINGS
// 3. Use getCanonicalToolName() when showing to LLM
// ============================================================================

/**
 * Mapping from pubsub tool names to Claude Code canonical tool names.
 * Used to provide familiar tool names to the LLM while using pubsub RPC underneath.
 */
export const CANONICAL_TOOL_MAPPINGS: Record<string, string> = {
  // File operations
  file_read: "Read",
  file_write: "Write",
  file_edit: "Edit",
  rm: "Remove",
  // Search tools
  glob: "Glob",
  grep: "Grep",
  // Directory tools
  tree: "Tree",
  list_directory: "ListDirectory",
  // Git tools - map to Bash-like names for LLM familiarity
  git_status: "GitStatus",
  git_diff: "GitDiff",
  git_log: "GitLog",
  git_add: "GitAdd",
  git_commit: "GitCommit",
  git_checkout: "GitCheckout",
  // Workspace tools
  workspace_list: "WorkspaceList",
  workspace_clone: "WorkspaceClone",
  context_info: "ContextInfo",
  context_template_list: "ContextTemplateList",
  context_template_read: "ContextTemplateRead",
  // Plan mode
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
  // Type checking tools
  check_types: "CheckTypes",
  get_type_info: "GetTypeInfo",
  get_completions: "GetCompletions",
};

/**
 * Reverse mapping from canonical names to pubsub tool names.
 */
export const REVERSE_CANONICAL_MAPPINGS: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TOOL_MAPPINGS).map(([pubsub, canonical]) => [canonical, pubsub])
);

/**
 * Extract the actual method name from a prefixed tool name.
 *
 * Handles known prefix formats:
 * - pubsub_providerId_methodName → methodName (e.g., "pubsub_abc123_file_read" → "file_read")
 * - mcp__server__methodName → methodName (e.g., "mcp__workspace__ListDirectory" → "ListDirectory")
 *
 * Does NOT strip parts from regular snake_case names like "exit_plan_mode".
 *
 * This function is defined here (not in tool-approval.ts) to avoid
 * circular dependencies, since tool-approval imports from tool-schemas.
 */
export function extractMethodName(toolName: string): string {
  // Handle MCP prefix format: mcp__server__methodName
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      return parts.slice(2).join("__");
    }
  }

  // Handle pubsub prefix format: pubsub_providerId_methodName
  if (toolName.startsWith("pubsub_")) {
    const parts = toolName.split("_");
    if (parts.length >= 3) {
      return parts.slice(2).join("_");
    }
  }

  // No known prefix - return as-is
  return toolName;
}

/**
 * Extract the display name from a tool name, stripping MCP/pubsub prefixes
 * and applying canonical name mappings.
 *
 * Examples:
 * - "mcp__workspace__ListDirectory" → "ListDirectory"
 * - "mcp__proxy-uuid__Read" → "Read"
 * - "pubsub_abc123_file_read" → "Read"
 * - "file_read" → "Read"
 * - "list_directory" → "ListDirectory"
 */
export function prettifyToolName(toolName: string): string {
  let name = toolName;

  // Strip MCP prefix: mcp__<server>__<name> → <name>
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) {
    name = mcpMatch[1]!;
  }
  // Strip pubsub prefix: pubsub_<providerId>_<methodName> → <methodName>
  else if (name.startsWith("pubsub_")) {
    name = extractMethodName(name);
  }

  // Apply canonical mapping if available
  const canonical = CANONICAL_TOOL_MAPPINGS[name];
  if (canonical) {
    return canonical;
  }

  // If name is already PascalCase (canonical), return as-is
  if (/^[A-Z][a-zA-Z]+$/.test(name)) {
    return name;
  }

  // Convert snake_case to TitleCase as fallback
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/**
 * Required methods for restricted mode (no bash access).
 * These are the minimum set of methods needed for file operations,
 * workspace discovery, and context management without shell.
 */
export const RESTRICTED_MODE_REQUIRED_METHODS = [
  "file_read",
  "file_write",
  "file_edit",
  "glob",
  "grep",
  "tree",
  "list_directory",
  "git_status",
  "git_diff",
  "git_log",
  "workspace_list",
  "workspace_clone",
  "context_info",
  "context_template_list",
  "context_template_read",
] as const;

/**
 * Optional methods that enhance restricted mode functionality.
 */
export const RESTRICTED_MODE_OPTIONAL_METHODS = [
  "rm",
  "git_add",
  "git_commit",
  "git_checkout",
] as const;

/**
 * All restricted-mode tools that can be exposed via pubsub RPC.
 * These are the canonical tool names used across all workers in restricted mode.
 */
export const CANONICAL_PUBSUB_TOOL_NAMES = [
  ...RESTRICTED_MODE_REQUIRED_METHODS,
  ...RESTRICTED_MODE_OPTIONAL_METHODS,
] as const;

export type PubsubToolName = typeof CANONICAL_PUBSUB_TOOL_NAMES[number];


// ============================================================================
// Tool Groups for Conflict Resolution
// ============================================================================

import type { ToolGroup } from "./types.js";

/**
 * Tool groups - each is atomic for conflict resolution.
 * Providers claim entire groups, not individual tools.
 */
export const TOOL_GROUPS: Record<ToolGroup, readonly string[]> = {
  "file-ops": ["file_read", "file_write", "file_edit", "rm", "glob", "grep", "tree", "list_directory"],
  "git-ops": ["git_status", "git_diff", "git_log", "git_add", "git_commit", "git_checkout"],
  "workspace-ops": [
    "workspace_list",
    "workspace_clone",
    "context_info",
    "context_template_list",
    "context_template_read",
  ],
} as const;

/** List of all tool group names for iteration */
export const ALL_TOOL_GROUPS = Object.keys(TOOL_GROUPS) as ToolGroup[];

/**
 * Pre-computed reverse lookup: tool name -> groups it belongs to.
 * Built at module load time to avoid iteration in hot path.
 */
const TOOL_TO_GROUPS = new Map<string, ToolGroup[]>();
for (const [group, tools] of Object.entries(TOOL_GROUPS) as Array<[ToolGroup, readonly string[]]>) {
  for (const tool of tools) {
    const existing = TOOL_TO_GROUPS.get(tool) ?? [];
    existing.push(group);
    TOOL_TO_GROUPS.set(tool, existing);
  }
}

/**
 * Get all tools belonging to the specified groups.
 */
export function getToolsForGroups(groups: ToolGroup[]): string[] {
  const tools: string[] = [];
  for (const group of groups) {
    tools.push(...TOOL_GROUPS[group]);
  }
  return tools;
}

/**
 * Get which groups a tool belongs to.
 * Uses pre-computed lookup for O(1) access.
 */
export function getGroupsForTool(toolName: string): ToolGroup[] {
  return TOOL_TO_GROUPS.get(toolName) ?? [];
}

// ============================================================================
// Method Availability Validation
// ============================================================================

/**
 * Result of validating required methods.
 */
export interface MethodValidationResult {
  /** Whether all required methods are available */
  ok: boolean;
  /** List of missing required method names */
  missing: string[];
  /** List of available method names */
  available: string[];
  /** Map of method name to provider ID for available methods */
  providers: Record<string, string>;
}

/**
 * Discovered method info (minimal interface for validation).
 */
export interface DiscoveredMethodInfo {
  name: string;
  providerId: string;
}

/**
 * Validate that required methods are available from discovered methods.
 *
 * @param discoveredMethods - Array of discovered method definitions
 * @param requiredMethods - Array of required method names (defaults to CLAUDE_CODE_REQUIRED_METHODS)
 * @returns Validation result with missing/available methods
 *
 * @example
 * ```typescript
 * const methods = client.discoverMethodDefs();
 * const result = validateRequiredMethods(methods);
 * if (!result.ok) {
 *   console.error(`Missing methods: ${result.missing.join(", ")}`);
 * }
 * ```
 */
export function validateRequiredMethods(
  discoveredMethods: DiscoveredMethodInfo[],
  requiredMethods: readonly string[] = RESTRICTED_MODE_REQUIRED_METHODS
): MethodValidationResult {
  const availableMap = new Map<string, string>();
  for (const method of discoveredMethods) {
    // First provider wins (don't override if already set)
    if (!availableMap.has(method.name)) {
      availableMap.set(method.name, method.providerId);
    }
  }

  const available = [...availableMap.keys()];
  const missing = requiredMethods.filter((name) => !availableMap.has(name));
  const providers: Record<string, string> = {};
  for (const [name, providerId] of availableMap) {
    providers[name] = providerId;
  }

  return {
    ok: missing.length === 0,
    missing: [...missing],
    available,
    providers,
  };
}

/**
 * Get the canonical tool name for a pubsub method name.
 * Returns the original name if no mapping exists.
 */
export function getCanonicalToolName(pubsubName: string): string {
  return CANONICAL_TOOL_MAPPINGS[pubsubName] ?? pubsubName;
}

/**
 * Get the pubsub method name for a canonical tool name.
 * Returns the original name if no mapping exists.
 */
export function getPubsubMethodName(canonicalName: string): string {
  return REVERSE_CANONICAL_MAPPINGS[canonicalName] ?? canonicalName;
}

// ============================================================================
// Tool Name Normalization
// ============================================================================

/**
 * Normalize any tool name format to pubsub snake_case format.
 *
 * Handles:
 * - Prefixed names: "pubsub_abc123_file_edit" → "file_edit"
 * - PascalCase: "Edit" → "file_edit"
 * - Already normalized: "file_edit" → "file_edit"
 *
 * @param toolName - Tool name in any format
 * @returns Normalized snake_case pubsub method name
 */
export function normalizeToolName(toolName: string): string {
  // First strip prefix if present
  const stripped = extractMethodName(toolName);
  // Then try to map from PascalCase to snake_case
  return getPubsubMethodName(stripped);
}

// ============================================================================
// Rich Preview Support
// ============================================================================

/**
 * Tools that have rich preview support in the UI (snake_case pubsub format).
 * Used by worker-base.ts to determine whether to use toolPreview or code field.
 */
export const RICH_PREVIEW_TOOLS = [
  "file_edit",
  "file_write",
  "rm",
  "git_commit",
  "git_checkout",
  "git_add",
  "enter_plan_mode",
  "exit_plan_mode",
] as const;

export type RichPreviewToolName = (typeof RICH_PREVIEW_TOOLS)[number];

/**
 * Check if a tool has rich preview support.
 * Accepts any naming format and normalizes before checking.
 *
 * @param toolName - Tool name in any format (prefixed, PascalCase, or snake_case)
 * @returns True if the tool has rich preview support
 */
export function hasRichPreview(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return (RICH_PREVIEW_TOOLS as readonly string[]).includes(normalized);
}

// ============================================================================
// Type Guards for Tool Arguments
// ============================================================================

/**
 * Type guards for rich preview tool arguments.
 * These use Zod schemas for validation, ensuring consistency with the schema definitions.
 */

export function isFileEditArgs(args: unknown): args is FileEditArgs {
  return FileEditArgsSchema.safeParse(args).success;
}

export function isFileWriteArgs(args: unknown): args is FileWriteArgs {
  return FileWriteArgsSchema.safeParse(args).success;
}

export function isRmArgs(args: unknown): args is RmArgs {
  return RmArgsSchema.safeParse(args).success;
}

export function isGitCommitArgs(args: unknown): args is GitCommitArgs {
  return GitCommitArgsSchema.safeParse(args).success;
}

export function isGitCheckoutArgs(args: unknown): args is GitCheckoutArgs {
  // At least one of branch or file should be specified
  const result = GitCheckoutArgsSchema.safeParse(args);
  if (!result.success) return false;
  return result.data.branch !== undefined || result.data.file !== undefined;
}

export function isGitAddArgs(args: unknown): args is GitAddArgs {
  return GitAddArgsSchema.safeParse(args).success;
}

export function isExitPlanModeArgs(args: unknown): args is ExitPlanModeArgs {
  return ExitPlanModeArgsSchema.safeParse(args).success;
}

export function isEnterPlanModeArgs(args: unknown): args is EnterPlanModeArgs {
  return EnterPlanModeArgsSchema.safeParse(args).success;
}
