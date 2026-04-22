import * as fs from "node:fs/promises";
import * as path from "node:path";
import chokidar from "chokidar";
import YAML from "yaml";
import { createDevLogger } from "@natstack/dev-log";
import { loadSecretsFromPath } from "../workspace/loader.js";

const log = createDevLogger("SecretsStore");

export type Unsubscribe = () => void;

export interface SecretsStore {
  get(key: string): string | undefined;
  require(key: string): string;
  has(key: string): boolean;
  list(): string[];
  watch(key: string, fn: (value: string | undefined) => void): Unsubscribe;
  watchAll(fn: (key: string, value: string | undefined) => void): Unsubscribe;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

type KeyListener = (value: string | undefined) => void;
type AllListener = (key: string, value: string | undefined) => void;

export const PROVIDER_ENV_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  replicate: "REPLICATE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  github: "GITHUB_TOKEN",
  nango: "NANGO_SECRET_KEY",
};

function canonicalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return PROVIDER_ENV_MAP[lower] ? lower : key;
}

function normalizeSecrets(input: Record<string, string>): Map<string, string> {
  const next = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      next.set(canonicalizeKey(key), value);
    }
  }
  return next;
}

function cloneSecrets(values: Map<string, string>): Map<string, string> {
  return new Map(values.entries());
}

function serializeSecrets(values: Map<string, string>): string {
  const sortedEntries = [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
  return YAML.stringify(Object.fromEntries(sortedEntries));
}

function diffSecrets(
  previous: Map<string, string>,
  next: Map<string, string>,
): Array<{ key: string; value: string | undefined }> {
  const keys = new Set<string>([...previous.keys(), ...next.keys()]);
  const changes: Array<{ key: string; value: string | undefined }> = [];
  for (const key of keys) {
    const prevValue = previous.get(key);
    const nextValue = next.get(key);
    if (prevValue !== nextValue) {
      changes.push({ key, value: nextValue });
    }
  }
  return changes;
}

async function writeSecretsAtomically(secretsPath: string, values: Map<string, string>): Promise<string> {
  const content = serializeSecrets(values);
  const directory = path.dirname(secretsPath);
  const tempPath = `${secretsPath}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, secretsPath);
  return content;
}

export function projectSecretsToEnv(secrets: Record<string, string>): void {
  const values = normalizeSecrets(secrets);
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
    if (process.env[envVar] !== undefined) continue;
    const value = values.get(provider);
    if (value !== undefined) {
      process.env[envVar] = value;
    }
  }
}

export function createSecretsStore(opts: { secretsPath: string }): SecretsStore {
  const { secretsPath } = opts;
  const externalOwned = new Set<string>();
  for (const envVar of Object.values(PROVIDER_ENV_MAP)) {
    if (process.env[envVar] !== undefined) {
      externalOwned.add(envVar);
    }
  }

  const keyListeners = new Map<string, Set<KeyListener>>();
  const allListeners = new Set<AllListener>();
  let values = normalizeSecrets(loadSecretsFromPath(secretsPath));
  let closed = false;
  let pendingSelfWriteContent: string | null = null;

  const watchedDirectory = path.dirname(secretsPath);
  const normalizedSecretsPath = path.resolve(secretsPath);
  const watcher = chokidar.watch(watchedDirectory, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 10,
    },
  });

  const safeInvoke = (listener: () => void): void => {
    try {
      listener();
    } catch (error) {
      log.warn("Secrets listener failed:", error);
    }
  };

  const projectEnvForChange = (key: string, value: string | undefined): void => {
    const envVar = PROVIDER_ENV_MAP[key.toLowerCase()];
    if (!envVar || externalOwned.has(envVar)) return;
    if (value === undefined) {
      delete process.env[envVar];
      return;
    }
    process.env[envVar] = value;
  };

  const projectAllToEnv = (): void => {
    for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
      if (externalOwned.has(envVar)) continue;
      const value = values.get(provider);
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
  };

  const emitChanges = (changes: Array<{ key: string; value: string | undefined }>): void => {
    for (const change of changes) {
      const listeners = keyListeners.get(change.key);
      if (listeners) {
        for (const listener of listeners) {
          safeInvoke(() => listener(change.value));
        }
      }
      for (const listener of allListeners) {
        safeInvoke(() => listener(change.key, change.value));
      }
    }
  };

  const applyValues = (next: Map<string, string>): void => {
    const changes = diffSecrets(values, next);
    if (changes.length === 0) return;
    values = next;
    for (const change of changes) {
      projectEnvForChange(change.key, change.value);
    }
    emitChanges(changes);
  };

  const reloadFromDisk = async (): Promise<void> => {
    if (closed) return;
    const next = normalizeSecrets(loadSecretsFromPath(secretsPath));
    const nextContent = serializeSecrets(next);
    if (pendingSelfWriteContent !== null && nextContent === pendingSelfWriteContent) {
      pendingSelfWriteContent = null;
      return;
    }
    pendingSelfWriteContent = null;
    applyValues(next);
  };

  const isSecretsFileEvent = (changedPath: string): boolean => path.resolve(changedPath) === normalizedSecretsPath;

  watcher.on("add", (changedPath) => {
    if (!isSecretsFileEvent(changedPath)) return;
    void reloadFromDisk();
  });
  watcher.on("change", (changedPath) => {
    if (!isSecretsFileEvent(changedPath)) return;
    void reloadFromDisk();
  });
  watcher.on("unlink", (changedPath) => {
    if (!isSecretsFileEvent(changedPath)) return;
    void reloadFromDisk();
  });
  watcher.on("error", (error) => {
    log.warn("Secrets file watcher failed:", error);
  });

  projectAllToEnv();

  return {
    get(key) {
      return values.get(canonicalizeKey(key));
    },
    require(key) {
      const value = values.get(canonicalizeKey(key));
      if (value !== undefined) return value;
      throw new Error(`Missing required secret "${key}". Add it to ${secretsPath}.`);
    },
    has(key) {
      return values.has(canonicalizeKey(key));
    },
    list() {
      return [...values.keys()].sort((left, right) => left.localeCompare(right));
    },
    watch(key, fn) {
      const canonicalKey = canonicalizeKey(key);
      const listeners = keyListeners.get(canonicalKey) ?? new Set<KeyListener>();
      listeners.add(fn);
      keyListeners.set(canonicalKey, listeners);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) {
          keyListeners.delete(canonicalKey);
        }
      };
    },
    watchAll(fn) {
      allListeners.add(fn);
      return () => {
        allListeners.delete(fn);
      };
    },
    async set(key, value) {
      const canonicalKey = canonicalizeKey(key);
      const next = cloneSecrets(values);
      if (next.get(canonicalKey) === value) return;
      next.set(canonicalKey, value);
      pendingSelfWriteContent = await writeSecretsAtomically(secretsPath, next);
      applyValues(next);
    },
    async delete(key) {
      const canonicalKey = canonicalizeKey(key);
      if (!values.has(canonicalKey)) return;
      const next = cloneSecrets(values);
      next.delete(canonicalKey);
      pendingSelfWriteContent = await writeSecretsAtomically(secretsPath, next);
      applyValues(next);
    },
    async close() {
      closed = true;
      keyListeners.clear();
      allListeners.clear();
      await watcher.close();
    },
  };
}
