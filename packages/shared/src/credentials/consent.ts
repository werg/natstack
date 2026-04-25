import type { ConsentGrant } from "./types.js";

const CREATE_CONSENT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS credential_consent (
    code_identity TEXT NOT NULL,
    code_identity_type TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_fingerprint TEXT NOT NULL DEFAULT '',
    provider_audience TEXT NOT NULL DEFAULT '[]',
    connection_id TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    granted_at INTEGER NOT NULL,
    granted_by TEXT NOT NULL,
    PRIMARY KEY (code_identity, code_identity_type, provider_id, provider_fingerprint)
  )
`;

interface ConsentGrantRow {
  code_identity: string;
  code_identity_type: "repo" | "hash";
  provider_id: string;
  provider_fingerprint?: string;
  provider_audience?: string;
  connection_id: string;
  scopes: string;
  granted_at: number;
  granted_by: string;
}

export interface DatabaseHandle {
  run(sql: string, params?: readonly unknown[]): Promise<unknown> | unknown;
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]> | T[];
  exec(sql: string): Promise<void> | void;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return Array.from(new Set(scopes)).sort((left, right) => left.localeCompare(right));
}

function parseScopes(rawScopes: string): string[] {
  const parsed = JSON.parse(rawScopes) as unknown;
  if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) {
    throw new Error("Invalid consent scopes stored in credential_consent");
  }
  return normalizeScopes(parsed);
}

function rowToGrant(row: ConsentGrantRow): ConsentGrant {
  return {
    codeIdentity: row.code_identity,
    codeIdentityType: row.code_identity_type,
    providerId: row.provider_id,
    providerFingerprint: row.provider_fingerprint || undefined,
    providerAudience: parseAudience(row.provider_audience),
    connectionId: row.connection_id,
    scopes: parseScopes(row.scopes),
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
  };
}

export class ConsentGrantStore {
  private readonly ready: Promise<void>;
  private readonly transientGrants = new Map<string, ConsentGrant>();

  constructor(private readonly db: DatabaseHandle) {
    this.ready = Promise.resolve(this.db.exec(CREATE_CONSENT_TABLE_SQL)).then(() => undefined);
  }

  async grant(grant: ConsentGrant): Promise<void> {
    await this.ready;

    const normalizedGrant: ConsentGrant = {
      ...grant,
      scopes: normalizeScopes(grant.scopes),
      grantedAt: grant.grantedAt || Date.now(),
    };
    if (!normalizedGrant.providerFingerprint) {
      throw new Error("Consent grants must include a provider fingerprint");
    }

    if (normalizedGrant.transient) {
      this.transientGrants.set(this.getGrantKey(normalizedGrant), normalizedGrant);
      return;
    }

    await this.db.run(
      `
        INSERT INTO credential_consent (
          code_identity,
          code_identity_type,
          provider_id,
          provider_fingerprint,
          provider_audience,
          connection_id,
          scopes,
          granted_at,
          granted_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code_identity, code_identity_type, provider_id, provider_fingerprint) DO UPDATE SET
          provider_fingerprint = excluded.provider_fingerprint,
          provider_audience = excluded.provider_audience,
          connection_id = excluded.connection_id,
          scopes = excluded.scopes,
          granted_at = excluded.granted_at,
          granted_by = excluded.granted_by
      `,
      [
        normalizedGrant.codeIdentity,
        normalizedGrant.codeIdentityType,
        normalizedGrant.providerId,
        normalizedGrant.providerFingerprint,
        JSON.stringify(normalizedGrant.providerAudience ?? []),
        normalizedGrant.connectionId,
        JSON.stringify(normalizedGrant.scopes),
        normalizedGrant.grantedAt,
        normalizedGrant.grantedBy,
      ],
    );
  }

  async revoke(codeIdentity: string, providerId: string): Promise<void> {
    await this.ready;

    await this.db.run(
      `
        DELETE FROM credential_consent
        WHERE code_identity = ? AND provider_id = ?
      `,
      [codeIdentity, providerId],
    );

    for (const [key, grant] of Array.from(this.transientGrants.entries())) {
      if (grant.codeIdentity === codeIdentity && grant.providerId === providerId) {
        this.transientGrants.delete(key);
      }
    }
  }

  async list(repoPath: string): Promise<ConsentGrant[]> {
    await this.ready;

    const rows = await this.db.all<ConsentGrantRow>(
      `
        SELECT code_identity, code_identity_type, provider_id, provider_fingerprint, provider_audience, connection_id, scopes, granted_at, granted_by
        FROM credential_consent
        WHERE code_identity = ? AND code_identity_type = 'repo'
        ORDER BY provider_id, connection_id
      `,
      [repoPath],
    );

    const transient = Array.from(this.transientGrants.values())
      .filter((grant) => grant.codeIdentity === repoPath);

    return [...rows.map(rowToGrant), ...transient].sort((left, right) => {
      const providerCompare = left.providerId.localeCompare(right.providerId);
      if (providerCompare !== 0) {
        return providerCompare;
      }
      return left.connectionId.localeCompare(right.connectionId);
    });
  }

  async check(query: {
    repoPath: string;
    effectiveVersion: string;
    providerId: string;
    providerFingerprint: string;
  }): Promise<ConsentGrant | null> {
    await this.ready;

    const repoRows = await this.db.all<ConsentGrantRow>(
      `
        SELECT code_identity, code_identity_type, provider_id, provider_fingerprint, provider_audience, connection_id, scopes, granted_at, granted_by
        FROM credential_consent
        WHERE code_identity = ? AND code_identity_type = 'repo' AND provider_id = ?
          AND provider_fingerprint = ?
        ORDER BY granted_at DESC
      `,
      [query.repoPath, query.providerId, query.providerFingerprint],
    );
    if (repoRows[0]) {
      return rowToGrant(repoRows[0]);
    }

    if (query.effectiveVersion) {
      const hashRows = await this.db.all<ConsentGrantRow>(
        `
          SELECT code_identity, code_identity_type, provider_id, provider_fingerprint, provider_audience, connection_id, scopes, granted_at, granted_by
          FROM credential_consent
          WHERE code_identity = ? AND code_identity_type = 'hash' AND provider_id = ?
            AND provider_fingerprint = ?
          ORDER BY granted_at DESC
        `,
        [query.effectiveVersion, query.providerId, query.providerFingerprint],
      );
      if (hashRows[0]) {
        return rowToGrant(hashRows[0]);
      }
    }

    for (const grant of this.transientGrants.values()) {
      if (grant.providerId !== query.providerId) {
        continue;
      }
      if (grant.providerFingerprint !== query.providerFingerprint) {
        continue;
      }
      if (
        (grant.codeIdentityType === "repo" && grant.codeIdentity === query.repoPath) ||
        (grant.codeIdentityType === "hash" && grant.codeIdentity === query.effectiveVersion)
      ) {
        return grant;
      }
    }

    return null;
  }

  private getGrantKey(grant: Pick<ConsentGrant, "codeIdentity" | "codeIdentityType" | "providerId" | "providerFingerprint">): string {
    return `${grant.codeIdentityType}:${grant.codeIdentity}:${grant.providerId}:${grant.providerFingerprint}`;
  }
}

function parseAudience(rawAudience: string | undefined): string[] | undefined {
  if (!rawAudience) return undefined;
  const parsed = JSON.parse(rawAudience) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid consent audience stored in credential_consent");
  }
  return parsed.length > 0 ? parsed : undefined;
}
