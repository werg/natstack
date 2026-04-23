import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Credential } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 250;

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function getDefaultBasePath(): string {
  const homeDir = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!homeDir) {
    throw new Error("Unable to resolve a home directory for credential storage");
  }
  return path.join(homeDir, ".natstack", "credentials");
}

export class CredentialStore {
  private readonly basePath: string;

  constructor(options: { basePath?: string } = {}) {
    this.basePath = options.basePath ?? getDefaultBasePath();
  }

  async save(credential: Credential): Promise<void> {
    const providerDir = this.getProviderPath(credential.providerId);
    const targetPath = this.getCredentialPath(credential.providerId, credential.connectionId);
    const tempPath = path.join(
      providerDir,
      `.${credential.connectionId}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const fileContents = `${JSON.stringify(credential, null, 2)}\n`;

    await fs.mkdir(providerDir, { recursive: true });

    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(tempPath, "w", 0o600);
      await handle.writeFile(fileContents, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;

      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, targetPath);
      await fs.chmod(targetPath, 0o600);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async load(providerId: string, connectionId: string): Promise<Credential | null> {
    try {
      const fileContents = await fs.readFile(this.getCredentialPath(providerId, connectionId), "utf8");
      return JSON.parse(fileContents) as Credential;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async list(providerId?: string): Promise<Credential[]> {
    const providerIds = providerId ? [providerId] : await this.listProviderIds();
    const credentials: Credential[] = [];

    for (const currentProviderId of providerIds.sort((left, right) => left.localeCompare(right))) {
      const providerDir = this.getProviderPath(currentProviderId);
      let entries: DirectoryEntry[];

      try {
        entries = await fs.readdir(providerDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of sortedEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const connectionId = entry.name.slice(0, -".json".length);
        const credential = await this.load(currentProviderId, connectionId);
        if (credential) {
          credentials.push(credential);
        }
      }
    }

    return credentials;
  }

  async remove(providerId: string, connectionId: string): Promise<void> {
    try {
      await fs.unlink(this.getCredentialPath(providerId, connectionId));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  watch(callback: (credential: Credential) => void): () => void {
    const knownFiles = new Map<string, string>();
    let stopped = false;
    let polling = false;

    const syncKnownFiles = async (emitChanges: boolean): Promise<void> => {
      const currentFiles = await this.collectCredentialSignatures();

      for (const [filePath, signature] of Array.from(currentFiles.entries())) {
        const previousSignature = knownFiles.get(filePath);
        if (emitChanges && previousSignature !== signature) {
          const credential = await this.readCredentialFile(filePath);
          if (credential) {
            callback(credential);
          }
        }
      }

      for (const filePath of Array.from(knownFiles.keys())) {
        if (!currentFiles.has(filePath)) {
          knownFiles.delete(filePath);
        }
      }

      for (const [filePath, signature] of Array.from(currentFiles.entries())) {
        knownFiles.set(filePath, signature);
      }
    };

    const poll = async (): Promise<void> => {
      if (stopped || polling) {
        return;
      }

      polling = true;
      try {
        await syncKnownFiles(true);
      } finally {
        polling = false;
      }
    };

    void syncKnownFiles(false);

    const timer = setInterval(() => {
      void poll();
    }, DEFAULT_POLL_INTERVAL_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async collectCredentialSignatures(): Promise<Map<string, string>> {
    const signatures = new Map<string, string>();
    const providerIds = await this.listProviderIds();

    for (const providerId of providerIds) {
      const providerDir = this.getProviderPath(providerId);
      let entries: DirectoryEntry[];

      try {
        entries = await fs.readdir(providerDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const filePath = path.join(providerDir, entry.name);
        try {
          const stats = await fs.stat(filePath);
          signatures.set(filePath, `${stats.mtimeMs}:${stats.size}`);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      }
    }

    return signatures;
  }

  private async listProviderIds(): Promise<string[]> {
    let entries: DirectoryEntry[];

    try {
      entries = await fs.readdir(this.basePath, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async readCredentialFile(filePath: string): Promise<Credential | null> {
    try {
      const fileContents = await fs.readFile(filePath, "utf8");
      return JSON.parse(fileContents) as Credential;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private getProviderPath(providerId: string): string {
    return path.join(this.basePath, providerId);
  }

  private getCredentialPath(providerId: string, connectionId: string): string {
    return path.join(this.getProviderPath(providerId), `${connectionId}.json`);
  }
}
