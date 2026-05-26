import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  verifyProductSeedSource,
  writeProductSeedSourceRecord,
} from "./productSeedTrust.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env["NATSTACK_PRODUCT_SEED_PRIVATE_KEY_PEM"];
  delete process.env["NATSTACK_PRODUCT_SEED_KEY_ID"];
  delete process.env["NATSTACK_PRODUCT_SEED_PUBLIC_KEYS_JSON"];
  delete process.env["NATSTACK_PROD"];
});

function tempUnit(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-product-seed-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@workspace-apps/shell" }));
  fs.writeFileSync(path.join(root, "index.tsx"), "export default null;\n");
  return root;
}

describe("product seed trust", () => {
  it("verifies the exact seeded source bytes", () => {
    const unitDir = tempUnit();
    writeProductSeedSourceRecord({
      unitDir,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    });

    expect(verifyProductSeedSource({
      unitDir,
      identity: {
        unitKind: "app",
        name: "@workspace-apps/shell",
        source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
        effectiveVersion: "ev-seeded",
      },
    })?.record.name).toBe("@workspace-apps/shell");
  });

  it("fails closed after a source edit or before EV is known", () => {
    const unitDir = tempUnit();
    writeProductSeedSourceRecord({
      unitDir,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    });

    expect(verifyProductSeedSource({
      unitDir,
      identity: {
        unitKind: "app",
        name: "@workspace-apps/shell",
        source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
        effectiveVersion: null,
      },
    })).toBeNull();

    fs.appendFileSync(path.join(unitDir, "index.tsx"), "export const changed = true;\n");

    expect(verifyProductSeedSource({
      unitDir,
      identity: {
        unitKind: "app",
        name: "@workspace-apps/shell",
        source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
        effectiveVersion: "ev-changed",
      },
    })).toBeNull();
  });

  it("fails closed when seeded bytes are copied to a different repo path", () => {
    const unitDir = tempUnit();
    writeProductSeedSourceRecord({
      unitDir,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    });

    expect(verifyProductSeedSource({
      unitDir,
      identity: {
        unitKind: "app",
        name: "@workspace-apps/shell",
        source: { kind: "internal-git", repo: "apps/copy", ref: "main" },
        effectiveVersion: "ev-seeded",
      },
    })).toBeNull();
  });

  it("verifies source-bound seed records for extension units", () => {
    const unitDir = tempUnit();
    writeProductSeedSourceRecord({
      unitDir,
      unitKind: "extension",
      name: "@workspace-extensions/react-native",
      sourceRepo: "extensions/react-native",
    });

    expect(verifyProductSeedSource({
      unitDir,
      identity: {
        unitKind: "extension",
        name: "@workspace-extensions/react-native",
        source: {
          kind: "internal-git",
          repo: "extensions/react-native",
          ref: "main",
        },
        effectiveVersion: "ev-provider",
      },
    })?.record.sourceRepo).toBe("extensions/react-native");
  });

  it("uses product Ed25519 signatures when signing keys are configured", () => {
    const unitDir = tempUnit();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env["NATSTACK_PRODUCT_SEED_PRIVATE_KEY_PEM"] = privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString();
    process.env["NATSTACK_PRODUCT_SEED_KEY_ID"] = "natstack-product-test-v1";
    process.env["NATSTACK_PRODUCT_SEED_PUBLIC_KEYS_JSON"] = JSON.stringify({
      "natstack-product-test-v1": publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    const record = writeProductSeedSourceRecord({
      unitDir,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    });

    expect(record.signatureKeyId).toBe("natstack-product-test-v1");
    expect(record.signature).toMatch(/^natstack-product-seed-ed25519:/);
    expect(verifyProductSeedSource({
      unitDir,
      identity: {
        unitKind: "app",
        name: "@workspace-apps/shell",
        source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
        effectiveVersion: "ev-seeded",
      },
    })?.record.signatureKeyId).toBe("natstack-product-test-v1");
  });

  it("rejects development seed signatures in production mode", () => {
    const unitDir = tempUnit();
    writeProductSeedSourceRecord({
      unitDir,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    });

    process.env["NATSTACK_PROD"] = "1";

    expect(verifyProductSeedSource({
      unitDir,
      identity: {
        unitKind: "app",
        name: "@workspace-apps/shell",
        source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
        effectiveVersion: "ev-seeded",
      },
    })).toBeNull();
  });

  it("requires product signing keys when creating seed records in production mode", () => {
    process.env["NATSTACK_PROD"] = "1";

    expect(() => writeProductSeedSourceRecord({
      unitDir: tempUnit(),
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    })).toThrow(/NATSTACK_PRODUCT_SEED_PRIVATE_KEY_PEM/);
  });
});
