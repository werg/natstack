import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { constantTimeStringEqual } from "@natstack/shared/tokenManager";
import { writeJsonFileAtomic } from "./atomicFile.js";

export interface DeviceRecord {
  deviceId: string;
  refreshTokenHash: string;
  label: string;
  platform?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

interface StoredDeviceAuthState {
  serverId: string;
  devices: DeviceRecord[];
}

interface PairingCodeRecord {
  codeHash: string;
  expiresAt: number;
  createdAt: number;
}

export const DEFAULT_PAIRING_CODE_TTL_MS = 60 * 60 * 1000;

export interface IssuedDeviceCredential {
  deviceId: string;
  refreshToken: string;
  label: string;
  platform?: string;
}

export class DeviceAuthStore {
  private state: StoredDeviceAuthState;
  private readonly pairingCodes = new Map<string, PairingCodeRecord>();

  constructor(
    private readonly filePath: string,
    private readonly now = () => Date.now()
  ) {
    this.state = this.load();
  }

  getServerId(): string {
    return this.state.serverId;
  }

  createPairingCode(ttlMs = DEFAULT_PAIRING_CODE_TTL_MS): string {
    const code = randomBase64Url(24);
    const codeHash = hashSecret(code);
    this.pairingCodes.set(codeHash, {
      codeHash,
      createdAt: this.now(),
      expiresAt: this.now() + ttlMs,
    });
    return code;
  }

  hasPendingPairingCode(code: string): boolean {
    const codeHash = hashSecret(code);
    const record = this.pairingCodes.get(codeHash);
    if (!record) return false;
    if (record.expiresAt < this.now()) {
      this.pairingCodes.delete(codeHash);
      return false;
    }
    return true;
  }

  completePairing(input: {
    code: string;
    label?: string;
    platform?: string;
  }): IssuedDeviceCredential {
    const codeHash = hashSecret(input.code);
    const record = this.pairingCodes.get(codeHash);
    if (!record || record.expiresAt < this.now()) {
      this.pairingCodes.delete(codeHash);
      throw new Error("Pairing code is invalid or expired");
    }
    this.pairingCodes.delete(codeHash);
    return this.issueDevice({
      label: input.label ?? "NatStack client",
      platform: input.platform,
    });
  }

  issueDevice(input: { label: string; platform?: string }): IssuedDeviceCredential {
    const deviceId = `dev_${randomBase64Url(18)}`;
    const refreshToken = randomBase64Url(32);
    const record: DeviceRecord = {
      deviceId,
      refreshTokenHash: hashSecret(refreshToken),
      label: input.label,
      platform: input.platform,
      createdAt: this.now(),
    };
    this.state.devices.push(record);
    this.save();
    return { deviceId, refreshToken, label: record.label, platform: record.platform };
  }

  validateRefresh(deviceId: string, refreshToken: string): DeviceRecord {
    const record = this.state.devices.find((device) => device.deviceId === deviceId);
    if (!record || record.revokedAt) {
      throw new Error("Device is not paired");
    }
    const presentedHash = hashSecret(refreshToken);
    if (!constantTimeStringEqual(presentedHash, record.refreshTokenHash)) {
      throw new Error("Invalid refresh credential");
    }
    record.lastUsedAt = this.now();
    this.save();
    return record;
  }

  revokeDevice(deviceId: string): boolean {
    const record = this.state.devices.find((device) => device.deviceId === deviceId);
    if (!record || record.revokedAt) return false;
    record.revokedAt = this.now();
    this.save();
    return true;
  }

  listDevices(): DeviceRecord[] {
    return this.state.devices.map((device) => ({ ...device }));
  }

  private load(): StoredDeviceAuthState {
    if (!fs.existsSync(this.filePath)) {
      return { serverId: `srv_${randomBase64Url(18)}`, devices: [] };
    }
    const raw = JSON.parse(
      fs.readFileSync(this.filePath, "utf8")
    ) as Partial<StoredDeviceAuthState>;
    return {
      serverId:
        typeof raw.serverId === "string" && raw.serverId
          ? raw.serverId
          : `srv_${randomBase64Url(18)}`,
      devices: Array.isArray(raw.devices) ? raw.devices.filter(isDeviceRecord) : [],
    };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(this.filePath, this.state);
  }
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DeviceRecord>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.refreshTokenHash === "string" &&
    typeof record.label === "string" &&
    typeof record.createdAt === "number"
  );
}
