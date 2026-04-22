import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createSecretsStore } from "./secretsStore.js";

function waitForValue<T>(promiseFactory: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    void promiseFactory().then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

describe("SecretsStore", () => {
  let tmpDir: string;
  let secretsPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "secrets-store-test-"));
    secretsPath = path.join(tmpDir, ".secrets.yml");
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["NANGO_SECRET_KEY"];
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("seeds from disk and lists keys", async () => {
    await fs.writeFile(secretsPath, YAML.stringify({ nango: "abc", anthropic: "sk-test" }), "utf-8");
    const store = createSecretsStore({ secretsPath });

    try {
      expect(store.get("nango")).toBe("abc");
      expect(store.list()).toEqual(["anthropic", "nango"]);
    } finally {
      await store.close();
    }
  });

  it("set writes the file, emits events, and projects env vars when it owns them", async () => {
    const store = createSecretsStore({ secretsPath });
    const events: Array<[string, string | undefined]> = [];
    store.watch("anthropic", (value) => {
      events.push(["anthropic", value]);
    });
    store.watchAll((key, value) => {
      events.push([key, value]);
    });

    try {
      await store.set("anthropic", "sk-live");

      const onDisk = YAML.parse(await fs.readFile(secretsPath, "utf-8")) as Record<string, string>;
      expect(onDisk["anthropic"]).toBe("sk-live");
      expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-live");
      expect(events).toEqual([
        ["anthropic", "sk-live"],
        ["anthropic", "sk-live"],
      ]);
    } finally {
      await store.close();
    }
  });

  it("preserves external-owned env vars on set and delete", async () => {
    process.env["ANTHROPIC_API_KEY"] = "env-owned";
    const store = createSecretsStore({ secretsPath });

    try {
      await store.set("anthropic", "secret-owned");
      expect(store.get("anthropic")).toBe("secret-owned");
      expect(process.env["ANTHROPIC_API_KEY"]).toBe("env-owned");

      await store.delete("anthropic");
      expect(store.get("anthropic")).toBeUndefined();
      expect(process.env["ANTHROPIC_API_KEY"]).toBe("env-owned");
    } finally {
      await store.close();
    }
  });

  it("clears owned env vars on delete", async () => {
    const store = createSecretsStore({ secretsPath });

    try {
      await store.set("anthropic", "sk-live");
      expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-live");

      await store.delete("anthropic");
      expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("stops delivering watch events after unsubscribe", async () => {
    const store = createSecretsStore({ secretsPath });
    const received: Array<string | undefined> = [];
    const unsubscribe = store.watch("nango", (value) => {
      received.push(value);
    });

    try {
      await store.set("nango", "first");
      unsubscribe();
      await store.set("nango", "second");
      expect(received).toEqual(["first"]);
    } finally {
      await store.close();
    }
  });

  it("reloads external file edits and updates env projection", async () => {
    await fs.writeFile(secretsPath, YAML.stringify({ nango: "initial" }), "utf-8");
    const store = createSecretsStore({ secretsPath });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const event = waitForValue(
        () => new Promise<string | undefined>((resolve) => {
          const unsubscribe = store.watch("nango", (value) => {
            unsubscribe();
            resolve(value);
          });
        }),
      );

      await fs.writeFile(secretsPath, YAML.stringify({ nango: "rotated" }), "utf-8");

      await expect(event).resolves.toBe("rotated");
      expect(store.get("nango")).toBe("rotated");
      expect(process.env["NANGO_SECRET_KEY"]).toBe("rotated");
    } finally {
      await store.close();
    }
  });

  it("treats provider keys case-insensitively for store reads and env projection", async () => {
    await fs.writeFile(secretsPath, YAML.stringify({ GitHub: "ghp-test" }), "utf-8");
    const store = createSecretsStore({ secretsPath });

    try {
      expect(store.get("github")).toBe("ghp-test");
      expect(store.list()).toEqual(["github"]);
      expect(process.env["GITHUB_TOKEN"]).toBe("ghp-test");
    } finally {
      await store.close();
    }
  });

  it("does not emit a duplicate change for its own writes", async () => {
    const store = createSecretsStore({ secretsPath });
    const events: Array<[string, string | undefined]> = [];
    store.watchAll((key, value) => {
      events.push([key, value]);
    });

    try {
      await store.set("nango", "abc");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(events).toEqual([["nango", "abc"]]);
    } finally {
      await store.close();
    }
  });

  it("serializes concurrent writes so updates are not lost", async () => {
    const store = createSecretsStore({ secretsPath });

    try {
      await Promise.all([
        store.set("openai", "sk-openai"),
        store.set("anthropic", "sk-anthropic"),
      ]);

      expect(store.get("openai")).toBe("sk-openai");
      expect(store.get("anthropic")).toBe("sk-anthropic");

      const onDisk = YAML.parse(await fs.readFile(secretsPath, "utf-8")) as Record<string, string>;
      expect(onDisk).toEqual({
        anthropic: "sk-anthropic",
        openai: "sk-openai",
      });
    } finally {
      await store.close();
    }
  });

  it("require throws an actionable error when a key is missing", async () => {
    const store = createSecretsStore({ secretsPath });

    try {
      expect(() => store.require("nango")).toThrow(secretsPath);
      expect(() => store.require("nango")).toThrow(/Missing required secret "nango"/);
    } finally {
      await store.close();
    }
  });
});
