import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceConfig, WorkspaceGitRemoteConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const SAFE_REMOTE_NAME = /^[A-Za-z0-9._-]+$/;
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9._@-]+$/;

export interface ResolvedWorkspaceGitRemote {
  repoPath: string;
  section: string;
  repoKey: string;
  name: string;
  url: string;
}

export interface SyncDeclaredRemoteResult {
  repoPath: string;
  applied: boolean;
  removedManaged: string[];
  remotes: ResolvedWorkspaceGitRemote[];
}

export function normalizeWorkspaceRepoPath(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid workspace repo path: ${repoPath}`);
  }
  const segments = normalized.split("/");
  if (segments.length < 2 || segments.some((segment) => !SAFE_REPO_SEGMENT.test(segment))) {
    throw new Error(`Invalid workspace repo path: ${repoPath}`);
  }
  return normalized;
}

export function getDeclaredRemotesForRepo(
  config: WorkspaceConfig,
  repoPathInput: string,
): ResolvedWorkspaceGitRemote[] {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const remotes = config.git?.remotes?.[section!]?.[repoKey] ?? {};
  return Object.entries(remotes)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, url]) => validateWorkspaceGitRemoteEntry(repoPath, section!, repoKey, name, url))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getDeclaredRemoteForRepo(
  config: WorkspaceConfig,
  repoPathInput: string,
  name = "origin",
): ResolvedWorkspaceGitRemote | null {
  return getDeclaredRemotesForRepo(config, repoPathInput).find((remote) => remote.name === name) ?? null;
}

export function validateWorkspaceGitRemote(remote: WorkspaceGitRemoteConfig): WorkspaceGitRemoteConfig {
  if (!remote || typeof remote !== "object") {
    throw new Error("Remote declaration is required");
  }
  const name = validateWorkspaceGitRemoteName(remote.name);
  const url = normalizeRemoteUrl(remote.url);
  return { name, url };
}

export function validateWorkspaceGitRemoteName(nameInput: string): string {
  const name = nameInput.trim();
  if (!name || !SAFE_REMOTE_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid remote name: ${nameInput}`);
  }
  return name;
}

function validateWorkspaceGitRemoteEntry(
  repoPath: string,
  section: string,
  repoKey: string,
  nameInput: string,
  urlInput: string,
): ResolvedWorkspaceGitRemote {
  const name = validateWorkspaceGitRemoteName(nameInput);
  return {
    repoPath,
    section,
    repoKey,
    name,
    url: normalizeRemoteUrl(urlInput),
  };
}

export function normalizeRemoteUrl(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Remote URL is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid remote URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Remote URL must use http or https: ${value}`);
  }
  if (url.username || url.password) {
    throw new Error("Remote URL must not contain embedded credentials");
  }
  url.hash = "";
  return url.href;
}

export function setDeclaredRemoteInConfig(
  config: WorkspaceConfig,
  repoPathInput: string,
  remote: WorkspaceGitRemoteConfig,
): WorkspaceConfig {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const normalized = validateWorkspaceGitRemote(remote);
  const git = config.git ?? {};
  const remotes = git.remotes ?? {};
  const sectionRemotes = remotes[section!] ?? {};
  return {
    ...config,
    git: {
      ...git,
      remotes: {
        ...remotes,
        [section!]: {
          ...sectionRemotes,
          [repoKey]: {
            ...(sectionRemotes[repoKey] ?? {}),
            [normalized.name]: normalized.url,
          },
        },
      },
    },
  };
}

export function removeDeclaredRemoteFromConfig(
  config: WorkspaceConfig,
  repoPathInput: string,
  remoteName: string,
): WorkspaceConfig {
  const repoPath = normalizeWorkspaceRepoPath(repoPathInput);
  const [section, ...repoParts] = repoPath.split("/");
  const repoKey = repoParts.join("/");
  const normalizedRemoteName = validateWorkspaceGitRemoteName(remoteName);
  const git = config.git ?? {};
  const remotes = git.remotes ?? {};
  const sectionRemotes = { ...(remotes[section!] ?? {}) };
  const repoRemotes = { ...(sectionRemotes[repoKey] ?? {}) };
  delete repoRemotes[normalizedRemoteName];
  if (Object.keys(repoRemotes).length > 0) {
    sectionRemotes[repoKey] = repoRemotes;
  } else {
    delete sectionRemotes[repoKey];
  }
  return {
    ...config,
    git: {
      ...git,
      remotes: {
        ...remotes,
        [section!]: sectionRemotes,
      },
    },
  };
}

export async function syncDeclaredRemoteForRepo(options: {
  config: WorkspaceConfig;
  workspaceRoot: string;
  repoPath: string;
}): Promise<SyncDeclaredRemoteResult> {
  const repoPath = normalizeWorkspaceRepoPath(options.repoPath);
  const repoDir = path.join(options.workspaceRoot, repoPath);
  const gitDir = path.join(repoDir, ".git");
  try {
    await fs.access(gitDir);
  } catch {
    return { repoPath, applied: false, removedManaged: [], remotes: [] };
  }

  const remotes = getDeclaredRemotesForRepo(options.config, repoPath);
  const remoteNames = new Set(remotes.map((remote) => remote.name));
  const managedNames = await listManagedRemoteNames(repoDir);
  const removedManaged: string[] = [];
  for (const name of managedNames) {
    if (!remoteNames.has(name)) {
      await removeRemote(repoDir, name);
      removedManaged.push(name);
    }
  }

  if (remotes.length === 0) {
    return { repoPath, applied: false, removedManaged, remotes };
  }

  for (const remote of remotes) {
    await upsertRemote(repoDir, remote);
  }
  return { repoPath, applied: true, removedManaged, remotes };
}

async function upsertRemote(repoDir: string, remote: ResolvedWorkspaceGitRemote): Promise<void> {
  const existing = await gitConfig(repoDir, ["remote", "get-url", remote.name]);
  if (existing.ok) {
    await gitConfig(repoDir, ["remote", "set-url", remote.name, remote.url]);
  } else {
    await gitConfig(repoDir, ["remote", "add", remote.name, remote.url]);
  }
  await gitConfig(repoDir, ["config", `remote.${remote.name}.natstack-managed`, "true"], true);
}

async function removeRemote(repoDir: string, name: string): Promise<void> {
  await gitConfig(repoDir, ["remote", "remove", name]);
}

async function listManagedRemoteNames(repoDir: string): Promise<string[]> {
  const result = await gitConfig(repoDir, ["config", "--get-regexp", "^remote\\..*\\.natstack-managed$"]);
  if (!result.ok) return [];
  const names = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^remote\.(.+)\.natstack-managed\s+true$/);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

async function gitConfig(
  cwd: string,
  args: string[],
  throwOnError = false,
): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string; stderr: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return { ok: true, stdout };
  } catch (error) {
    if (throwOnError) throw error;
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
