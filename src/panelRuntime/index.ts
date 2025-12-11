/**
 * Panel Runtime - Unified runtime for browser panels
 *
 * This module provides all the runtime APIs needed by panels:
 * - File system (fs, fs/promises) via ZenFS OPFS backend
 * - Git operations via @natstack/git with isomorphic-git
 * - Bootstrap functionality for auto-cloning repoArgs
 *
 * All APIs use lazy initialization to avoid race conditions.
 * The virtual module plugin in panelBuilder maps imports to this bundle.
 */

// Re-export fs APIs
// Named exports for various import patterns
export {
  fs,
  promises,
  ready,
} from "./fs.js";

// Also export as fsPromises/fsReady for explicit naming
export { promises as fsPromises, ready as fsReady } from "./fs.js";

// Default export for `import fs from "fs"`
export { default } from "./fs.js";

// Re-export individual fs/promises methods for destructured imports
// e.g., `import { readFile, writeFile } from "fs/promises"`
export {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  lstat,
  unlink,
  rmdir,
  rm,
  rename,
  copyFile,
  access,
  chmod,
  chown,
  truncate,
  appendFile,
  realpath,
  link,
  symlink,
  readlink,
} from "./fs.js";

// Re-export git APIs (includes isomorphic-git with Buffer polyfill)
export {
  GitClient,
  bootstrap,
  hasSource,
  createFsAdapter,
} from "@natstack/git";

export type {
  GitClientFs,
  GitClientOptions,
  CloneOptions,
  PullOptions,
  PushOptions,
  CommitOptions,
  RepoStatus,
  FileStatus,
  BootstrapConfig,
  BootstrapResult,
  RepoArgSpec,
  NormalizedRepoArg,
  FsPromisesLike,
} from "@natstack/git";

// Re-export bootstrap runner
export { runPanelBootstrap, getBootstrapResult, isBootstrapped } from "./bootstrap.js";
