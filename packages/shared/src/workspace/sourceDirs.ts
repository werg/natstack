export const WORKSPACE_SOURCE_DIRS = [
  "meta",
  "panels",
  "apps",
  "packages",
  "agents",
  "workers",
  "extensions",
  "skills",
  "about",
  "templates",
  "projects",
] as const;

export type WorkspaceSourceDir = typeof WORKSPACE_SOURCE_DIRS[number];

export const WORKSPACE_STATE_DIRS = [".cache", ".databases", ".contexts"] as const;

export const WORKSPACE_GIT_INIT_PATTERNS = [
  "panels/*",
  "apps/*",
  "packages/*",
  "agents/*",
  "workers/*",
  "extensions/*",
  "skills/*",
  "about/*",
  "templates/*",
  "projects/*",
] as const;

export const WORKSPACE_IMPORT_PARENT_DIRS = [
  "panels",
  "apps",
  "packages",
  "agents",
  "workers",
  "extensions",
  "skills",
  "about",
  "templates",
  "projects",
] as const;

export type WorkspaceImportParentDir = typeof WORKSPACE_IMPORT_PARENT_DIRS[number];
