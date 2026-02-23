// =============================================================================
// @workspace/agentic-tools — Sandbox coding tool method definitions
// =============================================================================

// --- Tool registry ---
export {
  createAllToolMethodDefinitions,
  type CreateAllToolsOptions,
} from "./tools";

// --- Individual tool creators ---
export {
  createFileToolMethodDefinitions,
  fileRead,
  fileWrite,
  fileEdit,
  rm,
} from "./tools/file-tools";

export {
  createSearchToolMethodDefinitions,
  glob,
  grep,
} from "./tools/search-tools";

export {
  createDirectoryToolMethodDefinitions,
  tree,
  listDirectory,
} from "./tools/directory-tools";

export {
  createGitToolMethodDefinitions,
  gitStatus,
  gitDiff,
  gitLog,
  gitAdd,
  gitCommit,
  gitCheckout,
} from "./tools/git-tools";

export {
  createTypeCheckToolMethodDefinitions,
  checkTypes,
  getTypeInfo,
  getCompletions,
  type DiagnosticsPublisher,
} from "./tools/typecheck-tools";

export {
  createWorkspaceToolMethodDefinitions,
  workspaceList,
  workspaceClone,
  contextInfo,
} from "./tools/workspace-tools";

// --- Utilities ---
export { resolvePath } from "./tools/utils";

// --- Eval ---
export {
  executeEvalTool,
  EVAL_DEFAULT_TIMEOUT_MS,
  EVAL_MAX_TIMEOUT_MS,
  EVAL_FRAMEWORK_TIMEOUT_MS,
} from "./eval/evalTool";
export type { EvalToolArgs, EvalToolResult } from "./eval/evalTool";
