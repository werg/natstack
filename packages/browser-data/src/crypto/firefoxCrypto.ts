/**
 * Firefox password decryption.
 *
 * Implements key extraction from key4.db and login decryption from logins.json
 * using pure Node.js crypto (no NSS dependency).
 *
 * Reference: github.com/lclevy/firepwd
 */
import crypto from "node:crypto";
import { parseAsn1, oidToString } from "./asn1.js";
import type { Asn1Node } from "./asn1.js";
import { BrowserDataError } from "../errors.js";

// Well-known OIDs
const OID_PBES2 = "1.2.840.113549.1.5.13";
const OID_PBKDF2 = "1.2.840.113549.1.5.12";
const OID_PBE_SHA1_3DES = "1.2.840.113549.1.12.5.1.3";
const OID_DES_EDE3_CBC = "1.2.840.113549.3.7";
const OID_AES_256_CBC = "2.16.840.1.101.3.4.1.42";
const OID_HMAC_SHA256 = "1.2.840.113549.2.9";

interface PbeParams {
  algorithm: "3des-cbc" | "aes-256-cbc";
  key: Buffer;
  iv: Buffer;
}

/**
 * Decrypt ciphertext using the given PBE parameters.
 * Removes PKCS#7 padding from the result.
 */
function pbeDecrypt(params: PbeParams, ciphertext: Buffer): Buffer {
  const algo = params.algorithm === "3des-cbc" ? "des-ede3-cbc" : "aes-256-cbc";
  const decipher = crypto.createDecipheriv(algo, params.key, params.iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Remove PKCS#7 padding
  const padLen = decrypted[decrypted.length - 1]!;
  if (padLen > 0 && padLen <= (params.algorithm === "3des-cbc" ? 8 : 16)) {
    // Verify padding bytes
    let validPad = true;
    for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
      if (decrypted[i]! !== padLen) { validPad = false; break; }
    }
    if (validPad) {
      return decrypted.subarray(0, decrypted.length - padLen);
    }
  }
  return decrypted;
}

/**
 * PKCS#12 PBE key derivation used by older Firefox (PBE-SHA1-3DES).
 *
 * This follows the Mozilla NSS derivation which differs from the standard
 * PKCS#12 RFC 7292. The NSS approach:
 *   HP  = SHA1(globalSalt + password)
 *   pes = entrySalt padded to 20 bytes with zeros
 *   chp = SHA1(HP + entrySalt)
 *   k1  = HMAC-SHA1(chp, pes + entrySalt)
 *   tk  = HMAC-SHA1(chp, pes)
 *   k2  = HMAC-SHA1(chp, tk + entrySalt)
 *   k   = k1 + k2 -> first 24 bytes = 3DES key, next 8 = IV
 */
function deriveKeyNss(
  globalSalt: Buffer,
  entrySalt: Buffer,
  password: string,
): PbeParams {
  const passwordBuf = Buffer.from(password, "utf-8");
  const hp = crypto.createHash("sha1").update(globalSalt).update(passwordBuf).digest();

  const pes = Buffer.alloc(20);
  entrySalt.copy(pes, 0, 0, Math.min(entrySalt.length, 20));

  const chp = crypto.createHash("sha1").update(hp).update(entrySalt).digest();

  const k1 = crypto.createHmac("sha1", chp).update(Buffer.concat([pes, entrySalt])).digest();
  const tk = crypto.createHmac("sha1", chp).update(pes).digest();
  const k2 = crypto.createHmac("sha1", chp).update(Buffer.concat([tk, entrySalt])).digest();

  const k = Buffer.concat([k1, k2]);
  return {
    algorithm: "3des-cbc",
    key: k.subarray(0, 24),
    iv: k.subarray(24, 32),
  };
}

/**
 * PBES2 key derivation (PBKDF2 + cipher).
 */
function derivePbes2(
  node: Asn1Node,
  password: string,
  globalSalt: Buffer,
): PbeParams {
  // node is the SEQUENCE under the PBES2 OID:
  // SEQUENCE { SEQUENCE(PBKDF2 params), SEQUENCE(cipher params) }
  const children = node.children;
  if (!children || children.length < 2) {
    throw new BrowserDataError("DECRYPTION_FAILED", "Invalid PBES2 structure");
  }

  const pbkdf2Seq = children[0]!;
  const cipherSeq = children[1]!;

  // Parse PBKDF2 params
  if (!pbkdf2Seq.children || pbkdf2Seq.children.length < 2) {
    throw new BrowserDataError("DECRYPTION_FAILED", "Invalid PBKDF2 sequence");
  }

  const pbkdf2Oid = oidToString(pbkdf2Seq.children[0]!.data);
  if (pbkdf2Oid !== OID_PBKDF2) {
    throw new BrowserDataError("DECRYPTION_FAILED", `Expected PBKDF2 OID, got ${pbkdf2Oid}`);
  }

  const pbkdf2Params = pbkdf2Seq.children[1]!;
  if (!pbkdf2Params.children || pbkdf2Params.children.length < 2) {
    throw new BrowserDataError("DECRYPTION_FAILED", "Invalid PBKDF2 params");
  }

  const entrySalt = pbkdf2Params.children[0]!.data; // OCTET STRING
  const iterations = readAsn1Integer(pbkdf2Params.children[1]!);
  let keyLength = 32; // default for AES-256
  let hmacAlgo = "sha256"; // default

  // Optional key length and HMAC algorithm
  let paramIdx = 2;
  if (paramIdx < pbkdf2Params.children.length && pbkdf2Params.children[paramIdx]!.tag === 0x02) {
    keyLength = readAsn1Integer(pbkdf2Params.children[paramIdx]!);
    paramIdx++;
  }
  if (paramIdx < pbkdf2Params.children.length && pbkdf2Params.children[paramIdx]!.tag === 0x30) {
    const hmacSeq = pbkdf2Params.children[paramIdx]!;
    if (hmacSeq.children && hmacSeq.children.length > 0) {
      const hmacOid = oidToString(hmacSeq.children[0]!.data);
      if (hmacOid === OID_HMAC_SHA256) {
        hmacAlgo = "sha256";
      }
      // Could add SHA-1, SHA-512, etc. if needed
    }
  }

  // Parse cipher params
  if (!cipherSeq.children || cipherSeq.children.length < 2) {
    throw new BrowserDataError("DECRYPTION_FAILED", "Invalid cipher sequence");
  }

  const cipherOid = oidToString(cipherSeq.children[0]!.data);
  const iv = cipherSeq.children[1]!.data; // OCTET STRING

  let algorithm: PbeParams["algorithm"];
  if (cipherOid === OID_AES_256_CBC) {
    algorithm = "aes-256-cbc";
    keyLength = 32;
  } else if (cipherOid === OID_DES_EDE3_CBC) {
    algorithm = "3des-cbc";
    keyLength = 24;
  } else {
    throw new BrowserDataError(
      "UNSUPPORTED_ENCRYPTION_VERSION",
      `Unsupported cipher OID: ${cipherOid}`,
    );
  }

  // Derive key using PBKDF2
  const passwordBuf = Buffer.from(password, "utf-8");
  const salt = Buffer.concat([globalSalt, entrySalt]);
  const key = crypto.pbkdf2Sync(passwordBuf, salt, iterations, keyLength, hmacAlgo);

  return { algorithm, key, iv: Buffer.from(iv) };
}

/** Read an ASN.1 INTEGER node as a JS number. */
function readAsn1Integer(node: Asn1Node): number {
  const data = node.data;
  let value = 0;
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i]!;
  }
  return value;
}

/**
 * Parse the password-check or nssPrivate ASN.1 blob and derive PBE params.
 *
 * The structure is:
 *   SEQUENCE {
 *     SEQUENCE { OID, SEQUENCE { ...params } }
 *     OCTET_STRING (encrypted_data)
 *   }
 */
function parsePbeBlob(
  asn1Data: Buffer,
  password: string,
  globalSalt: Buffer,
): { params: PbeParams; ciphertext: Buffer } {
  const root = parseAsn1(asn1Data);
  if (!root.children || root.children.length < 2) {
    throw new BrowserDataError("DECRYPTION_FAILED", "Invalid PBE blob structure");
  }

  const algoSeq = root.children[0]!;
  const encryptedData = root.children[1]!.data;

  if (!algoSeq.children || algoSeq.children.length < 2) {
    throw new BrowserDataError("DECRYPTION_FAILED", "Invalid algorithm sequence");
  }

  const oid = oidToString(algoSeq.children[0]!.data);

  if (oid === OID_PBES2) {
    const params = derivePbes2(algoSeq.children[1]!, password, globalSalt);
    return { params, ciphertext: Buffer.from(encryptedData) };
  } else if (oid === OID_PBE_SHA1_3DES) {
    // PBE-SHA1-3DES: params SEQUENCE has { OCTET_STRING(entrySalt), INTEGER(iterations) }
    const pbeParamsSeq = algoSeq.children[1]!;
    if (!pbeParamsSeq.children || pbeParamsSeq.children.length < 2) {
      throw new BrowserDataError("DECRYPTION_FAILED", "Invalid PBE-SHA1-3DES params");
    }
    const entrySalt = pbeParamsSeq.children[0]!.data;
    const params = deriveKeyNss(globalSalt, Buffer.from(entrySalt), password);
    return { params, ciphertext: Buffer.from(encryptedData) };
  } else {
    throw new BrowserDataError(
      "UNSUPPORTED_ENCRYPTION_VERSION",
      `Unsupported PBE OID: ${oid}`,
    );
  }
}

export class FirefoxCrypto {
  // Cache: key4DbPath -> decrypted key
  private keyCache = new Map<string, Buffer>();

  /**
   * Decrypt a single encrypted login field (username or password).
   *
   * @param encryptedBase64 - Base64-encoded encrypted blob from logins.json
   * @param key4DbPath - Path to key4.db file
   * @param masterPassword - Firefox master/primary password (empty string if none)
   */
  async decryptLogin(
    encryptedBase64: string,
    key4DbPath: string,
    masterPassword?: string,
  ): Promise<string> {
    const password = masterPassword ?? "";
    const cacheKey = `${key4DbPath}:${password}`;

    let decryptionKey = this.keyCache.get(cacheKey);
    if (!decryptionKey) {
      decryptionKey = await this.extractKey(key4DbPath, password);
      this.keyCache.set(cacheKey, decryptionKey);
    }

    return this.decryptField(encryptedBase64, decryptionKey);
  }

  /**
   * Extract the master decryption key from key4.db.
   *
   * Step 1: Verify master password via metaData table.
   * Step 2: Decrypt the actual key from nssPrivate table.
   */
  private async extractKey(key4DbPath: string, password: string): Promise<Buffer> {
    // Dynamically import better-sqlite3 to keep it lazy
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(key4DbPath, { readonly: true, fileMustExist: true });

    try {
      // Step 1: Get global salt and verify master password
      const metaRow = db
        .prepare("SELECT item1, item2 FROM metaData WHERE id = 'password'")
        .get() as { item1: Buffer; item2: Buffer } | undefined;

      if (!metaRow) {
        throw new BrowserDataError("DECRYPTION_FAILED", "No password entry in key4.db metaData");
      }

      const globalSalt = Buffer.from(metaRow.item1);
      const item2 = Buffer.from(metaRow.item2);

      // Parse and decrypt the password check value
      const { params: checkParams, ciphertext: checkCipher } = parsePbeBlob(
        item2,
        password,
        globalSalt,
      );
      const checkDecrypted = pbeDecrypt(checkParams, checkCipher);
      const checkStr = checkDecrypted.toString("utf-8");

      if (!checkStr.startsWith("password-check")) {
        throw new BrowserDataError(
          "WRONG_MASTER_PASSWORD",
          "Master password verification failed",
        );
      }

      // Step 2: Extract the actual decryption key from nssPrivate
      const nssRow = db
        .prepare("SELECT a11, a102 FROM nssPrivate")
        .get() as { a11: Buffer; a102: Buffer } | undefined;

      if (!nssRow) {
        throw new BrowserDataError("DECRYPTION_FAILED", "No entry in key4.db nssPrivate table");
      }

      const a11 = Buffer.from(nssRow.a11);

      const { params: keyParams, ciphertext: keyCipher } = parsePbeBlob(
        a11,
        password,
        globalSalt,
      );
      const rawKey = pbeDecrypt(keyParams, keyCipher);

      // The decrypted key is typically 24 bytes (3DES) padded out.
      // Take the first 24 bytes as the 3DES key.
      return rawKey.subarray(0, 24);
    } finally {
      db.close();
    }
  }

  /**
   * Decrypt a single login field using the extracted key.
   *
   * The base64-decoded blob is ASN.1:
   *   SEQUENCE {
   *     SEQUENCE { OID, SEQUENCE { OCTET_STRING(IV) } }
   *     OCTET_STRING(ciphertext)
   *   }
   */
  private decryptField(encryptedBase64: string, key: Buffer): string {
    const data = Buffer.from(encryptedBase64, "base64");
    const root = parseAsn1(data);

    if (!root.children || root.children.length < 2) {
      throw new BrowserDataError("DECRYPTION_FAILED", "Invalid encrypted login structure");
    }

    const algoSeq = root.children[0]!;
    const ciphertext = root.children[1]!.data;

    if (!algoSeq.children || algoSeq.children.length < 2) {
      throw new BrowserDataError("DECRYPTION_FAILED", "Invalid algorithm sequence in login");
    }

    const oid = oidToString(algoSeq.children[0]!.data);
    const paramSeq = algoSeq.children[1]!;

    if (!paramSeq.children || paramSeq.children.length < 1) {
      throw new BrowserDataError("DECRYPTION_FAILED", "Missing cipher params in login");
    }

    const iv = paramSeq.children[0]!.data;

    let algorithm: string;
    if (oid === OID_DES_EDE3_CBC) {
      algorithm = "des-ede3-cbc";
    } else if (oid === OID_AES_256_CBC) {
      algorithm = "aes-256-cbc";
    } else {
      throw new BrowserDataError(
        "UNSUPPORTED_ENCRYPTION_VERSION",
        `Unsupported login cipher OID: ${oid}`,
      );
    }

    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Remove PKCS#7 padding
    const blockSize = oid === OID_DES_EDE3_CBC ? 8 : 16;
    const padLen = decrypted[decrypted.length - 1]!;
    if (padLen > 0 && padLen <= blockSize) {
      let validPad = true;
      for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
        if (decrypted[i]! !== padLen) { validPad = false; break; }
      }
      if (validPad) {
        return decrypted.subarray(0, decrypted.length - padLen).toString("utf-8");
      }
    }

    return decrypted.toString("utf-8");
  }
}
