import * as fs from "node:fs";
import * as path from "node:path";
import type { PanelTokenRecord, PersistedPanelTokenRecord, TokenManager } from "@natstack/shared/tokenManager";

const PANEL_TOKEN_REGISTRY_FILE = "panel-tokens.json";

interface PanelTokenRegistry {
  version: 1;
  panels: PersistedPanelTokenRecord[];
}

export interface PanelTokenRecoveryResult {
  recovered: number;
  skipped: number;
  errors: number;
}

function registryPath(statePath: string): string {
  return path.join(statePath, "auth", PANEL_TOKEN_REGISTRY_FILE);
}

function readRegistry(filePath: string): PanelTokenRegistry {
  if (!fs.existsSync(filePath)) return { version: 1, panels: [] };
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PanelTokenRegistry>;
  return {
    version: 1,
    panels: Array.isArray(parsed.panels) ? parsed.panels.map(persistableRecord) : [],
  };
}

function writeRegistry(filePath: string, registry: PanelTokenRegistry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function persistableRecord(record: Partial<PanelTokenRecord>): PersistedPanelTokenRecord {
  const { ownerConnectionId: _ownerConnectionId, ...persisted } = record;
  return persisted as PersistedPanelTokenRecord;
}

export function recoverPersistedPanelTokens(
  tokenManager: TokenManager,
  statePath: string,
): PanelTokenRecoveryResult {
  const result: PanelTokenRecoveryResult = { recovered: 0, skipped: 0, errors: 0 };
  const filePath = registryPath(statePath);
  let registry: PanelTokenRegistry;
  try {
    registry = readRegistry(filePath);
  } catch (error) {
    result.errors++;
    console.warn(
      `[Server] Panel token recovery: failed to read ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return result;
  }

  for (const record of registry.panels) {
    if (
      !record ||
      typeof record.panelId !== "string" ||
      typeof record.token !== "string" ||
      record.callerKind !== "panel"
    ) {
      result.skipped++;
      continue;
    }

    const registered = tokenManager.registerExistingToken(record.token, record.panelId, "panel");
    if (!registered && tokenManager.getPanelIdFromToken(record.token) !== record.panelId) {
      result.skipped++;
      continue;
    }
    tokenManager.setPanelParent(record.panelId, record.parentId ?? null);
    if (record.ownerCallerId) {
      tokenManager.setPanelOwner(record.panelId, record.ownerCallerId);
    }
    if (registered) result.recovered++;
    else result.skipped++;
  }

  return result;
}

export function installPanelTokenPersistence(
  tokenManager: TokenManager,
  statePath: string,
): void {
  const filePath = registryPath(statePath);
  const records = new Map<string, PersistedPanelTokenRecord>();

  try {
    for (const record of readRegistry(filePath).panels) {
      if (record?.panelId && record?.token && record.callerKind === "panel") {
        records.set(record.panelId, persistableRecord(record));
      }
    }
  } catch (error) {
    console.warn(
      `[Server] Panel token persistence: failed to read existing registry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  for (const record of tokenManager.listPanelTokenRecords()) {
    records.set(record.panelId, persistableRecord(record));
  }
  writeRegistry(filePath, { version: 1, panels: [...records.values()] });

  tokenManager.onPanelTokenRecordChanged((record, panelId) => {
    if (record) records.set(panelId, persistableRecord(record));
    else records.delete(panelId);
    try {
      writeRegistry(filePath, { version: 1, panels: [...records.values()] });
    } catch (error) {
      console.warn(
        `[Server] Panel token persistence: failed to write registry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}
