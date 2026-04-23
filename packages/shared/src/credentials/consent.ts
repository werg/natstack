import type { ConsentGrant } from "./types.js";

const CREATE_CONSENT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS credential_consent (
    worker_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    granted_at INTEGER NOT NULL,
    role TEXT,
    PRIMARY KEY (worker_id, provider_id, connection_id)
  )
`;

interface ConsentGrantRow {
  worker_id: string;
  provider_id: string;
  connection_id: string;
  scopes: string;
  granted_at: number;
  role: string | null;
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
    workerId: row.worker_id,
    providerId: row.provider_id,
    connectionId: row.connection_id,
    scopes: parseScopes(row.scopes),
    grantedAt: row.granted_at,
    role: row.role ?? undefined,
  };
}

export class ConsentGrantStore {
  private readonly ready: Promise<void>;

  constructor(private readonly db: DatabaseHandle) {
    this.ready = Promise.resolve(this.db.exec(CREATE_CONSENT_TABLE_SQL)).then(() => undefined);
  }

  async grant(grant: Omit<ConsentGrant, "grantedAt">): Promise<void> {
    await this.ready;

    await this.db.run(
      `
        INSERT INTO credential_consent (
          worker_id,
          provider_id,
          connection_id,
          scopes,
          granted_at,
          role
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id, provider_id, connection_id) DO UPDATE SET
          scopes = excluded.scopes,
          granted_at = excluded.granted_at,
          role = excluded.role
      `,
      [
        grant.workerId,
        grant.providerId,
        grant.connectionId,
        JSON.stringify(normalizeScopes(grant.scopes)),
        Date.now(),
        grant.role ?? null,
      ],
    );
  }

  async revoke(workerId: string, providerId: string, connectionId?: string): Promise<void> {
    await this.ready;

    if (connectionId) {
      await this.db.run(
        `
          DELETE FROM credential_consent
          WHERE worker_id = ? AND provider_id = ? AND connection_id = ?
        `,
        [workerId, providerId, connectionId],
      );
      return;
    }

    await this.db.run(
      `
        DELETE FROM credential_consent
        WHERE worker_id = ? AND provider_id = ?
      `,
      [workerId, providerId],
    );
  }

  async list(workerId: string): Promise<ConsentGrant[]> {
    await this.ready;

    const rows = await this.db.all<ConsentGrantRow>(
      `
        SELECT worker_id, provider_id, connection_id, scopes, granted_at, role
        FROM credential_consent
        WHERE worker_id = ?
        ORDER BY provider_id, connection_id
      `,
      [workerId],
    );

    return rows.map(rowToGrant);
  }

  async has(workerId: string, providerId: string, scopes?: string[]): Promise<boolean> {
    await this.ready;

    const rows = await this.db.all<Pick<ConsentGrantRow, "scopes">>(
      `
        SELECT scopes
        FROM credential_consent
        WHERE worker_id = ? AND provider_id = ?
      `,
      [workerId, providerId],
    );

    if (rows.length === 0) {
      return false;
    }

    const requestedScopes = normalizeScopes(scopes ?? []);
    if (requestedScopes.length === 0) {
      return true;
    }

    return rows.some((row) => {
      const grantedScopes = new Set(parseScopes(row.scopes));
      return requestedScopes.every((scope) => grantedScopes.has(scope));
    });
  }
}
