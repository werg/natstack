import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ProductSeedUnitKind = "extension" | "app";

export interface ProductSeedSourceRecord {
  kind: "product-seed-source";
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
  signatureKeyId: string;
  signature: string;
  createdBy: "natstack";
}

export interface ProductSeedIdentity {
  unitKind: ProductSeedUnitKind;
  name: string;
  source: { kind: "internal-git"; repo: string; ref: string };
  effectiveVersion: string | null;
}

export interface ProductSeedVerification {
  record: ProductSeedSourceRecord;
  sourceDigest: string;
}

const SEED_RECORD_FILE = ".natstack-seed.json";
const DEV_SIGNATURE_KEY_ID = "natstack-dev-seed-v1";
const DEV_SIGNATURE_PREFIX = "natstack-dev-seed-sha256:";
const PRODUCT_SIGNATURE_PREFIX = "natstack-product-seed-ed25519:";
const DIGEST_VERSION = "natstack-product-seed-source-v1";
const SIGNATURE_VERSION = "natstack-product-seed-signature-v1";
const PRODUCT_PRIVATE_KEY_ENV = "NATSTACK_PRODUCT_SEED_PRIVATE_KEY_PEM";
const PRODUCT_PRIVATE_KEY_ID_ENV = "NATSTACK_PRODUCT_SEED_KEY_ID";
const PRODUCT_PUBLIC_KEYS_ENV = "NATSTACK_PRODUCT_SEED_PUBLIC_KEYS_JSON";

export function createProductSeedSourceRecord(opts: {
  unitDir: string;
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
}): ProductSeedSourceRecord {
  const sourceDigest = productSeedSourceDigest(opts.unitDir);
  const sourceRepo = normalizeSeedRepoPath(opts.sourceRepo);
  return {
    kind: "product-seed-source",
    unitKind: opts.unitKind,
    name: opts.name,
    sourceRepo,
    sourceDigest,
    ...signProductSeedSource({
      unitKind: opts.unitKind,
      name: opts.name,
      sourceRepo,
      sourceDigest,
    }),
    createdBy: "natstack",
  };
}

export function writeProductSeedSourceRecord(opts: {
  unitDir: string;
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
}): ProductSeedSourceRecord {
  const record = createProductSeedSourceRecord(opts);
  fs.writeFileSync(
    path.join(opts.unitDir, SEED_RECORD_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8",
  );
  return record;
}

export function verifyProductSeedSource(opts: {
  unitDir: string;
  identity: ProductSeedIdentity;
}): ProductSeedVerification | null {
  if (opts.identity.effectiveVersion === null) return null;
  const record = readProductSeedSourceRecord(path.join(opts.unitDir, SEED_RECORD_FILE));
  if (!record) return null;
  if (record.unitKind !== opts.identity.unitKind || record.name !== opts.identity.name) return null;
  if (record.sourceRepo !== normalizeSeedRepoPath(opts.identity.source.repo)) return null;
  const sourceDigest = productSeedSourceDigest(opts.unitDir);
  if (sourceDigest !== record.sourceDigest) return null;
  if (!verifyProductSeedSignature(record)) return null;
  return { record, sourceDigest };
}

export function productSeedSourceDigest(unitDir: string): string {
  const hash = createHash("sha256");
  hash.update(`${DIGEST_VERSION}\0`);
  for (const file of listSeedSourceFiles(unitDir)) {
    const relative = toPosixPath(path.relative(unitDir, file));
    const content = fs.readFileSync(file);
    hash.update(relative);
    hash.update("\0");
    hash.update(String(content.byteLength));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readProductSeedSourceRecord(filePath: string): ProductSeedSourceRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    if (!isProductSeedSourceRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isProductSeedSourceRecord(value: unknown): value is ProductSeedSourceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ProductSeedSourceRecord>;
  return (
    record.kind === "product-seed-source"
    && (record.unitKind === "extension" || record.unitKind === "app")
    && typeof record.name === "string"
    && typeof record.sourceRepo === "string"
    && typeof record.sourceDigest === "string"
    && typeof record.signatureKeyId === "string"
    && typeof record.signature === "string"
    && record.createdBy === "natstack"
  );
}

function signProductSeedSource(opts: {
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
}): { signatureKeyId: string; signature: string } {
  const productPrivateKey = process.env[PRODUCT_PRIVATE_KEY_ENV];
  const productKeyId = process.env[PRODUCT_PRIVATE_KEY_ID_ENV];
  if (productPrivateKey && productKeyId) {
    const payload = productSeedSignaturePayload(opts);
    const privateKey = createPrivateKey(productPrivateKey);
    return {
      signatureKeyId: productKeyId,
      signature: `${PRODUCT_SIGNATURE_PREFIX}${sign(null, payload, privateKey).toString("base64url")}`,
    };
  }
  if (isProductionSeedTrustMode()) {
    throw new Error(
      `${PRODUCT_PRIVATE_KEY_ENV} and ${PRODUCT_PRIVATE_KEY_ID_ENV} are required to create product seed records in production`,
    );
  }
  return {
    signatureKeyId: DEV_SIGNATURE_KEY_ID,
    signature: signDevProductSeedSource(opts),
  };
}

function verifyProductSeedSignature(record: ProductSeedSourceRecord): boolean {
  const payload = productSeedSignaturePayload({
    unitKind: record.unitKind,
    name: record.name,
    sourceRepo: record.sourceRepo,
    sourceDigest: record.sourceDigest,
  });
  if (record.signatureKeyId === DEV_SIGNATURE_KEY_ID) {
    if (isProductionSeedTrustMode()) return false;
    return record.signature === signDevProductSeedSource({
      unitKind: record.unitKind,
      name: record.name,
      sourceRepo: record.sourceRepo,
      sourceDigest: record.sourceDigest,
    });
  }
  if (!record.signature.startsWith(PRODUCT_SIGNATURE_PREFIX)) return false;
  const publicKey = trustedProductSeedPublicKeys().get(record.signatureKeyId);
  if (!publicKey) return false;
  try {
    const signature = Buffer.from(record.signature.slice(PRODUCT_SIGNATURE_PREFIX.length), "base64url");
    return verify(null, payload, createPublicKey(publicKey), signature);
  } catch {
    return false;
  }
}

function signDevProductSeedSource(opts: {
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
}): string {
  const hash = createHash("sha256");
  hash.update(`${SIGNATURE_VERSION}\0${opts.unitKind}\0${opts.name}\0${opts.sourceRepo}\0${opts.sourceDigest}`);
  return `${DEV_SIGNATURE_PREFIX}${hash.digest("hex")}`;
}

function productSeedSignaturePayload(opts: {
  unitKind: ProductSeedUnitKind;
  name: string;
  sourceRepo: string;
  sourceDigest: string;
}): Buffer {
  return Buffer.from(
    `${SIGNATURE_VERSION}\0${opts.unitKind}\0${opts.name}\0${opts.sourceRepo}\0${opts.sourceDigest}`,
    "utf-8",
  );
}

function trustedProductSeedPublicKeys(): Map<string, string> {
  const raw = process.env[PRODUCT_PUBLIC_KEYS_ENV];
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed)
      .filter((entry): entry is [string, string] =>
        typeof entry[0] === "string"
        && entry[0].length > 0
        && typeof entry[1] === "string"
        && entry[1].length > 0
      );
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function isProductionSeedTrustMode(): boolean {
  return process.env["NATSTACK_PROD"] === "1" || process.env["NODE_ENV"] === "production";
}

function listSeedSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === ".git"
        || entry.name === "node_modules"
        || entry.name === ".cache"
        || entry.name === SEED_RECORD_FILE
      ) {
        continue;
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files.sort((a, b) => toPosixPath(a).localeCompare(toPosixPath(b)));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeSeedRepoPath(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, "")
    .replace(/^workspace\//, "")
    .replace(/\.git(\/.*)?$/, "")
    .replace(/\/+$/, "");
}
