import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { DEFAULT_PAIRING_CODE_TTL_MS, DeviceAuthStore } from "./deviceAuthStore.js";

function tempFile(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "natstack-device-auth-")),
    "auth",
    "devices.json"
  );
}

describe("DeviceAuthStore", () => {
  it("pairs a device, persists only refresh-token hashes, and refresh-validates after reload", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const code = store.createPairingCode();
    expect(store.hasPendingPairingCode(code)).toBe(true);
    const credential = store.completePairing({
      code,
      label: "Phone",
      platform: "mobile",
    });
    expect(store.hasPendingPairingCode(code)).toBe(false);

    expect(credential.deviceId).toMatch(/^dev_/);
    expect(credential.refreshToken).toBeTruthy();
    expect(store.completePairing.bind(store, { code })).toThrow(/invalid or expired/i);

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(raw.serverId).toMatch(/^srv_/);
    expect(raw.devices).toHaveLength(1);
    expect(raw.devices[0].refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(raw)).not.toContain(credential.refreshToken);

    const reloaded = new DeviceAuthStore(filePath, () => now);
    now = 2000;
    const device = reloaded.validateRefresh(credential.deviceId, credential.refreshToken);
    expect(device.label).toBe("Phone");
    expect(reloaded.listDevices()[0]!.lastUsedAt).toBe(2000);
  });

  it("rejects expired, invalid, and revoked credentials", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const expiredCode = store.createPairingCode(10);
    now = 1011;
    expect(() => store.completePairing({ code: expiredCode })).toThrow(/invalid or expired/i);

    const credential = store.issueDevice({ label: "Desktop", platform: "electron" });
    expect(() => store.validateRefresh(credential.deviceId, "wrong-refresh-token")).toThrow(
      /invalid/i
    );

    expect(store.revokeDevice(credential.deviceId)).toBe(true);
    expect(store.revokeDevice(credential.deviceId)).toBe(false);
    expect(() => store.validateRefresh(credential.deviceId, credential.refreshToken)).toThrow(
      /not paired/i
    );
  });

  it("defaults pairing codes to a one hour lifetime", () => {
    const filePath = tempFile();
    let now = 1000;
    const store = new DeviceAuthStore(filePath, () => now);

    const code = store.createPairingCode();
    now += DEFAULT_PAIRING_CODE_TTL_MS - 1;
    expect(store.hasPendingPairingCode(code)).toBe(true);

    now += 2;
    expect(store.hasPendingPairingCode(code)).toBe(false);
    expect(() => store.completePairing({ code })).toThrow(/invalid or expired/i);
  });
});
