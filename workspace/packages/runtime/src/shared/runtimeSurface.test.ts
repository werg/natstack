import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { helpfulNamespace } from "./helpfulNamespace.js";
import { panelRuntimeSurface } from "./runtimeSurface.panel.js";
import { workerRuntimeSurface } from "./runtimeSurface.worker.js";

function extractNamedExports(source: string): Set<string> {
  const exported = new Set<string>();

  for (const match of source.matchAll(/export \* as ([A-Za-z0-9_]+) from /g)) {
    exported.add(match[1]!);
  }

  for (const match of source.matchAll(/export const \{([\s\S]*?)\}\s*=\s*runtime;/g)) {
    for (const part of match[1]!.split(",")) {
      const item = part.trim();
      if (!item) continue;
      const alias = item.match(/([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)/);
      exported.add(alias ? alias[2]! : item);
    }
  }

  for (const match of source.matchAll(/export const ([A-Za-z0-9_]+)\s*=/g)) {
    exported.add(match[1]!);
  }

  for (const match of source.matchAll(/export \{([^}]*)\}(?: from [^;]+)?;/g)) {
    for (const part of match[1]!.split(",")) {
      const item = part.trim();
      if (!item) continue;
      const alias = item.match(/([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)/);
      exported.add(alias ? alias[2]! : item);
    }
  }

  return exported;
}

function extractInterfaceMembers(source: string, interfaceName: string): Set<string> {
  const blockMatch = source.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`, "m"));
  if (!blockMatch) throw new Error(`Could not find interface ${interfaceName}`);

  const members = new Set<string>();
  for (const line of blockMatch[1]!.split("\n")) {
    const match = line.match(/^\s*(?:readonly\s+)?([A-Za-z0-9_]+)(?:<[^>]+>)?\s*[:(]/);
    if (match) members.add(match[1]!);
  }
  return members;
}

function extractObjectKeys(source: string, prefix: string): Set<string> {
  const blockMatch = source.match(new RegExp(`${prefix} = \\{([\\s\\S]*?)\\n\\s*\\};`, "m"));
  if (!blockMatch) throw new Error(`Could not find object literal for ${prefix}`);

  const keys = new Set<string>();
  for (const line of blockMatch[1]!.split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*(?::|,)/);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

function extractHelpfulNamespaceTargets(source: string): Set<string> {
  return new Set(
    Array.from(source.matchAll(/helpfulNamespace\("([A-Za-z0-9_]+)"/g)).map((match) => match[1]!),
  );
}

describe("runtimeSurface manifests", () => {
  it("throws a helpful error for missing namespace members", () => {
    const wrapped = helpfulNamespace("workspace", { list: async () => [], openPanel: async () => {} });

    expect(() => (wrapped as Record<string, unknown>)["listSources"]).toThrow(
      "workspace.listSources is not available. Known members on workspace: list, openPanel. Call `await help()` for the live surface.",
    );
  });

  it("matches the panel runtime export surface and wrapped namespaces", () => {
    const panelSource = fs.readFileSync(new URL("../panel/index.ts", import.meta.url), "utf8");
    const exports = extractNamedExports(panelSource);
    const wrappedNamespaces = extractHelpfulNamespaceTargets(panelSource);

    expect(new Set(Object.keys(panelRuntimeSurface.exports))).toEqual(exports);
    expect(wrappedNamespaces).toEqual(new Set(["workers", "oauth", "adblock", "workspace", "credentials", "notifications"]));
  });

  it("matches the worker runtime interface, object shape, and wrapped namespaces", () => {
    const workerSource = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
    const interfaceMembers = extractInterfaceMembers(workerSource, "WorkerRuntime");
    const runtimeKeys = extractObjectKeys(workerSource, "const runtime: WorkerRuntime");
    const wrappedNamespaces = extractHelpfulNamespaceTargets(workerSource);

    expect(new Set(Object.keys(workerRuntimeSurface.exports))).toEqual(interfaceMembers);
    expect(runtimeKeys).toEqual(interfaceMembers);
    expect(wrappedNamespaces).toEqual(new Set(["workers", "workspace", "credentials", "notifications"]));
  });
});
