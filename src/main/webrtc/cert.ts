/**
 * Persistent DTLS certificate management for the WebRTC server peer
 * (workstream C; plan §6.1 + §11).
 *
 * The security model pins the server's DTLS SHA-256 fingerprint in the QR `fp`
 * and the client accepts iff the *observed* peer fingerprint equals it. For that
 * pin to keep verifying across server restarts the cert must be **persistent**:
 * we load `certificatePemFile`/`keyPemFile` if they already exist, otherwise we
 * mint a self-signed ECDSA P-256 cert ONCE and write both PEMs to disk. A fresh
 * `PeerConnection` loading the same PEMs presents the identical fingerprint
 * (proven stable in the §11 spike), so the QR survives restarts.
 *
 * Cert *minting* is done with Node's stdlib `crypto` only — no third-party
 * X.509 library, no `openssl` shell-out (so it works the same on every
 * platform, including a packaged Electron app with no system toolchain). Node
 * can generate an EC key pair and produce a DER ECDSA signature directly; the
 * surrounding X.509 `Certificate` structure is a compact DER encoding here. The
 * result is validated end-to-end in the unit test via `crypto.X509Certificate`
 * (`cert.verify(cert.publicKey) === true`), so a malformed encoding fails loud
 * in CI rather than at DTLS time.
 */

import {
  X509Certificate,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PersistentCert {
  certificatePemFile: string;
  keyPemFile: string;
  /** DTLS SHA-256 fingerprint as uppercase colon-separated hex (the QR `fp`). */
  fingerprint: string;
}

/**
 * SHA-256 fingerprint of a PEM-encoded certificate — uppercase colon-separated
 * hex, exactly the form DTLS advertises and the QR pins (e.g. `AA:64:F8:…:19`).
 * This is the canonical `X509Certificate.fingerprint256`, computed OFFLINE from
 * the cert with no live peer needed (§11).
 */
export function pemFingerprint(pem: string | Buffer): string {
  return new X509Certificate(pem).fingerprint256;
}

/** SHA-256 fingerprint of a PEM certificate on disk (throws if missing/malformed). */
export function certFileFingerprint(certificatePemFile: string): string {
  return pemFingerprint(fs.readFileSync(certificatePemFile));
}

/**
 * Load the persistent cert at the given paths, or mint-and-persist one if either
 * file is missing. Returns the paths plus the stable DTLS fingerprint to publish
 * in the QR. The private key is written `0600`.
 */
export function ensurePersistentCert(opts: {
  certificatePemFile: string;
  keyPemFile: string;
  /** Subject/issuer CN for a freshly minted cert. Irrelevant to DTLS pinning. */
  commonName?: string;
}): PersistentCert {
  const { certificatePemFile, keyPemFile } = opts;
  if (fs.existsSync(certificatePemFile) && fs.existsSync(keyPemFile)) {
    // Already provisioned — reuse so the fingerprint stays stable across restarts.
    return {
      certificatePemFile,
      keyPemFile,
      fingerprint: certFileFingerprint(certificatePemFile),
    };
  }

  const { certPem, keyPem } = generateSelfSignedEcCert(opts.commonName);
  fs.mkdirSync(path.dirname(keyPemFile), { recursive: true });
  fs.mkdirSync(path.dirname(certificatePemFile), { recursive: true });
  // Key first (0600), then cert — so a crash never leaves a cert without its key.
  writeFileAtomic(keyPemFile, keyPem, 0o600);
  writeFileAtomic(certificatePemFile, certPem, 0o644);
  return { certificatePemFile, keyPemFile, fingerprint: pemFingerprint(certPem) };
}

/**
 * Load the persistent signaling room id at `roomFile`, or mint-and-persist one if
 * absent. The QR/pairing link embeds this room and returning devices re-dial the
 * SAME room on reconnect, with the answerer waiting there for a new offer — so,
 * exactly like the DTLS cert, it MUST survive server restarts. A fresh
 * `randomUUID()` per start would strand every paired device in a stale, empty room
 * (the device dials the old room; the server answers in a new one), making
 * reconnection impossible after any restart. Returns the stable room id.
 */
export function ensurePersistentRoom(roomFile: string): string {
  if (fs.existsSync(roomFile)) {
    const existing = fs.readFileSync(roomFile, "utf8").trim();
    if (existing) return existing;
  }
  const room = randomUUID();
  fs.mkdirSync(path.dirname(roomFile), { recursive: true });
  writeFileAtomic(roomFile, `${room}\n`, 0o644);
  return room;
}

/**
 * Mint a self-signed ECDSA P-256 certificate. Returns PEM strings for the cert
 * (DER X.509 wrapped in `BEGIN CERTIFICATE`) and the PKCS#8 private key — both in
 * the shapes `node-datachannel`'s `certificatePemFile`/`keyPemFile` expect.
 */
export function generateSelfSignedEcCert(commonName = "natstack-webrtc"): {
  certPem: string;
  keyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1", // a.k.a. secp256r1 / NIST P-256
  });
  // A complete SubjectPublicKeyInfo SEQUENCE — embed verbatim into the cert.
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  // AlgorithmIdentifier for ecdsa-with-SHA256 (1.2.840.10045.4.3.2). For ECDSA
  // the AlgorithmIdentifier carries no parameters (RFC 5758), so it is just the OID.
  const sigAlg = derSeq(derOid("1.2.840.10045.4.3.2"));

  // Name with a single RDN: CN=<commonName>. Reused for issuer and subject.
  const name = derSeq(
    derSet(derSeq(derOid("2.5.4.3"), derUtf8(commonName))) // 2.5.4.3 = commonName
  );

  // Validity: backdate one day for clock skew; cap at the UTCTime-safe upper
  // bound (RFC 5280 mandates GeneralizedTime for 2050+, which we avoid).
  const validity = derSeq(
    derUtcTime(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    derUtcTime(new Date(Date.UTC(2049, 11, 31, 23, 59, 59)))
  );

  const tbsCertificate = derSeq(
    derExplicit(0, derInt(2)), // version [0] EXPLICIT INTEGER 2 → v3
    derInt(randomBytes(16)), // serialNumber (positive; high bit fixed up by derInt)
    sigAlg, // signature AlgorithmIdentifier
    name, // issuer
    validity,
    name, // subject (self-signed → issuer == subject)
    spkiDer // subjectPublicKeyInfo
  );

  // Node's crypto.sign returns a DER-encoded ECDSA-Sig-Value (SEQUENCE { r, s })
  // by default for EC keys — exactly what the X.509 signatureValue BIT STRING wraps.
  const signature = cryptoSign("sha256", tbsCertificate, privateKey);
  const certDer = derSeq(tbsCertificate, sigAlg, derBitString(signature));

  return { certPem: pemEncode("CERTIFICATE", certDer), keyPem };
}

// --- atomic write -----------------------------------------------------------

function writeFileAtomic(file: string, data: string, mode: number): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

// --- minimal DER encoders (just enough for a self-signed P-256 cert) ---------

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTLV(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTLV(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derTLV(0x31, Buffer.concat(items));
}

/** INTEGER from a small non-negative number or a big-endian byte buffer. */
function derInt(value: number | Buffer): Buffer {
  let bytes = typeof value === "number" ? Buffer.from([value]) : Buffer.from(value);
  // Strip redundant leading 0x00 bytes (keeping sign correctness).
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0x00 && ((bytes[i + 1] ?? 0) & 0x80) === 0) i++;
  bytes = bytes.subarray(i);
  // Prepend 0x00 if the high bit is set, so the value stays positive.
  if (bytes.length > 0 && ((bytes[0] ?? 0) & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return derTLV(0x02, bytes);
}

function derOid(oid: string): Buffer {
  const parts = oid.split(".").map((p) => Number.parseInt(p, 10));
  const out: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i] ?? 0;
    const stack: number[] = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return derTLV(0x06, Buffer.from(out));
}

function derUtf8(s: string): Buffer {
  return derTLV(0x0c, Buffer.from(s, "utf8"));
}

function derBitString(content: Buffer): Buffer {
  // Leading 0x00 = "zero unused bits in the final octet".
  return derTLV(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}

function derUtcTime(d: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const s =
    pad(d.getUTCFullYear() % 100) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z";
  return derTLV(0x17, Buffer.from(s, "ascii"));
}

/** Context-tag [tagNo] EXPLICIT wrapper. */
function derExplicit(tagNo: number, content: Buffer): Buffer {
  return derTLV(0xa0 | tagNo, content);
}

function pemEncode(label: string, der: Buffer): string {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  const body = b64.endsWith("\n") ? b64 : `${b64}\n`;
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}
