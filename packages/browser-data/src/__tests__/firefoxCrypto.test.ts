import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { FirefoxCrypto } from "../crypto/firefoxCrypto.js";
import { parseAsn1, oidToString } from "../crypto/asn1.js";

// ---- Helpers to build ASN.1 DER structures ----

function tlv(tag: number, content: Buffer): Buffer {
  if (content.length < 128) {
    return Buffer.concat([Buffer.from([tag, content.length]), content]);
  }
  if (content.length < 256) {
    return Buffer.concat([Buffer.from([tag, 0x81, content.length]), content]);
  }
  return Buffer.concat([
    Buffer.from([tag, 0x82, (content.length >> 8) & 0xff, content.length & 0xff]),
    content,
  ]);
}

const seq = (content: Buffer) => tlv(0x30, content);
const octetString = (content: Buffer) => tlv(0x04, content);
const integer = (value: number): Buffer => {
  if (value <= 0x7f) return Buffer.from([0x02, 0x01, value]);
  if (value <= 0x7fff) return Buffer.from([0x02, 0x02, (value >> 8) & 0xff, value & 0xff]);
  if (value <= 0x7fffff)
    return Buffer.from([0x02, 0x03, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
  return Buffer.from([
    0x02, 0x04,
    (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff,
  ]);
};

function oid(dottedStr: string): Buffer {
  const parts = dottedStr.split(".").map(Number);
  const bytes: number[] = [];
  bytes.push(40 * parts[0]! + parts[1]!);
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i]!;
    if (val < 128) {
      bytes.push(val);
    } else {
      const encoded: number[] = [];
      encoded.push(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        encoded.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      encoded.reverse();
      bytes.push(...encoded);
    }
  }
  const data = Buffer.from(bytes);
  return tlv(0x06, data);
}

// ---- Known OIDs ----
const OID_PBES2 = "1.2.840.113549.1.5.13";
const OID_PBKDF2 = "1.2.840.113549.1.5.12";
const OID_AES_256_CBC = "2.16.840.1.101.3.4.1.42";
const OID_HMAC_SHA256 = "1.2.840.113549.2.9";
const OID_DES_EDE3_CBC = "1.2.840.113549.3.7";

/**
 * Build a PBES2 (PBKDF2 + AES-256-CBC) encrypted blob.
 *
 * Returns the ASN.1 DER blob and the parameters used, so tests can verify round-trip.
 */
function buildPbes2Blob(
  plaintext: Buffer,
  password: string,
  globalSalt: Buffer,
  entrySalt: Buffer,
  iv: Buffer,
  iterations: number,
): Buffer {
  // Derive key using same logic as FirefoxCrypto
  const salt = Buffer.concat([globalSalt, entrySalt]);
  const key = crypto.pbkdf2Sync(Buffer.from(password, "utf-8"), salt, iterations, 32, "sha256");

  // Encrypt with AES-256-CBC + PKCS#7 padding
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // Build ASN.1 structure
  const pbkdf2Params = seq(Buffer.concat([
    octetString(entrySalt),
    integer(iterations),
    integer(32), // key length
    seq(oid(OID_HMAC_SHA256)),
  ]));

  const pbkdf2Seq = seq(Buffer.concat([oid(OID_PBKDF2), pbkdf2Params]));
  const cipherSeq = seq(Buffer.concat([oid(OID_AES_256_CBC), octetString(iv)]));
  const pbes2Params = seq(Buffer.concat([pbkdf2Seq, cipherSeq]));
  const algoSeq = seq(Buffer.concat([oid(OID_PBES2), pbes2Params]));

  return seq(Buffer.concat([algoSeq, octetString(encrypted)]));
}

/**
 * Build a 3DES login encrypted blob (as stored in logins.json after base64 encoding).
 */
function buildLoginBlob(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv("des-ede3-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const algoSeq = seq(Buffer.concat([
    oid(OID_DES_EDE3_CBC),
    seq(octetString(iv)),
  ]));

  return seq(Buffer.concat([algoSeq, octetString(encrypted)]));
}

describe("Firefox crypto component tests", () => {
  describe("3DES decryption with known key/IV", () => {
    it("decrypts a 3DES-CBC encrypted value", () => {
      const key = crypto.randomBytes(24);
      const iv = crypto.randomBytes(8);
      const plaintext = Buffer.from("test-password-123");

      const cipher = crypto.createCipheriv("des-ede3-cbc", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

      const decipher = crypto.createDecipheriv("des-ede3-cbc", key, iv);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

      expect(decrypted.toString()).toBe("test-password-123");
    });
  });

  describe("AES-256-CBC decryption with known key/IV", () => {
    it("decrypts an AES-256-CBC encrypted value", () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);
      const plaintext = Buffer.from("secret-value");

      const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

      expect(decrypted.toString()).toBe("secret-value");
    });
  });

  describe("PBKDF2 key derivation", () => {
    it("derives consistent keys", () => {
      const password = Buffer.from("master-password");
      const salt = crypto.randomBytes(32);
      const iterations = 10000;

      const key1 = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
      const key2 = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");

      expect(key1.equals(key2)).toBe(true);
    });

    it("produces different keys for different passwords", () => {
      const salt = crypto.randomBytes(32);
      const key1 = crypto.pbkdf2Sync("pass1", salt, 1000, 32, "sha256");
      const key2 = crypto.pbkdf2Sync("pass2", salt, 1000, 32, "sha256");

      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe("ASN.1 login blob parsing", () => {
    it("parses a constructed 3DES login blob", () => {
      const key = crypto.randomBytes(24);
      const iv = crypto.randomBytes(8);
      const plaintext = Buffer.from("my-password");

      const blob = buildLoginBlob(plaintext, key, iv);
      const root = parseAsn1(blob);

      expect(root.tag).toBe(0x30);
      expect(root.children).toHaveLength(2);

      // Algorithm sequence
      const algoSeq = root.children![0]!;
      const oidNode = algoSeq.children![0]!;
      expect(oidToString(oidNode.data)).toBe(OID_DES_EDE3_CBC);

      // IV
      const paramSeq = algoSeq.children![1]!;
      const ivNode = paramSeq.children![0]!;
      expect(ivNode.data.equals(iv)).toBe(true);

      // Encrypted data
      const encData = root.children![1]!.data;
      const decipher = crypto.createDecipheriv("des-ede3-cbc", key, iv);
      const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
      expect(decrypted.toString()).toBe("my-password");
    });
  });
});

describe("Firefox crypto integration test", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-test-ffcrypto-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("decrypts a login from a synthetic key4.db (PBES2 + AES-256-CBC)", async () => {
    const masterPassword = "";
    const globalSalt = crypto.randomBytes(20);
    const entrySalt1 = crypto.randomBytes(20);
    const iv1 = crypto.randomBytes(16);
    const iterations = 10000;

    // Step 1: Build the password-check encrypted blob
    // "password-check\x02\x02" is what Firefox stores (with PKCS7 padding to block boundary)
    const checkPlaintext = Buffer.from("password-check\x02\x02");
    const item2 = buildPbes2Blob(checkPlaintext, masterPassword, globalSalt, entrySalt1, iv1, iterations);

    // Step 2: Build the nssPrivate key blob
    // The actual 3DES key that will be used to decrypt logins
    const loginKey = crypto.randomBytes(24);
    const entrySalt2 = crypto.randomBytes(20);
    const iv2 = crypto.randomBytes(16);
    const a11 = buildPbes2Blob(loginKey, masterPassword, globalSalt, entrySalt2, iv2, iterations);

    // Step 3: Create key4.db
    const key4Path = path.join(tmpDir, "key4.db");
    const db = new Database(key4Path);
    db.exec(`
      CREATE TABLE metaData (id TEXT PRIMARY KEY, item1, item2);
      CREATE TABLE nssPrivate (a11, a102);
    `);
    db.prepare("INSERT INTO metaData (id, item1, item2) VALUES (?, ?, ?)").run(
      "password",
      globalSalt,
      item2,
    );
    db.prepare("INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)").run(
      a11,
      Buffer.alloc(0), // a102 not used in our implementation
    );
    db.close();

    // Step 4: Build an encrypted login (3DES-CBC)
    const loginIv = crypto.randomBytes(8);
    const loginPlaintext = Buffer.from("my-secret-password");
    const loginBlob = buildLoginBlob(loginPlaintext, loginKey, loginIv);
    const encryptedBase64 = loginBlob.toString("base64");

    // Step 5: Decrypt
    const ffCrypto = new FirefoxCrypto();
    const decrypted = await ffCrypto.decryptLogin(encryptedBase64, key4Path);

    expect(decrypted).toBe("my-secret-password");
  });

  it("decrypts with a non-empty master password", async () => {
    const masterPassword = "my-master-pass";
    const globalSalt = crypto.randomBytes(20);
    const iterations = 5000;

    const entrySalt1 = crypto.randomBytes(20);
    const iv1 = crypto.randomBytes(16);
    const checkPlaintext = Buffer.from("password-check\x02\x02");
    const item2 = buildPbes2Blob(checkPlaintext, masterPassword, globalSalt, entrySalt1, iv1, iterations);

    const loginKey = crypto.randomBytes(24);
    const entrySalt2 = crypto.randomBytes(20);
    const iv2 = crypto.randomBytes(16);
    const a11 = buildPbes2Blob(loginKey, masterPassword, globalSalt, entrySalt2, iv2, iterations);

    const key4Path = path.join(tmpDir, "key4.db");
    const db = new Database(key4Path);
    db.exec(`
      CREATE TABLE metaData (id TEXT PRIMARY KEY, item1, item2);
      CREATE TABLE nssPrivate (a11, a102);
    `);
    db.prepare("INSERT INTO metaData (id, item1, item2) VALUES (?, ?, ?)").run(
      "password",
      globalSalt,
      item2,
    );
    db.prepare("INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)").run(a11, Buffer.alloc(0));
    db.close();

    const loginIv = crypto.randomBytes(8);
    const loginBlob = buildLoginBlob(Buffer.from("secret123"), loginKey, loginIv);

    const ffCrypto = new FirefoxCrypto();
    const decrypted = await ffCrypto.decryptLogin(loginBlob.toString("base64"), key4Path, masterPassword);
    expect(decrypted).toBe("secret123");

    // Wrong master password should throw
    const ffCrypto2 = new FirefoxCrypto();
    await expect(
      ffCrypto2.decryptLogin(loginBlob.toString("base64"), key4Path, "wrong-password"),
    ).rejects.toThrow("Master password");
  });

  it("rejects wrong master password", async () => {
    const masterPassword = "correct-password";
    const globalSalt = crypto.randomBytes(20);
    const iterations = 1000;

    const entrySalt = crypto.randomBytes(20);
    const iv = crypto.randomBytes(16);
    const checkPlaintext = Buffer.from("password-check\x02\x02");
    const item2 = buildPbes2Blob(checkPlaintext, masterPassword, globalSalt, entrySalt, iv, iterations);

    const loginKey = crypto.randomBytes(24);
    const entrySalt2 = crypto.randomBytes(20);
    const iv2 = crypto.randomBytes(16);
    const a11 = buildPbes2Blob(loginKey, masterPassword, globalSalt, entrySalt2, iv2, iterations);

    const key4Path = path.join(tmpDir, "key4.db");
    const db = new Database(key4Path);
    db.exec(`
      CREATE TABLE metaData (id TEXT PRIMARY KEY, item1, item2);
      CREATE TABLE nssPrivate (a11, a102);
    `);
    db.prepare("INSERT INTO metaData (id, item1, item2) VALUES (?, ?, ?)").run(
      "password",
      globalSalt,
      item2,
    );
    db.prepare("INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)").run(a11, Buffer.alloc(0));
    db.close();

    const ffCrypto = new FirefoxCrypto();
    await expect(
      ffCrypto.decryptLogin("dGVzdA==", key4Path, "wrong-password"),
    ).rejects.toThrow("Master password");
  });

  it("caches the key for repeated calls", async () => {
    const masterPassword = "";
    const globalSalt = crypto.randomBytes(20);
    const iterations = 1000;

    const entrySalt1 = crypto.randomBytes(20);
    const iv1 = crypto.randomBytes(16);
    const item2 = buildPbes2Blob(
      Buffer.from("password-check\x02\x02"),
      masterPassword, globalSalt, entrySalt1, iv1, iterations,
    );

    const loginKey = crypto.randomBytes(24);
    const entrySalt2 = crypto.randomBytes(20);
    const iv2 = crypto.randomBytes(16);
    const a11 = buildPbes2Blob(loginKey, masterPassword, globalSalt, entrySalt2, iv2, iterations);

    const key4Path = path.join(tmpDir, "key4.db");
    const db = new Database(key4Path);
    db.exec(`
      CREATE TABLE metaData (id TEXT PRIMARY KEY, item1, item2);
      CREATE TABLE nssPrivate (a11, a102);
    `);
    db.prepare("INSERT INTO metaData (id, item1, item2) VALUES (?, ?, ?)").run(
      "password", globalSalt, item2,
    );
    db.prepare("INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)").run(a11, Buffer.alloc(0));
    db.close();

    const ffCrypto = new FirefoxCrypto();

    // Decrypt two different values - key should be cached after first call
    const loginIv1 = crypto.randomBytes(8);
    const blob1 = buildLoginBlob(Buffer.from("password1"), loginKey, loginIv1);

    const loginIv2 = crypto.randomBytes(8);
    const blob2 = buildLoginBlob(Buffer.from("user@example.com"), loginKey, loginIv2);

    const result1 = await ffCrypto.decryptLogin(blob1.toString("base64"), key4Path);
    const result2 = await ffCrypto.decryptLogin(blob2.toString("base64"), key4Path);

    expect(result1).toBe("password1");
    expect(result2).toBe("user@example.com");
  });
});
