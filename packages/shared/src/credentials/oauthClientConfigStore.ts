import * as path from "node:path";
import { getCentralDataPath } from "@natstack/env-paths";
import {
  assertValidStoreIdentifier,
  EncryptedJsonStore,
} from "./encryptedJsonStore.js";
import type {
  OAuthClientConfigFieldStatus,
  OAuthClientConfigFieldType,
  OAuthClientConfigStatus,
} from "./types.js";

export interface OAuthClientConfigRecord {
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  fields: Record<string, {
    value: string;
    type: OAuthClientConfigFieldType;
    updatedAt: number;
  }>;
  createdAt: number;
  updatedAt: number;
}

export class OAuthClientConfigStore extends EncryptedJsonStore<OAuthClientConfigRecord> {
  constructor(options: { basePath?: string } = {}) {
    super({ basePath: options.basePath, defaultBasePath: getDefaultOAuthClientConfigStorePath() });
  }

  async save(record: OAuthClientConfigRecord): Promise<void> {
    assertValidStoreIdentifier("configId", record.configId);
    await this.saveRecord("oauth-client-config", record.configId, record);
  }

  async load(configId: string): Promise<OAuthClientConfigRecord | null> {
    assertValidStoreIdentifier("configId", configId);
    return this.loadRecord("oauth-client-config", configId);
  }

  async remove(configId: string): Promise<void> {
    assertValidStoreIdentifier("configId", configId);
    await this.removeRecord("oauth-client-config", configId);
  }

  summarize(
    configId: string,
    record: OAuthClientConfigRecord | null,
    requestedFields?: readonly { name: string; type: OAuthClientConfigFieldType }[],
  ): OAuthClientConfigStatus {
    const fields: Record<string, OAuthClientConfigFieldStatus> = {};
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
      updatedAt: record?.updatedAt,
    };
  }
}

export function getDefaultOAuthClientConfigStorePath(): string {
  return path.join(getCentralDataPath(), "oauth-client-config");
}
