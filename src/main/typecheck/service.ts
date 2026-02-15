/**
 * Main process TypeDefinitionService for NatStack type checking.
 *
 * Provides type definitions to the code-editor via RPC.
 * Installs npm packages on demand for type resolution.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import Arborist from "@npmcli/arborist";
import { createTypeDefinitionLoader, loadNatstackPackageTypes, clearNatstackTypesCache, preloadNatstackTypesAsync, type NatstackPackageTypes } from "@natstack/typecheck";
import { getPackagesDir } from "../paths.js";
import { getUserDataPath } from "../envPaths.js";

const NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Node.js built-in modules that shouldn't be fetched from npm.
 */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks",
  "process", "punycode", "querystring", "readline", "repl", "stream",
  "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * Internal package prefixes that don't exist on npm.
 */
const INTERNAL_PREFIXES = ["@protocol/", "@injected/", "@trace/", "@recorder/", "@isomorphic/"];

/**
 * Check if a package should be skipped (not fetched from npm).
 */
function shouldSkipPackage(packageName: string): boolean {
  if (packageName.startsWith("node:")) return true;
  if (NODE_BUILTINS.has(packageName)) return true;
  if (packageName.startsWith("#")) return true;
  if (packageName === "node_modules") return true;
  for (const prefix of INTERNAL_PREFIXES) {
    if (packageName.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Get a stable directory for type-checking deps, keyed by panel path.
 */
function getTypecheckDepsDir(panelPath: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(panelPath)).digest("hex").slice(0, 16);
  const dir = path.join(getUserDataPath(), "typecheck-deps", hash);
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Result type for package types */
export interface PackageTypesResult {
  files: Record<string, string>;
  referencedPackages?: string[];
  entryPoint?: string;
  error?: string;
  skipped?: boolean;
}

/**
 * TypeDefinitionService - provides type definitions to code-editor via RPC.
 */
export class TypeDefinitionService {
  /** Cached @natstack package types */
  private natstackTypes: Record<string, NatstackPackageTypes> | null = null;

  /** Installation lock to prevent concurrent Arborist runs */
  private installLock: Promise<void> | null = null;

  /**
   * Get @natstack package types from the local packages directory.
   */
  private getNatstackTypes(packageName: string): Record<string, string> {
    if (this.natstackTypes === null) {
      const packagesDir = getPackagesDir();
      if (packagesDir) {
        this.natstackTypes = loadNatstackPackageTypes(packagesDir);
      } else {
        this.natstackTypes = {};
      }
    }
    return this.natstackTypes[packageName]?.files ?? {};
  }

  /**
   * Get type definitions for packages.
   */
  async getPackageTypes(
    panelPath: string,
    packageNames: string[]
  ): Promise<Map<string, PackageTypesResult>> {
    const results = new Map<string, PackageTypesResult>();
    const toInstall: string[] = [];

    for (const packageName of packageNames) {
      // Skip non-npm packages
      if (shouldSkipPackage(packageName)) {
        results.set(packageName, { files: {}, skipped: true });
        continue;
      }

      // Check @workspace/* local packages
      if (packageName.startsWith("@workspace/")) {
        const types = this.getNatstackTypes(packageName);
        if (Object.keys(types).length > 0) {
          results.set(packageName, { files: types });
          continue;
        }
      }

      toInstall.push(packageName);
    }

    if (toInstall.length === 0) return results;

    // Install and load types
    const depsDir = getTypecheckDepsDir(panelPath);
    const nodeModulesDir = path.join(depsDir, "node_modules");

    try {
      await this.ensurePackagesInstalled(depsDir, toInstall);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      for (const pkg of toInstall) {
        results.set(pkg, { files: {}, error: errorMsg });
      }
      return results;
    }

    // Load types
    const loader = createTypeDefinitionLoader({ nodeModulesPaths: [nodeModulesDir] });
    for (const packageName of toInstall) {
      try {
        const loaded = await loader.loadPackageTypes(packageName);
        if (loaded && loaded.files.size > 0) {
          results.set(packageName, {
            files: Object.fromEntries(loaded.files),
            referencedPackages: loaded.referencedPackages,
            entryPoint: loaded.entryPoint ?? undefined,
          });
        } else {
          results.set(packageName, { files: {} });
        }
      } catch (error) {
        results.set(packageName, {
          files: {},
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Ensure packages are installed in the deps directory.
   */
  private async ensurePackagesInstalled(depsDir: string, packageNames: string[]): Promise<void> {
    // Wait for any in-flight installation
    while (this.installLock) {
      await this.installLock;
    }

    // Check if all packages are already installed
    const nodeModulesDir = path.join(depsDir, "node_modules");
    const missing: string[] = [];
    for (const pkg of packageNames) {
      const pkgPath = path.join(nodeModulesDir, ...pkg.split("/"), "package.json");
      try {
        await fs.access(pkgPath);
      } catch {
        missing.push(pkg);
      }
    }

    if (missing.length === 0) return;

    // Install missing packages
    this.installLock = this.doInstall(depsDir, missing);
    try {
      await this.installLock;
    } finally {
      this.installLock = null;
    }
  }

  /**
   * Install packages using Arborist (standard npm install).
   */
  private async doInstall(depsDir: string, packageNames: string[]): Promise<void> {
    const packageJsonPath = path.join(depsDir, "package.json");

    // Read or create package.json
    let packageJson: { name: string; private: boolean; dependencies: Record<string, string> };
    try {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      packageJson = JSON.parse(content);
      packageJson.dependencies = packageJson.dependencies ?? {};
    } catch {
      packageJson = { name: "natstack-dev-types", private: true, dependencies: {} };
    }

    // Add packages
    for (const name of packageNames) {
      packageJson.dependencies[name] = "*";
    }
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

    // Install using Arborist reify (standard npm install)
    let retries = 0;
    while (retries < 3) {
      try {
        const arborist = new Arborist({
          path: depsDir,
          registry: NPM_REGISTRY,
          legacyPeerDeps: true,
        });
        await arborist.buildIdealTree();
        await arborist.reify();
        break;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Extract package name from 404 errors and retry without it
        const failedPkg = this.extractPackageFrom404(errorMsg);
        if (failedPkg && packageJson.dependencies[failedPkg]) {
          delete packageJson.dependencies[failedPkg];
          await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
          retries++;
          continue;
        }
        throw error;
      }
    }

    // Install @types/* for packages without built-in types
    await this.installTypesPackages(depsDir, packageNames, packageJson);
  }

  /**
   * Extract package name from a 404 error message.
   */
  private extractPackageFrom404(errorMsg: string): string | null {
    if (!errorMsg.includes("404")) return null;
    const match = errorMsg.match(/https?:\/\/[^\s]+\/(@[a-z0-9_-]+%2f[a-z0-9_-]+|[a-z0-9_-]+)(?:\s|$|-)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Install @types/* packages for those without built-in types.
   */
  private async installTypesPackages(
    depsDir: string,
    packageNames: string[],
    packageJson: { name: string; private: boolean; dependencies: Record<string, string> }
  ): Promise<void> {
    const packageJsonPath = path.join(depsDir, "package.json");
    const nodeModulesDir = path.join(depsDir, "node_modules");
    const typesNeeded: string[] = [];

    for (const name of packageNames) {
      if (name.startsWith("@types/")) continue;
      const pkgJsonPath = path.join(nodeModulesDir, ...name.split("/"), "package.json");
      try {
        const content = await fs.readFile(pkgJsonPath, "utf-8");
        const pkg = JSON.parse(content) as { types?: string; typings?: string };
        if (!pkg.types && !pkg.typings) {
          typesNeeded.push(`@types/${name.replace("@", "").replace("/", "__")}`);
        }
      } catch { /* ignore */ }
    }

    if (typesNeeded.length === 0) return;

    for (const typesPkg of typesNeeded) {
      packageJson.dependencies[typesPkg] = "*";
    }
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

    try {
      const arborist = new Arborist({
        path: depsDir,
        registry: NPM_REGISTRY,
        legacyPeerDeps: true,
      });
      await arborist.buildIdealTree();
      await arborist.reify();
    } catch (error) {
      // @types/* failures are non-fatal - some packages don't have types
      const failedPkg = this.extractPackageFrom404(String(error));
      if (failedPkg) {
        delete packageJson.dependencies[failedPkg];
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
      }
    }
  }

  /**
   * Invalidate and reload @workspace/* types cache.
   */
  async invalidateNatstackTypes(): Promise<void> {
    this.natstackTypes = null;
    clearNatstackTypesCache();
    // Re-preload the cache so subsequent sync reads work
    const packagesDir = getPackagesDir();
    if (packagesDir) {
      await preloadNatstackTypesAsync(packagesDir);
    }
  }

  /**
   * Clean up resources.
   */
  shutdown(): void {
    this.natstackTypes = null;
  }
}

// Singleton
let serviceInstance: TypeDefinitionService | null = null;

export function getTypeDefinitionService(): TypeDefinitionService {
  if (!serviceInstance) {
    serviceInstance = new TypeDefinitionService();
  }
  return serviceInstance;
}

// =============================================================================
// Type Checking Service (runs TypeScript compiler in main process)
// =============================================================================

import type { TypeCheckService, TypeCheckDiagnostic } from "@natstack/typecheck";

/** Per-panel TypeCheckService cache */
const typeCheckServiceCache = new Map<string, TypeCheckService>();

/**
 * Get or create a TypeCheckService for a panel path.
 * Uses the factory with direct access to TypeDefinitionService (no RPC needed
 * since we're already in the main process).
 */
async function getOrCreateTypeCheckService(panelPath: string): Promise<TypeCheckService> {
  const resolved = path.resolve(panelPath);
  const cached = typeCheckServiceCache.get(resolved);
  if (cached) return cached;

  const { createPanelTypeCheckService, createDiskFileSource } = await import("@natstack/typecheck");

  const service = await createPanelTypeCheckService({
    panelPath: resolved,
    fileSource: createDiskFileSource(resolved),
    // In the main process, external types are resolved directly via TypeDefinitionService
    rpcCall: async <T>(targetId: string, method: string, ...args: unknown[]) => {
      // Route typecheck.getPackageTypes directly to the local service
      if (method === "typecheck.getPackageTypes") {
        return typeCheckRpcMethods["typecheck.getPackageTypes"](
          args[0] as string,
          args[1] as string
        ) as T;
      }
      if (method === "typecheck.getPackageTypesBatch") {
        return typeCheckRpcMethods["typecheck.getPackageTypesBatch"](
          args[0] as string,
          args[1] as string[]
        ) as T;
      }
      throw new Error(`Unknown RPC method in main process typecheck: ${method}`);
    },
  });

  typeCheckServiceCache.set(resolved, service);
  return service;
}

/** Serializable diagnostic (without ts.DiagnosticCategory enum reference) */
interface SerializedDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
  code: number;
}

function serializeDiagnostics(diagnostics: TypeCheckDiagnostic[]): SerializedDiagnostic[] {
  return diagnostics.map(d => ({
    file: d.file,
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
    severity: d.severity,
    code: d.code,
  }));
}

/**
 * RPC methods for the code-editor.
 */
export const typeCheckRpcMethods = {
  "typecheck.getPackageTypes": async (
    panelPath: string,
    packageName: string
  ): Promise<{ files: Record<string, string>; referencedPackages?: string[]; entryPoint?: string }> => {
    const results = await getTypeDefinitionService().getPackageTypes(panelPath, [packageName]);
    const result = results.get(packageName);
    return {
      files: result?.files ?? {},
      referencedPackages: result?.referencedPackages,
      entryPoint: result?.entryPoint,
    };
  },

  "typecheck.getPackageTypesBatch": async (
    panelPath: string,
    packageNames: string[]
  ): Promise<Record<string, PackageTypesResult>> => {
    const results = await getTypeDefinitionService().getPackageTypes(panelPath, packageNames);
    return Object.fromEntries(results);
  },

  "typecheck.check": async (
    panelPath: string,
    filePath?: string,
    fileContent?: string
  ): Promise<{ diagnostics: SerializedDiagnostic[]; checkedFiles: string[] }> => {
    const service = await getOrCreateTypeCheckService(panelPath);

    // Update file content if provided
    if (filePath && fileContent !== undefined) {
      const resolvedFile = path.resolve(panelPath, filePath);
      service.updateFile(resolvedFile, fileContent);
    }

    const result = await service.checkWithExternalTypes(
      filePath ? path.resolve(panelPath, filePath) : undefined
    );
    return {
      diagnostics: serializeDiagnostics(result.diagnostics),
      checkedFiles: result.checkedFiles,
    };
  },

  "typecheck.getTypeInfo": async (
    panelPath: string,
    filePath: string,
    line: number,
    column: number,
    fileContent?: string
  ): Promise<{ displayParts: string; documentation?: string; tags?: { name: string; text?: string }[] } | null> => {
    const service = await getOrCreateTypeCheckService(panelPath);
    const resolvedFile = path.resolve(panelPath, filePath);

    // Ensure file is loaded/updated
    if (fileContent !== undefined) {
      service.updateFile(resolvedFile, fileContent);
    } else if (!service.hasFile(resolvedFile)) {
      try {
        const content = await fs.readFile(resolvedFile, "utf-8");
        service.updateFile(resolvedFile, content);
      } catch (err) {
        return null;
      }
    }

    const info = service.getQuickInfo(resolvedFile, line, column);
    if (!info) return null;
    return {
      displayParts: info.displayParts,
      documentation: info.documentation,
      tags: info.tags?.map(t => ({ name: t.name, text: t.text })),
    };
  },

  "typecheck.getCompletions": async (
    panelPath: string,
    filePath: string,
    line: number,
    column: number,
    fileContent?: string
  ): Promise<{ entries: { name: string; kind: string }[] } | null> => {
    const service = await getOrCreateTypeCheckService(panelPath);
    const resolvedFile = path.resolve(panelPath, filePath);

    // Ensure file is loaded/updated
    if (fileContent !== undefined) {
      service.updateFile(resolvedFile, fileContent);
    } else if (!service.hasFile(resolvedFile)) {
      try {
        const content = await fs.readFile(resolvedFile, "utf-8");
        service.updateFile(resolvedFile, content);
      } catch (err) {
        return null;
      }
    }

    const completions = service.getCompletions(resolvedFile, line, column);
    if (!completions || completions.entries.length === 0) return null;

    return {
      entries: completions.entries.map(e => ({ name: e.name, kind: e.kind })),
    };
  },
};

export function shutdownTypeDefinitionService(): void {
  if (serviceInstance) {
    serviceInstance.shutdown();
    serviceInstance = null;
  }
  typeCheckServiceCache.clear();
}
