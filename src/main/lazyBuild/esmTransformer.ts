/**
 * ESM Transformer - transforms npm packages to browser-compatible ESM on-demand.
 *
 * This acts like a local esm.sh, converting CJS/UMD packages to ESM format
 * with caching in Verdaccio's storage directory.
 *
 * Usage:
 *   GET /-/esm/typescript         → Latest version of TypeScript as ESM
 *   GET /-/esm/typescript@5.3.3   → Specific version as ESM
 */

import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as esbuild from "esbuild";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("ESM");

/**
 * Packages that are known to work as browser ESM.
 * Only these packages will be served via the ESM endpoint.
 * Others fall back to normal bundling in the panel build.
 */
export const ESM_SAFE_PACKAGES = new Set([
  "typescript",           // Pure JS, no Node deps
  "highlight.js",         // Browser-compatible
  "sucrase",              // Pure JS transform
  "ts-interface-checker", // Dependency of sucrase
  "@babel/parser",        // Pure JS parser
  "@babel/types",         // Pure JS types
  "acorn",                // Pure JS parser
  "prettier",             // Pure JS (standalone build)
]);

/**
 * Node.js built-ins that should be marked as external during bundling.
 * These won't work in browsers without polyfills.
 */
const NODE_BUILTINS = new Set([
  "fs", "path", "crypto", "buffer", "stream", "util", "os",
  "child_process", "http", "https", "net", "dns", "tls",
  "events", "assert", "zlib", "querystring", "url", "vm",
  "worker_threads", "cluster", "readline", "repl", "tty",
  "dgram", "process", "module", "perf_hooks", "async_hooks",
  "trace_events", "v8", "inspector", "constants",
]);

export interface EsmTransformerOptions {
  /** Directory to cache transformed ESM bundles */
  cacheDir: string;
  /** Maximum cache size in bytes (default: 500MB) */
  maxCacheSize?: number;
  /** Verdaccio server URL for fetching packages via uplinks */
  verdaccioUrl: string;
}

export class EsmTransformer {
  private readonly cacheDir: string;
  private readonly maxCacheSize: number;
  private readonly verdaccioUrl: string;
  /** In-memory cache of transforms in progress (promise coalescing) */
  private transformLocks = new Map<string, Promise<string>>();
  /** Cache of resolved package versions: pkgName -> version */
  private versionCache = new Map<string, string>();
  /** Cache of extracted package paths: pkgName@version -> extractedPath */
  private extractedPathCache = new Map<string, string>();

  constructor(options: EsmTransformerOptions) {
    this.cacheDir = options.cacheDir;
    this.maxCacheSize = options.maxCacheSize ?? 500 * 1024 * 1024; // 500MB default
    this.verdaccioUrl = options.verdaccioUrl;

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Check if a package is safe to serve as browser ESM.
   */
  isEsmSafe(pkgName: string): boolean {
    return ESM_SAFE_PACKAGES.has(pkgName);
  }

  /**
   * Get the ESM bundle for a package or a specific subpath within it.
   * Returns cached version if available, otherwise transforms on-demand.
   *
   * @param pkgName - Package name (e.g., "typescript")
   * @param version - Version string (e.g., "5.3.3") or "latest"
   * @param subpath - Optional subpath within the package (e.g., "lib/languages/arduino")
   * @returns The ESM bundle as a string
   */
  async getEsmBundle(pkgName: string, version: string = "latest", subpath?: string): Promise<string> {
    // Resolve "latest" to actual version if needed
    const resolvedVersion = version === "latest"
      ? await this.resolveLatestVersion(pkgName)
      : version;

    if (!resolvedVersion) {
      throw new Error(`Package not found: ${pkgName}`);
    }

    // Include subpath in cache key for subpath-specific bundles
    const cacheKey = subpath
      ? `${pkgName}@${resolvedVersion}/${subpath}`
      : `${pkgName}@${resolvedVersion}`;

    // Check cache
    const cached = this.getCached(pkgName, resolvedVersion, subpath);
    if (cached) {
      return cached;
    }

    // Promise coalescing - concurrent requests share same transform
    const existing = this.transformLocks.get(cacheKey);
    if (existing) {
      return existing;
    }

    log.verbose(` Transforming: ${cacheKey}`);
    const promise = this.doTransform(pkgName, resolvedVersion, subpath)
      .finally(() => this.transformLocks.delete(cacheKey));

    this.transformLocks.set(cacheKey, promise);
    return promise;
  }

  /**
   * Resolve the latest version of a package by querying Verdaccio's registry API.
   * This triggers uplinks to npm if the package isn't cached locally.
   */
  private async resolveLatestVersion(pkgName: string): Promise<string | null> {
    // Check cache first
    const cached = this.versionCache.get(pkgName);
    if (cached) {
      return cached;
    }

    // Query Verdaccio's registry API - this will uplink to npm if needed
    const encodedName = pkgName.startsWith("@")
      ? pkgName.replace("/", "%2F")
      : pkgName;
    const registryUrl = `${this.verdaccioUrl}/${encodedName}`;

    try {
      const packument = await this.fetchJson(registryUrl) as {
        "dist-tags"?: { latest?: string };
        versions?: Record<string, unknown>;
      };

      // Try dist-tags first
      if (packument["dist-tags"]?.latest) {
        const version = packument["dist-tags"].latest;
        this.versionCache.set(pkgName, version);
        return version;
      }

      // Fall back to highest version
      if (packument.versions) {
        const versions = Object.keys(packument.versions);
        if (versions.length > 0) {
          const lastVersion = versions[versions.length - 1];
          if (lastVersion) {
            this.versionCache.set(pkgName, lastVersion);
            return lastVersion;
          }
        }
      }

      return null;
    } catch (error) {
      console.error(`[ESM] Failed to resolve latest version for ${pkgName}:`, error);
      return null;
    }
  }

  /**
   * Resolve a semver range to a specific version.
   * For simplicity, we just get the latest version that satisfies the range.
   */
  private async resolveVersionRange(pkgName: string, range: string): Promise<string | null> {
    // For simple cases, just get latest
    if (range === "*" || range === "latest" || range === "") {
      return this.resolveLatestVersion(pkgName);
    }

    // If it looks like an exact version (no range operators), use it directly
    if (/^\d+\.\d+\.\d+/.test(range) && !range.includes(" ") && !range.includes("||")) {
      // Extract just the version part (handles 5.3.3, ^5.3.3, ~5.3.3, >=5.3.3)
      const match = range.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      if (match?.[1]) {
        return match[1];
      }
    }

    // For ranges, query the registry and find a matching version
    const encodedName = pkgName.startsWith("@")
      ? pkgName.replace("/", "%2F")
      : pkgName;
    const registryUrl = `${this.verdaccioUrl}/${encodedName}`;

    try {
      const packument = await this.fetchJson(registryUrl) as {
        "dist-tags"?: { latest?: string };
        versions?: Record<string, unknown>;
      };

      // For now, just return latest - proper semver resolution would need a semver library
      // This is sufficient for most use cases since we're bundling everything together
      if (packument["dist-tags"]?.latest) {
        return packument["dist-tags"].latest;
      }

      if (packument.versions) {
        const versions = Object.keys(packument.versions);
        if (versions.length > 0) {
          return versions[versions.length - 1] ?? null;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch JSON from a URL.
   */
  private async fetchJson(url: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const request = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || 80,
          path: urlObj.pathname,
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        },
        (response) => {
          if (response.statusCode === 404) {
            reject(new Error(`Not found: ${url}`));
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
            return;
          }

          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });

          response.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON from ${url}`));
            }
          });
        }
      );

      request.on("error", (err) => {
        reject(err);
      });

      request.end();
    });
  }

  /**
   * Get cached ESM bundle if it exists.
   */
  private getCached(pkgName: string, version: string, subpath?: string): string | null {
    const cachePath = this.getCachePath(pkgName, version, subpath);
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath, "utf-8");
    }
    return null;
  }

  /**
   * Get the cache path for a package version (and optional subpath).
   */
  private getCachePath(pkgName: string, version: string, subpath?: string): string {
    // Handle scoped packages: @scope/name → @scope/name/version.js
    // For subpaths: @scope/name/subpath → @scope/name/_subpaths/version/subpath.js
    if (subpath) {
      // Sanitize subpath for filesystem (replace slashes in subpath with __)
      const sanitizedSubpath = subpath.replace(/\//g, "__");
      return path.join(this.cacheDir, pkgName, "_subpaths", version, `${sanitizedSubpath}.js`);
    }
    return path.join(this.cacheDir, pkgName, `${version}.js`);
  }

  /**
   * Transform a package (or subpath within it) to ESM format.
   * Fetches package from Verdaccio (which uplinks to npm) if not already cached.
   */
  private async doTransform(pkgName: string, version: string, subpath?: string): Promise<string> {
    // Ensure the main package is extracted
    const pkgRoot = await this.ensurePackageExtracted(pkgName, version);

    let entryPath: string;

    if (subpath) {
      // Subpath import - resolve the specific file
      entryPath = path.join(pkgRoot, subpath);

      // Try adding extensions if the exact path doesn't exist
      if (!fs.existsSync(entryPath)) {
        for (const ext of [".js", ".mjs", ".cjs", ".json", "/index.js"]) {
          if (fs.existsSync(entryPath + ext)) {
            entryPath = entryPath + ext;
            break;
          }
        }
      }

      if (!fs.existsSync(entryPath)) {
        throw new Error(`Subpath not found: ${pkgName}/${subpath} (tried ${entryPath})`);
      }
    } else {
      // Main entry point - read package.json to find it
      const pkgJsonPath = path.join(pkgRoot, "package.json");
      if (!fs.existsSync(pkgJsonPath)) {
        throw new Error(`package.json not found for ${pkgName}`);
      }

      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        main?: string;
        module?: string;
        browser?: string | Record<string, string>;
      };

      // Determine entry point (prefer ESM if available)
      let entryPoint: string;
      if (typeof pkgJson.module === "string") {
        entryPoint = pkgJson.module;
      } else if (typeof pkgJson.browser === "string") {
        entryPoint = pkgJson.browser;
      } else if (pkgJson.main) {
        entryPoint = pkgJson.main;
      } else {
        entryPoint = "index.js";
      }

      entryPath = path.join(pkgRoot, entryPoint);
      if (!fs.existsSync(entryPath)) {
        throw new Error(`Entry point not found: ${entryPath}`);
      }
    }

    return this.bundlePackage(pkgName, version, entryPath, subpath);
  }

  /**
   * Ensure a package is extracted and return its root path.
   * Fetches from Verdaccio if not already extracted.
   */
  private async ensurePackageExtracted(pkgName: string, version: string): Promise<string> {
    const cacheKey = `${pkgName}@${version}`;

    // Check in-memory cache - but validate it still has package.json
    const cached = this.extractedPathCache.get(cacheKey);
    if (cached && this.isValidPackageDir(cached)) {
      return cached;
    }

    // Check if already extracted on disk
    const extractedDir = path.join(this.cacheDir, "_extracted", pkgName, version);
    const packageDir = path.join(extractedDir, "package");

    // Check package/ subdirectory first (standard npm tarball extraction)
    if (this.isValidPackageDir(packageDir)) {
      this.extractedPathCache.set(cacheKey, packageDir);
      return packageDir;
    }

    // Check extractedDir directly (some packages extract differently)
    if (this.isValidPackageDir(extractedDir)) {
      this.extractedPathCache.set(cacheKey, extractedDir);
      return extractedDir;
    }

    // Invalid or missing extraction - clean up and re-fetch
    if (fs.existsSync(extractedDir)) {
      log.verbose(` Cleaning up invalid extraction: ${extractedDir}`);
      try {
        fs.rmSync(extractedDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    // Fetch and extract
    const pkgRoot = await this.fetchPackageFromVerdaccio(pkgName, version, extractedDir);
    this.extractedPathCache.set(cacheKey, pkgRoot);
    return pkgRoot;
  }

  /**
   * Check if a directory is a valid package directory (has package.json).
   */
  private isValidPackageDir(dir: string): boolean {
    if (!fs.existsSync(dir)) return false;
    const pkgJsonPath = path.join(dir, "package.json");
    return fs.existsSync(pkgJsonPath);
  }

  /**
   * Fetch a package tarball from Verdaccio and extract it.
   * Verdaccio will uplink to npm if the package isn't already cached.
   */
  private async fetchPackageFromVerdaccio(
    pkgName: string,
    version: string,
    destDir: string
  ): Promise<string> {
    // Construct tarball URL - handle scoped packages
    // @scope/name -> @scope/name/-/name-version.tgz
    // name -> name/-/name-version.tgz
    const baseName = pkgName.startsWith("@")
      ? pkgName.split("/")[1]
      : pkgName;
    const tarballUrl = `${this.verdaccioUrl}/${pkgName}/-/${baseName}-${version}.tgz`;

    log.verbose(` Fetching tarball: ${tarballUrl}`);

    // Download tarball to temp location
    const tempDir = path.join(this.cacheDir, "_temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempTarball = path.join(tempDir, `${baseName}-${version}-${Date.now()}.tgz`);

    await this.downloadFile(tarballUrl, tempTarball);

    // Extract tarball
    const extractedRoot = await this.extractTarball(tempTarball, destDir);

    // Clean up temp tarball
    try {
      fs.rmSync(tempTarball);
    } catch {
      // Ignore cleanup errors
    }

    log.verbose(` Extracted ${pkgName}@${version} to ${extractedRoot}`);
    return extractedRoot;
  }

  /**
   * Download a file from a URL to a local path.
   */
  private async downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const request = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || 80,
          path: urlObj.pathname,
          method: "GET",
        },
        (response) => {
          if (response.statusCode === 404) {
            reject(new Error(`Package not found: ${url}`));
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
            return;
          }

          const writeStream = fs.createWriteStream(destPath);
          response.pipe(writeStream);

          writeStream.on("finish", () => {
            writeStream.close();
            resolve();
          });

          writeStream.on("error", (err) => {
            fs.rmSync(destPath, { force: true });
            reject(err);
          });
        }
      );

      request.on("error", (err) => {
        reject(err);
      });

      request.end();
    });
  }

  /**
   * Create an esbuild plugin that resolves npm dependencies by fetching them on-demand.
   */
  private createDependencyResolverPlugin(): esbuild.Plugin {
    // Track packages being resolved to prevent infinite loops
    const resolving = new Set<string>();

    return {
      name: "npm-dependency-resolver",
      setup: (build) => {
        // Intercept bare module specifiers (npm packages)
        build.onResolve({ filter: /^[^./]/ }, async (args) => {
          // Skip Node built-ins
          const moduleName = args.path.startsWith("node:")
            ? args.path.slice(5)
            : args.path;

          if (NODE_BUILTINS.has(moduleName)) {
            return { path: args.path, external: true };
          }

          // Parse package name from import path
          // @scope/pkg/subpath -> @scope/pkg
          // pkg/subpath -> pkg
          let pkgName: string;
          let subpath: string | undefined;

          if (args.path.startsWith("@")) {
            const parts = args.path.split("/");
            pkgName = `${parts[0]}/${parts[1]}`;
            subpath = parts.slice(2).join("/") || undefined;
          } else {
            const parts = args.path.split("/");
            pkgName = parts[0] ?? args.path;
            subpath = parts.slice(1).join("/") || undefined;
          }

          // Prevent circular resolution
          const resolveKey = `${pkgName}:${args.importer}`;
          if (resolving.has(resolveKey)) {
            return { path: args.path, external: true };
          }

          try {
            resolving.add(resolveKey);

            // Get the version from the importing package's dependencies
            let version: string | null = null;

            if (args.importer) {
              // Find package.json of the importer
              let searchDir = path.dirname(args.importer);
              while (searchDir !== path.dirname(searchDir)) {
                const pkgJsonPath = path.join(searchDir, "package.json");
                if (fs.existsSync(pkgJsonPath)) {
                  try {
                    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
                      dependencies?: Record<string, string>;
                      devDependencies?: Record<string, string>;
                      peerDependencies?: Record<string, string>;
                    };

                    const deps = {
                      ...pkgJson.dependencies,
                      ...pkgJson.devDependencies,
                      ...pkgJson.peerDependencies,
                    };

                    const depVersion = deps[pkgName];
                    if (depVersion) {
                      version = await this.resolveVersionRange(pkgName, depVersion);
                    }
                  } catch {
                    // Ignore parse errors
                  }
                  break;
                }
                searchDir = path.dirname(searchDir);
              }
            }

            // Fall back to latest version
            if (!version) {
              version = await this.resolveLatestVersion(pkgName);
            }

            if (!version) {
              console.warn(`[ESM] Could not resolve version for ${pkgName}`);
              return { path: args.path, external: true };
            }

            // Ensure package is extracted
            const pkgRoot = await this.ensurePackageExtracted(pkgName, version);

            // Resolve the actual file path
            let resolvedPath: string;

            if (subpath) {
              // Direct subpath import
              resolvedPath = path.join(pkgRoot, subpath);

              // Try adding extensions if needed
              if (!fs.existsSync(resolvedPath)) {
                for (const ext of [".js", ".mjs", ".cjs", ".json", "/index.js"]) {
                  if (fs.existsSync(resolvedPath + ext)) {
                    resolvedPath = resolvedPath + ext;
                    break;
                  }
                }
              }
            } else {
              // Main entry point
              const pkgJsonPath = path.join(pkgRoot, "package.json");
              const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
                main?: string;
                module?: string;
                browser?: string | Record<string, string>;
                exports?: Record<string, unknown>;
              };

              // Prefer module > browser > main > index.js
              if (pkgJson.module) {
                resolvedPath = path.join(pkgRoot, pkgJson.module);
              } else if (typeof pkgJson.browser === "string") {
                resolvedPath = path.join(pkgRoot, pkgJson.browser);
              } else if (pkgJson.main) {
                resolvedPath = path.join(pkgRoot, pkgJson.main);
              } else {
                resolvedPath = path.join(pkgRoot, "index.js");
              }
            }

            // Ensure the resolved path exists
            if (!fs.existsSync(resolvedPath)) {
              console.warn(`[ESM] Resolved path not found: ${resolvedPath} for ${args.path}`);
              return { path: args.path, external: true };
            }

            return { path: resolvedPath };
          } catch (error) {
            console.warn(`[ESM] Failed to resolve ${pkgName}:`, error instanceof Error ? error.message : error);
            return { path: args.path, external: true };
          } finally {
            resolving.delete(resolveKey);
          }
        });
      },
    };
  }

  /**
   * Bundle a package entry point to ESM format.
   */
  private async bundlePackage(pkgName: string, version: string, entryPath: string, subpath?: string): Promise<string> {
    // Bundle with esbuild using our dependency resolver plugin
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      minify: true,
      sourcemap: false,
      plugins: [this.createDependencyResolverPlugin()],
      // Handle any remaining node: imports
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      logLevel: "error",
    });

    if (result.errors.length > 0) {
      throw new Error(`ESBuild errors: ${result.errors.map(e => e.text).join(", ")}`);
    }

    const bundle = result.outputFiles[0]?.text;
    if (!bundle) {
      throw new Error(`ESBuild produced no output for ${pkgName}@${version}${subpath ? `/${subpath}` : ""}`);
    }

    // Cache the result
    const cachePath = this.getCachePath(pkgName, version, subpath);
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cachePath, bundle);

    // Cleanup old cache entries if needed (simple LRU based on mtime)
    this.evictCacheIfNeeded();

    const transformedName = subpath ? `${pkgName}@${version}/${subpath}` : `${pkgName}@${version}`;
    log.verbose(` Transformed ${transformedName} (${bundle.length} bytes)`);
    return bundle;
  }

  /**
   * Extract a tarball to a directory.
   */
  private async extractTarball(tgzPath: string, destDir: string): Promise<string> {
    const { promisify } = await import("util");
    const { exec } = await import("child_process");
    const execAsync = promisify(exec);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    await execAsync(`tar -xzf "${tgzPath}" -C "${destDir}"`);

    // npm packages extract to a "package" subdirectory
    const packageDir = path.join(destDir, "package");
    if (fs.existsSync(packageDir)) {
      return packageDir;
    }

    return destDir;
  }

  /**
   * Evict old cache entries if total size exceeds max.
   */
  private evictCacheIfNeeded(): void {
    try {
      const files = this.getAllCacheFiles();

      // Calculate total size
      let totalSize = 0;
      for (const file of files) {
        totalSize += file.size;
      }

      if (totalSize <= this.maxCacheSize) {
        return;
      }

      // Sort by mtime (oldest first) and delete until under limit
      files.sort((a, b) => a.mtime - b.mtime);

      for (const file of files) {
        if (totalSize <= this.maxCacheSize) {
          break;
        }
        try {
          fs.rmSync(file.path);
          totalSize -= file.size;
          log.verbose(` Evicted from cache: ${file.path}`);
        } catch {
          // Ignore errors during eviction
        }
      }
    } catch {
      // Ignore cache eviction errors
    }
  }

  /**
   * Get all cache files with metadata.
   */
  private getAllCacheFiles(): Array<{ path: string; size: number; mtime: number }> {
    const files: Array<{ path: string; size: number; mtime: number }> = [];

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          try {
            const stat = fs.statSync(fullPath);
            files.push({
              path: fullPath,
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          } catch {
            // Skip files we can't stat
          }
        }
      }
    };

    walk(this.cacheDir);
    return files;
  }
}
