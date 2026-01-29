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

/**
 * Packages that are known to work as browser ESM.
 * Only these packages will be served via the ESM endpoint.
 * Others fall back to normal bundling in the panel build.
 */
export const ESM_SAFE_PACKAGES = new Set([
  "typescript",      // Pure JS, no Node deps
  "highlight.js",    // Browser-compatible
  "sucrase",         // Pure JS transform
  "@babel/parser",   // Pure JS parser
  "@babel/types",    // Pure JS types
  "acorn",           // Pure JS parser
  "prettier",        // Pure JS (standalone build)
]);

/**
 * Node.js built-ins that should be marked as external during bundling.
 * These won't work in browsers without polyfills.
 */
const NODE_BUILTINS = [
  "fs", "path", "crypto", "buffer", "stream", "util", "os",
  "child_process", "http", "https", "net", "dns", "tls",
  "events", "assert", "zlib", "querystring", "url", "vm",
  "worker_threads", "cluster", "readline", "repl", "tty",
  "dgram", "process", "module", "perf_hooks", "async_hooks",
  "trace_events", "v8", "inspector", "constants",
];

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
   * Get the ESM bundle for a package.
   * Returns cached version if available, otherwise transforms on-demand.
   *
   * @param pkgName - Package name (e.g., "typescript")
   * @param version - Version string (e.g., "5.3.3") or "latest"
   * @returns The ESM bundle as a string
   */
  async getEsmBundle(pkgName: string, version: string = "latest"): Promise<string> {
    // Resolve "latest" to actual version if needed
    const resolvedVersion = version === "latest"
      ? await this.resolveLatestVersion(pkgName)
      : version;

    if (!resolvedVersion) {
      throw new Error(`Package not found: ${pkgName}`);
    }

    const cacheKey = `${pkgName}@${resolvedVersion}`;

    // Check cache
    const cached = this.getCached(pkgName, resolvedVersion);
    if (cached) {
      return cached;
    }

    // Promise coalescing - concurrent requests share same transform
    const existing = this.transformLocks.get(cacheKey);
    if (existing) {
      return existing;
    }

    console.log(`[ESM] Transforming: ${cacheKey}`);
    const promise = this.doTransform(pkgName, resolvedVersion)
      .finally(() => this.transformLocks.delete(cacheKey));

    this.transformLocks.set(cacheKey, promise);
    return promise;
  }

  /**
   * Resolve the latest version of a package by querying Verdaccio's registry API.
   * This triggers uplinks to npm if the package isn't cached locally.
   */
  private async resolveLatestVersion(pkgName: string): Promise<string | null> {
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
        return packument["dist-tags"].latest;
      }

      // Fall back to highest version
      if (packument.versions) {
        const versions = Object.keys(packument.versions);
        if (versions.length > 0) {
          const lastVersion = versions[versions.length - 1];
          if (lastVersion) return lastVersion;
        }
      }

      return null;
    } catch (error) {
      console.error(`[ESM] Failed to resolve latest version for ${pkgName}:`, error);
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
  private getCached(pkgName: string, version: string): string | null {
    const cachePath = this.getCachePath(pkgName, version);
    if (fs.existsSync(cachePath)) {
      return fs.readFileSync(cachePath, "utf-8");
    }
    return null;
  }

  /**
   * Get the cache path for a package version.
   */
  private getCachePath(pkgName: string, version: string): string {
    // Handle scoped packages: @scope/name → @scope/name/version.js
    return path.join(this.cacheDir, pkgName, `${version}.js`);
  }

  /**
   * Transform a package to ESM format.
   * Fetches package from Verdaccio (which uplinks to npm) if not already cached.
   */
  private async doTransform(pkgName: string, version: string): Promise<string> {
    // Check if we already have the package extracted in our cache
    const extractedDir = path.join(this.cacheDir, "_extracted", pkgName, version);
    let pkgRoot: string;

    if (fs.existsSync(extractedDir)) {
      pkgRoot = extractedDir;
    } else {
      // Fetch package from Verdaccio (which uplinks to npm if needed)
      pkgRoot = await this.fetchPackageFromVerdaccio(pkgName, version, extractedDir);
    }

    // Read package.json to find the entry point
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

    const entryPath = path.join(pkgRoot, entryPoint);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Entry point not found: ${entryPath}`);
    }

    return this.bundlePackage(pkgName, version, entryPath);
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

    console.log(`[ESM] Fetching tarball: ${tarballUrl}`);

    // Download tarball to temp location
    const tempDir = path.join(this.cacheDir, "_temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempTarball = path.join(tempDir, `${baseName}-${version}.tgz`);

    await this.downloadFile(tarballUrl, tempTarball);

    // Extract tarball
    const extractedRoot = await this.extractTarball(tempTarball, destDir);

    // Clean up temp tarball
    try {
      fs.rmSync(tempTarball);
    } catch {
      // Ignore cleanup errors
    }

    console.log(`[ESM] Extracted ${pkgName}@${version} to ${extractedRoot}`);
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
   * Bundle a package entry point to ESM format.
   */
  private async bundlePackage(pkgName: string, version: string, entryPath: string): Promise<string> {
    // Bundle with esbuild
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      minify: true,
      sourcemap: false,
      // Mark Node built-ins as external
      external: NODE_BUILTINS,
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
      throw new Error(`ESBuild produced no output for ${pkgName}@${version}`);
    }

    // Cache the result
    const cachePath = this.getCachePath(pkgName, version);
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cachePath, bundle);

    // Cleanup old cache entries if needed (simple LRU based on mtime)
    this.evictCacheIfNeeded();

    console.log(`[ESM] Transformed ${pkgName}@${version} (${bundle.length} bytes)`);
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
          console.log(`[ESM] Evicted from cache: ${file.path}`);
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
