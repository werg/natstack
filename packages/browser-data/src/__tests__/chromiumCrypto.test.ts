import { describe, it, expect, vi, beforeEach } from "vitest";
import * as crypto from "node:crypto";
import { ChromiumCrypto } from "../crypto/chromiumCrypto.js";
import { deriveKey, decryptLinuxValue } from "../crypto/platforms/linux.js";
import { decryptDarwinValue, deriveKey as darwinDeriveKey } from "../crypto/platforms/darwin.js";
import { decryptWin32Value } from "../crypto/platforms/win32.js";
import { BrowserDataError } from "../errors.js";

// ---- Helper: encrypt with AES-128-CBC (Linux/macOS format) ----

function encryptAes128Cbc(plaintext: string, key: Buffer, prefix: string): Buffer {
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return Buffer.concat([Buffer.from(prefix, "ascii"), encrypted]);
}

// ---- Helper: encrypt with AES-256-GCM (Windows format) ----

function encryptAes256Gcm(plaintext: string, key: Buffer, prefix: string): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: prefix + nonce + ciphertext + tag
  return Buffer.concat([Buffer.from(prefix, "ascii"), nonce, encrypted, tag]);
}

// ---- PBKDF2 key derivation ----

describe("PBKDF2 key derivation", () => {
  it("derives correct key from 'peanuts'", () => {
    const key = deriveKey("peanuts");
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(16);

    // Verify it matches the expected PBKDF2 output
    const expected = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
    expect(key.equals(expected)).toBe(true);
  });

  it("derives correct key from a custom password", () => {
    const key = deriveKey("my-secret-keyring-password");
    expect(key.length).toBe(16);

    const expected = crypto.pbkdf2Sync("my-secret-keyring-password", "saltysalt", 1, 16, "sha1");
    expect(key.equals(expected)).toBe(true);
  });

  it("darwin deriveKey matches linux deriveKey", () => {
    const linuxKey = deriveKey("test-password");
    const macKey = darwinDeriveKey("test-password");
    expect(linuxKey.equals(macKey)).toBe(true);
  });
});

// ---- AES-128-CBC decryption (Linux format) ----

describe("AES-128-CBC decryption (Linux/macOS)", () => {
  const key = deriveKey("peanuts");

  it("decrypts v10 prefixed value", () => {
    const plaintext = "my-secret-cookie-value";
    const encrypted = encryptAes128Cbc(plaintext, key, "v10");

    const result = decryptLinuxValue(encrypted, key);
    expect(result).toBe(plaintext);
  });

  it("decrypts v11 prefixed value", () => {
    const plaintext = "another-secret";
    const encrypted = encryptAes128Cbc(plaintext, key, "v11");

    const result = decryptLinuxValue(encrypted, key);
    expect(result).toBe(plaintext);
  });

  it("handles empty plaintext", () => {
    const encrypted = encryptAes128Cbc("", key, "v10");
    const result = decryptLinuxValue(encrypted, key);
    expect(result).toBe("");
  });

  it("decrypts long values", () => {
    const plaintext = "a".repeat(1000);
    const encrypted = encryptAes128Cbc(plaintext, key, "v10");
    const result = decryptLinuxValue(encrypted, key);
    expect(result).toBe(plaintext);
  });

  it("decrypts unicode values", () => {
    const plaintext = "p\u00e4ssw\u00f6rd-\u2603-\u{1f600}";
    const encrypted = encryptAes128Cbc(plaintext, key, "v10");
    const result = decryptLinuxValue(encrypted, key);
    expect(result).toBe(plaintext);
  });

  it("darwin decryption is identical to linux for same format", () => {
    const plaintext = "cross-platform-test";
    const encrypted = encryptAes128Cbc(plaintext, key, "v10");

    const linuxResult = decryptLinuxValue(encrypted, key);
    const darwinResult = decryptDarwinValue(encrypted, key);
    expect(linuxResult).toBe(darwinResult);
    expect(linuxResult).toBe(plaintext);
  });

  it("fails with wrong key", () => {
    const plaintext = "test-value";
    const encrypted = encryptAes128Cbc(plaintext, key, "v10");
    const wrongKey = deriveKey("wrong-password");

    expect(() => decryptLinuxValue(encrypted, wrongKey)).toThrow();
  });
});

// ---- AES-256-GCM decryption (Windows format) ----

describe("AES-256-GCM decryption (Windows)", () => {
  // Generate a 32-byte key for AES-256-GCM
  const key = crypto.randomBytes(32);

  it("decrypts v10 prefixed value", () => {
    const plaintext = "windows-secret-cookie";
    const encrypted = encryptAes256Gcm(plaintext, key, "v10");

    const result = decryptWin32Value(encrypted, key);
    expect(result).toBe(plaintext);
  });

  it("handles empty plaintext", () => {
    const encrypted = encryptAes256Gcm("", key, "v10");
    const result = decryptWin32Value(encrypted, key);
    expect(result).toBe("");
  });

  it("decrypts long values", () => {
    const plaintext = "b".repeat(2000);
    const encrypted = encryptAes256Gcm(plaintext, key, "v10");
    const result = decryptWin32Value(encrypted, key);
    expect(result).toBe(plaintext);
  });

  it("decrypts unicode values", () => {
    const plaintext = "\u00fc\u00f1\u00eec\u00f6d\u00e9-\u{1f511}";
    const encrypted = encryptAes256Gcm(plaintext, key, "v10");
    const result = decryptWin32Value(encrypted, key);
    expect(result).toBe(plaintext);
  });

  it("fails with wrong key", () => {
    const plaintext = "test-value";
    const encrypted = encryptAes256Gcm(plaintext, key, "v10");
    const wrongKey = crypto.randomBytes(32);

    expect(() => decryptWin32Value(encrypted, wrongKey)).toThrow();
  });

  it("fails with tampered ciphertext", () => {
    const plaintext = "integrity-check";
    const encrypted = encryptAes256Gcm(plaintext, key, "v10");

    // Tamper with a byte in the ciphertext area (after prefix + nonce)
    const tampered = Buffer.from(encrypted);
    tampered[20] = tampered[20]! ^ 0xff;

    expect(() => decryptWin32Value(tampered, key)).toThrow();
  });
});

// ---- Version detection ----

describe("ChromiumCrypto version detection", () => {
  let cryptoInstance: ChromiumCrypto;

  beforeEach(() => {
    cryptoInstance = new ChromiumCrypto("linux");
  });

  it("returns empty string for empty buffer", async () => {
    const result = await cryptoInstance.decrypt(Buffer.alloc(0), "chrome", "/tmp/state");
    expect(result).toBe("");
  });

  it("dispatches v10 prefix correctly on linux", async () => {
    const key = deriveKey("peanuts");
    const plaintext = "v10-test-value";
    const encrypted = encryptAes128Cbc(plaintext, key, "v10");

    const result = await cryptoInstance.decrypt(encrypted, "chrome", "/tmp/state");
    expect(result).toBe(plaintext);
  });

  it("dispatches v11 prefix on linux (falls back to peanuts when keyring unavailable)", async () => {
    const key = deriveKey("peanuts");
    const plaintext = "v11-test-value";
    const encrypted = encryptAes128Cbc(plaintext, key, "v11");

    // Will fail keyring lookup then fall back to "peanuts"
    const result = await cryptoInstance.decrypt(encrypted, "chrome", "/tmp/state");
    expect(result).toBe(plaintext);
  });

  it("rejects v20 prefix", async () => {
    const encrypted = Buffer.from("v20some-encrypted-data");

    await expect(
      cryptoInstance.decrypt(encrypted, "chrome", "/tmp/state"),
    ).rejects.toThrow(BrowserDataError);

    try {
      await cryptoInstance.decrypt(encrypted, "chrome", "/tmp/state");
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserDataError);
      expect((err as BrowserDataError).code).toBe("UNSUPPORTED_ENCRYPTION_VERSION");
    }
  });

  it("rejects v11 on non-linux platform", async () => {
    const darwinCrypto = new ChromiumCrypto("darwin");
    const encrypted = Buffer.from("v11some-data");

    await expect(
      darwinCrypto.decrypt(encrypted, "chrome", "/tmp/state"),
    ).rejects.toThrow(BrowserDataError);
  });
});

// ---- canDecrypt / getUnsupportedReason ----

describe("ChromiumCrypto platform support", () => {
  it("reports supported on linux", () => {
    const c = new ChromiumCrypto("linux");
    expect(c.canDecrypt()).toBe(true);
    expect(c.getUnsupportedReason()).toBeNull();
  });

  it("reports supported on darwin", () => {
    const c = new ChromiumCrypto("darwin");
    expect(c.canDecrypt()).toBe(true);
    expect(c.getUnsupportedReason()).toBeNull();
  });

  it("reports supported on win32", () => {
    const c = new ChromiumCrypto("win32");
    expect(c.canDecrypt()).toBe(true);
    expect(c.getUnsupportedReason()).toBeNull();
  });

  it("reports unsupported on freebsd", () => {
    const c = new ChromiumCrypto("freebsd" as NodeJS.Platform);
    expect(c.canDecrypt()).toBe(false);
    expect(c.getUnsupportedReason()).toContain("freebsd");
  });
});

// ---- Key caching ----

describe("ChromiumCrypto key caching", () => {
  it("caches keys across multiple decrypt calls", async () => {
    const c = new ChromiumCrypto("linux");
    const key = deriveKey("peanuts");
    const plaintext1 = "first-value";
    const plaintext2 = "second-value";

    const enc1 = encryptAes128Cbc(plaintext1, key, "v10");
    const enc2 = encryptAes128Cbc(plaintext2, key, "v10");

    const result1 = await c.decrypt(enc1, "chrome", "/tmp/state");
    const result2 = await c.decrypt(enc2, "chrome", "/tmp/state");

    expect(result1).toBe(plaintext1);
    expect(result2).toBe(plaintext2);
  });
});
