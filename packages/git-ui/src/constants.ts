/**
 * Git UI configuration constants
 */

// Polling & refresh intervals (in milliseconds)
// These are intentionally the same to ensure we poll at 30s intervals
// and debounce any refresh that happened less than 30s ago
export const REFRESH_INTERVAL_MS = 30000;
export const MIN_REFRESH_AGE_MS = REFRESH_INTERVAL_MS;

// Diff thresholds
export const LARGE_DIFF_LINE_THRESHOLD = 300;
export const LARGE_FOLDER_FILE_THRESHOLD = 20;

// Commit history
export const INITIAL_COMMITS_DEPTH = 10;
export const COMMITS_PAGE_SIZE = 10;

// Cache limits
export const MAX_CACHED_COMMITS = 5;
export const MAX_CACHED_BLAME_ENTRIES = 20;
export const MAX_CACHED_HISTORY_ENTRIES = 20;
export const MAX_CACHED_DIFFS = 100;

// Cache TTL (in milliseconds)
export const BLAME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Editor heights (in pixels)
export const DEFAULT_EDITOR_HEIGHT = 400;
export const MIN_EDITOR_HEIGHT = 200;
export const MAX_EDITOR_HEIGHT = 800;
export const EDITOR_LINE_HEIGHT_PX = 20;

// Layout dimensions (in pixels)
export const FILE_TREE_WIDTH = 240;

// LocalStorage keys
export const DIFF_VIEW_STORAGE_KEY = "git-ui.diffViewOptions";

// Default diff view options
export const DEFAULT_DIFF_VIEW_OPTIONS = {
  viewMode: "split" as const,
  wordDiff: true,
  showWhitespace: false,
  contextLines: 3,
};

// Keyboard shortcuts
export const KEYBOARD_SHORTCUTS = [
  { key: "j / ↓", description: "Move focus down" },
  { key: "k / ↑", description: "Move focus up" },
  { key: "s", description: "Stage focused file" },
  { key: "u", description: "Unstage focused file" },
  { key: "d", description: "Discard focused file" },
  { key: "c", description: "Open commit form" },
  { key: "`", description: "Switch sections" },
  { key: "Escape", description: "Close dialogs" },
] as const;

// File extension to Monaco language mapping
export const FILE_EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  toml: "toml",
  ini: "ini",
  dockerfile: "dockerfile",
  makefile: "makefile",
};
