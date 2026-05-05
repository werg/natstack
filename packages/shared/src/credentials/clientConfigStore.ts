import * as path from "node:path";
import { getCentralDataPath } from "@natstack/env-paths";
import {
  assertValidStoreIdentifier,
  EncryptedJsonStore,
} from "./encryptedJsonStore.js";
import type {
  CredentialFlowType,
  ClientConfigFieldStatus,
  ClientConfigFieldType,
  ClientConfigStatus,
} from "./types.js";

export interface ClientConfigRecord {
  configId: string;
  currentVersion?: string;
  owner?: {
    callerId: string;
    callerKind: "panel" | "worker" | "shell" | "server";
    repoPath: string;
    effectiveVersion: string;
  };
  authorizeUrl: string;
  tokenUrl: string;
  status?: "active" | "disabled" | "deleted";
  flowTypes?: CredentialFlowType[];
  allowRefreshWhenDisabled?: boolean;
  fields: Record<string, {
    value: string;
    type: ClientConfigFieldType;
    updatedAt: number;
  }>;
  versions?: Record<string, ClientConfigVersionRecord>;
  createdAt: number;
  updatedAt: number;
}

export interface ClientConfigVersionRecord {
  version: string;
  authorizeUrl: string;
  tokenUrl: string;
  status?: "active" | "disabled" | "deleted";
  flowTypes?: CredentialFlowType[];
  allowRefreshWhenDisabled?: boolean;
  fields: ClientConfigRecord["fields"];
  createdAt: number;
}

export class ClientConfigStore extends EncryptedJsonStore<ClientConfigRecord> {
  constructor(options: { basePath?: string } = {}) {
    super({ basePath: options.basePath, defaultBasePath: getDefaultClientConfigStorePath() });
  }

  async save(record: ClientConfigRecord): Promise<void> {
    assertValidStoreIdentifier("configId", record.configId);
    await this.saveRecord("client-config", record.configId, record);
  }

  async load(configId: string): Promise<ClientConfigRecord | null> {
    assertValidStoreIdentifier("configId", configId);
    return this.loadRecord("client-config", configId);
  }

  async loadVersion(configId: string, version: string): Promise<ClientConfigVersionRecord | null> {
    assertValidStoreIdentifier("configId", configId);
    assertValidStoreIdentifier("version", version);
    const record = await this.load(configId);
    if (!record) return null;
    if (record.versions?.[version]) return record.versions[version];
    if (String(record.updatedAt) === version || record.currentVersion === version) {
      return {
        version,
        authorizeUrl: record.authorizeUrl,
        tokenUrl: record.tokenUrl,
        fields: record.fields,
        createdAt: record.updatedAt,
      };
    }
    return null;
  }

  async remove(configId: string): Promise<void> {
    assertValidStoreIdentifier("configId", configId);
    await this.removeRecord("client-config", configId);
  }

  summarize(
    configId: string,
    record: ClientConfigRecord | null,
    requestedFields?: readonly { name: string; type: ClientConfigFieldType }[],
  ): ClientConfigStatus {
    const fields: Record<string, ClientConfigFieldStatus> = {};
    const names = requestedFields?.length
      ? requestedFields
      : Object.entries(record?.fields ?? {}).map(([name, field]) => ({ name, type: field.type }));

    for (const field of names) {
      const stored = record?.fields[field.name];
      fields[field.name] = {
        configured: typeof stored?.value === "string" && stored.value.length > 0,
        type: field.type,
        updatedAt: stored?.updatedAt,
      };
    }

    return {
      configId,
      configured: Object.values(fields).every((field) => field.configured),
      authorizeUrl: record?.authorizeUrl,
      tokenUrl: record?.tokenUrl,
      fields,
      status: record?.status,
      flowTypes: record?.flowTypes,
      updatedAt: record?.updatedAt,
    };
  }
}

export function getDefaultClientConfigStorePath(): string {
  return path.join(getCentralDataPath(), "client-config");
}
