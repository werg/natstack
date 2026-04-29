import type { Credential } from "./types.js";
import {
  assertValidStoreIdentifier,
  EncryptedJsonStore,
  getDefaultCredentialStorePath,
  __setSafeStorageForTests,
} from "./encryptedJsonStore.js";

export { __setSafeStorageForTests };

const DEFAULT_POLL_INTERVAL_MS = 250;
const URL_BOUND_PROVIDER_NAMESPACE = "url-bound";

export class CredentialStore extends EncryptedJsonStore<Credential> {
  constructor(options: { basePath?: string } = {}) {
    super({ basePath: options.basePath, defaultBasePath: getDefaultCredentialStorePath() });
  }

  async save(credential: Credential): Promise<void> {
    assertValidStoreIdentifier("providerId", credential.providerId);
    assertValidStoreIdentifier("connectionId", credential.connectionId);
    await this.saveRecord(credential.providerId, credential.connectionId, credential);
  }

  async saveUrlBound(credential: Credential & { id: string }): Promise<void> {
    assertValidStoreIdentifier("credentialId", credential.id);
    await this.saveRecord(URL_BOUND_PROVIDER_NAMESPACE, credential.id, {
      ...credential,
      providerId: URL_BOUND_PROVIDER_NAMESPACE,
      connectionId: credential.id,
    });
  }

  async loadUrlBound(id: string): Promise<Credential | null> {
    assertValidStoreIdentifier("credentialId", id);
    return this.loadRecord(URL_BOUND_PROVIDER_NAMESPACE, id);
  }

  async listUrlBound(): Promise<Credential[]> {
    return this.listRecords(URL_BOUND_PROVIDER_NAMESPACE);
  }

  async removeUrlBound(id: string): Promise<void> {
    assertValidStoreIdentifier("credentialId", id);
    await this.removeRecord(URL_BOUND_PROVIDER_NAMESPACE, id);
  }

  async load(providerId: string, connectionId: string): Promise<Credential | null> {
    assertValidStoreIdentifier("providerId", providerId);
    assertValidStoreIdentifier("connectionId", connectionId);
    return this.loadRecord(providerId, connectionId);
  }

  async list(providerId?: string): Promise<Credential[]> {
    if (providerId !== undefined) {
      assertValidStoreIdentifier("providerId", providerId);
    }
    return this.listRecords(providerId);
  }

  async remove(providerId: string, connectionId: string): Promise<void> {
    assertValidStoreIdentifier("providerId", providerId);
    assertValidStoreIdentifier("connectionId", connectionId);
    await this.removeRecord(providerId, connectionId);
  }

  watch(callback: (credential: Credential) => void): () => void {
    const knownFiles = new Map<string, string>();
    let stopped = false;
    let polling = false;

    const syncKnownFiles = async (emitChanges: boolean): Promise<void> => {
      const currentFiles = await this.collectRecordSignatures();

      for (const [filePath, signature] of Array.from(currentFiles.entries())) {
        const previousSignature = knownFiles.get(filePath);
        if (emitChanges && previousSignature !== signature) {
          const credential = await this.readRecordFile(filePath);
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
}
