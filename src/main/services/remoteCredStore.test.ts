import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRemoteCredStore, type StoreCipher, type StoredRemote } from "./remoteCredStore.js";

const identityCipher: StoreCipher = {
  isAvailable: () => false,
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

// A cipher that XORs (stands in for safeStorage: ciphertext != plaintext on disk).
const xorCipher: StoreCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
  decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
};

function makeStore(cipher: StoreCipher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-remote-cred-"));
  const filePath = path.join(dir, "nested", "webrtc-remote.json");
  return {
    store: createRemoteCredStore({ filePath, cipher, fs, dirname: path.dirname }),
    filePath,
  };
}

const sample: StoredRemote = {
  pairing: {
    room: "room-1",
    fp: "AA:BB:CC",
    sig: "wss://sig",
    ice: "all",
  } as StoredRemote["pairing"],
  deviceId: "dev_abc",
  refreshToken: "rt-secret-value",
  label: "laptop",
  pairedAt: 1234,
};

describe("remoteCredStore", () => {
  it("round-trips a stored remote pairing (secure storage available)", () => {
    const { store } = makeStore(xorCipher);
    expect(store.load()).toBeNull();
    store.save(sample);
    expect(store.load()).toEqual(sample);
  });

  it("encrypts at rest when the cipher is available (no plaintext secret on disk)", () => {
    const { store, filePath } = makeStore(xorCipher);
    store.save(sample);
    const onDisk = fs.readFileSync(filePath).toString("utf8");
    expect(onDisk).not.toContain("rt-secret-value");
    expect(store.load()).toEqual(sample);
  });

  it("FAILS LOUD: refuses to persist (never writes plaintext) when secure storage is unavailable", () => {
    // identityCipher models safeStorage being unavailable (isAvailable() === false).
    const { store, filePath } = makeStore(identityCipher);
    expect(() => store.save(sample)).toThrow(/secure storage|plaintext/i);
    expect(fs.existsSync(filePath)).toBe(false); // the secret was NOT written in the clear
    expect(store.load()).toBeNull(); // and an unavailable cipher reads nothing
  });

  it("clear() removes the persisted pairing", () => {
    const { store } = makeStore(xorCipher);
    store.save(sample);
    store.clear();
    expect(store.load()).toBeNull();
    store.clear(); // idempotent on a missing file
  });

  it("treats a corrupt / undecryptable file as unpaired (re-pair) rather than throwing", () => {
    const { store, filePath } = makeStore(xorCipher);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json{{{");
    expect(store.load()).toBeNull();
  });

  it("rejects a record missing the device credential or pairing material", () => {
    const { store } = makeStore(xorCipher);
    store.save({ ...sample, refreshToken: "" });
    expect(store.load()).toBeNull();
  });
});
