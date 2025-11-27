import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import Arborist from "@npmcli/arborist";
import type { PanelManifest, PanelBuildResult, PanelBuildCache } from "./panelTypes.js";

const CACHE_FILENAME = "build-cache.json";
const PANEL_RUNTIME_DIRNAME = ".natstack";
const PANEL_BUILD_CACHE_VERSION = 3;

// Keep only fs virtual modules (natstack/* now resolved via workspace packages)
const panelFsModulePath = path.join(__dirname, "panelFsRuntime.js");
const panelFsPromisesModulePath = path.join(__dirname, "panelFsPromisesRuntime.js");

const fsModuleMap = new Map([
  ["fs", panelFsModulePath],
  ["node:fs", panelFsModulePath],
  ["fs/promises", panelFsPromisesModulePath],
  ["node:fs/promises", panelFsPromisesModulePath],
]);

for (const [name, modulePath] of fsModuleMap) {
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Runtime module ${name} not found at ${modulePath}`);
  }
}

const defaultPanelDependencies: Record<string, string> = {
  // Ensure a predictable panel runtime baseline
  "@natstack/panel": "workspace:*",
  // Provide Node types to satisfy dependencies that expect them at runtime
  "@types/node": "^22.9.0",
};

export class PanelBuilder {
  private cache: Map<string, PanelBuildCache> = new Map();
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = path.resolve(cacheDir);

    // Ensure directories exist
    fs.mkdirSync(this.cacheDir, { recursive: true });

    // Load cache from disk
    this.loadCache();
  }

  private loadCache(): void {
    const cacheFile = path.join(this.cacheDir, CACHE_FILENAME);
    if (fs.existsSync(cacheFile)) {
      try {
        const data = fs.readFileSync(cacheFile, "utf-8");
        const cacheArray = JSON.parse(data) as PanelBuildCache[];
        const filtered = cacheArray.filter(
          (item) => item.cacheVersion === PANEL_BUILD_CACHE_VERSION
        );
        this.cache = new Map(filtered.map((item) => [item.path, item]));
      } catch (error) {
        console.error("Failed to load panel cache:", error);
      }
    }
  }

  private saveCache(): void {
    const cacheFile = path.join(this.cacheDir, CACHE_FILENAME);
    try {
      const cacheArray = Array.from(this.cache.values());
      fs.writeFileSync(cacheFile, JSON.stringify(cacheArray, null, 2));
    } catch (error) {
      console.error("Failed to save panel cache:", error);
    }
  }

  private async hashDirectory(dirPath: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    const files = this.getAllFiles(dirPath);

    // Sort files for consistent hashing
    files.sort();

    for (const file of files) {
      // Skip node_modules and build artifacts
      if (
        file.includes("node_modules") ||
        file.includes("dist") ||
        file.includes(PANEL_RUNTIME_DIRNAME)
      ) {
        continue;
      }

      const content = fs.readFileSync(file);
      hash.update(file);
      hash.update(content);
    }

    return hash.digest("hex");
  }

  private getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
    if (!fs.existsSync(dirPath)) {
      return arrayOfFiles;
    }

    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      if (fs.statSync(fullPath).isDirectory()) {
        // Skip node_modules during file collection
        if (file !== "node_modules" && file !== "dist" && file !== PANEL_RUNTIME_DIRNAME) {
          this.getAllFiles(fullPath, arrayOfFiles);
        }
      } else {
        arrayOfFiles.push(fullPath);
      }
    }

    return arrayOfFiles;
  }

  private getRuntimeDir(panelPath: string): string {
    return path.join(panelPath, PANEL_RUNTIME_DIRNAME);
  }

  private ensureRuntimeDir(panelPath: string): string {
    const runtimeDir = this.getRuntimeDir(panelPath);
    fs.mkdirSync(runtimeDir, { recursive: true });

    // Copy global type definitions to runtime dir for panel TypeScript support
    this.ensureGlobalTypes(runtimeDir);

    return runtimeDir;
  }

  private ensureGlobalTypes(runtimeDir: string): void {
    // Copy globals.d.ts from panelRuntime to the panel's .natstack directory
    const sourceTypesPath = path.join(__dirname, "panelRuntimeGlobals.d.ts");
    const targetTypesPath = path.join(runtimeDir, "globals.d.ts");

    // The globals.d.ts gets compiled to panelRuntimeGlobals.d.ts in dist
    if (fs.existsSync(sourceTypesPath)) {
      const typesContent = fs.readFileSync(sourceTypesPath, "utf-8");
      const existingContent = fs.existsSync(targetTypesPath)
        ? fs.readFileSync(targetTypesPath, "utf-8")
        : null;

      if (existingContent !== typesContent) {
        fs.writeFileSync(targetTypesPath, typesContent);
      }
    }
  }

  private resolveHtmlPath(panelPath: string, title: string): string {
    const sourceHtmlPath = path.join(panelPath, "index.html");
    if (fs.existsSync(sourceHtmlPath)) {
      return sourceHtmlPath;
    }

    const runtimeDir = this.ensureRuntimeDir(panelPath);
    const generatedHtmlPath = path.join(runtimeDir, "index.html");

    // Import map for external dependencies loaded from CDN
    // isomorphic-git needs ESM from esm.sh for proper Buffer polyfill
    const importMap = {
      imports: {
        "isomorphic-git": "https://esm.sh/isomorphic-git",
        "isomorphic-git/http/web": "https://esm.sh/isomorphic-git/http/web",
      },
    };

    const defaultHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script type="importmap">${JSON.stringify(importMap)}</script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.2.1/styles.css">
  <link rel="stylesheet" href="./bundle.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./bundle.js"></script>
</body>
</html>`;
    fs.writeFileSync(generatedHtmlPath, defaultHtml);
    return generatedHtmlPath;
  }

  private getNodeResolutionPaths(panelPath: string): string[] {
    const runtimeNodeModules = path.join(this.getRuntimeDir(panelPath), "node_modules");
    const localNodeModules = path.join(panelPath, "node_modules");
    const projectNodeModules = path.join(process.cwd(), "node_modules");

    const paths: string[] = [];
    for (const candidate of [runtimeNodeModules, localNodeModules, projectNodeModules]) {
      paths.push(candidate);
    }
    return paths;
  }

  loadManifest(panelPath: string): PanelManifest {
    const absolutePanelPath = path.resolve(panelPath);
    const packageJsonPath = path.join(absolutePanelPath, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(`package.json not found in ${panelPath}`);
    }

    const packageContent = fs.readFileSync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageContent) as {
      natstack?: PanelManifest;
      dependencies?: Record<string, string>;
    };

    if (!packageJson.natstack) {
      throw new Error(`package.json in ${panelPath} must include a 'natstack' field`);
    }

    const manifest = packageJson.natstack;

    if (!manifest.title) {
      throw new Error("natstack.title must be specified in package.json");
    }

    // Merge package.json dependencies with natstack.dependencies
    if (packageJson.dependencies) {
      manifest.dependencies = {
        ...manifest.dependencies,
        ...packageJson.dependencies,
      };
    }

    return manifest;
  }

  private resolveEntryPoint(panelPath: string, manifest: PanelManifest): string {
    const absolutePanelPath = path.resolve(panelPath);

    const verifyEntry = (entryCandidate: string): string | null => {
      const entryPath = path.join(absolutePanelPath, entryCandidate);
      return fs.existsSync(entryPath) ? entryCandidate : null;
    };

    if (manifest.entry) {
      const entry = verifyEntry(manifest.entry);
      if (!entry) {
        throw new Error(`Entry point not found: ${manifest.entry}`);
      }
      return entry;
    }

    const defaultCandidates = [
      "index.tsx",
      "index.ts",
      "index.jsx",
      "index.js",
      "main.tsx",
      "main.ts",
    ];
    const entries = defaultCandidates.filter(verifyEntry);
    if (entries.length > 1) {
      throw new Error(
        `Multiple conventional entry points found (${entries.join(
          ", "
        )}). Please specify a single entry in panel.json.`
      );
    } else if (entries.length === 1) {
      return entries[0]!;
    }

    throw new Error(
      `No entry point found. Provide an entry file (e.g., index.tsx) or set 'entry' in panel.json`
    );
  }

  private resolveWorkspaceDependencies(dependencies: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    const workspaceRoot = process.cwd();

    for (const [pkg, version] of Object.entries(dependencies)) {
      if (version.startsWith("workspace:")) {
        // Resolve workspace package to file path
        const packagePath = path.join(workspaceRoot, "packages", pkg.split("/")[1] || pkg);
        resolved[pkg] = `file:${packagePath}`;
      } else {
        resolved[pkg] = version;
      }
    }

    return resolved;
  }

  private async installDependencies(
    panelPath: string,
    dependencies: Record<string, string> | undefined,
    previousHash?: string
  ): Promise<string | undefined> {
    if (!dependencies || Object.keys(dependencies).length === 0) {
      return undefined;
    }

    const runtimeDir = this.ensureRuntimeDir(panelPath);
    const packageJsonPath = path.join(runtimeDir, "package.json");

    // Resolve workspace:* to file: paths
    const resolvedDependencies = this.resolveWorkspaceDependencies(dependencies);

    type PanelRuntimePackageJson = {
      name: string;
      private: boolean;
      version: string;
      dependencies?: Record<string, string>;
    };

    const desiredPackageJson: PanelRuntimePackageJson = {
      name: "natstack-panel-runtime",
      private: true,
      version: "1.0.0",
      dependencies: resolvedDependencies,
    };
    const serialized = JSON.stringify(desiredPackageJson, null, 2);
    const desiredHash = crypto.createHash("sha256").update(serialized).digest("hex");

    const nodeModulesPath = path.join(runtimeDir, "node_modules");
    const packageLockPath = path.join(runtimeDir, "package-lock.json");

    if (previousHash === desiredHash && fs.existsSync(nodeModulesPath)) {
      const existingContent = fs.existsSync(packageJsonPath)
        ? fs.readFileSync(packageJsonPath, "utf-8")
        : null;
      if (existingContent !== serialized) {
        fs.writeFileSync(packageJsonPath, serialized);
      }
      return desiredHash;
    }

    fs.writeFileSync(packageJsonPath, serialized);

    if (fs.existsSync(nodeModulesPath)) {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    }
    if (fs.existsSync(packageLockPath)) {
      fs.rmSync(packageLockPath, { recursive: true, force: true });
    }

    const arborist = new Arborist({ path: runtimeDir });
    await arborist.buildIdealTree();
    await arborist.reify();

    return desiredHash;
  }

  async buildPanel(panelPath: string): Promise<PanelBuildResult> {
    try {
      // Resolve to absolute path
      const absolutePanelPath = path.resolve(panelPath);

      // Check if panel directory exists
      if (!fs.existsSync(absolutePanelPath)) {
        return {
          success: false,
          error: `Panel directory not found: ${panelPath}`,
        };
      }

      // Read manifest
      let manifest: PanelManifest;
      try {
        manifest = this.loadManifest(absolutePanelPath);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // Check cache
      const sourceHash = await this.hashDirectory(absolutePanelPath);
      const cached = this.cache.get(absolutePanelPath);

      console.log(`[PanelBuilder] Checking cache for ${panelPath}`);
      console.log(`  Current hash: ${sourceHash}`);
      console.log(`  Cached hash:  ${cached?.sourceHash || "none"}`);
      console.log(`  Match: ${cached?.sourceHash === sourceHash}`);

      if (
        cached &&
        cached.sourceHash === sourceHash &&
        fs.existsSync(cached.bundlePath) &&
        fs.existsSync(cached.htmlPath)
      ) {
        console.log(`Using cached build for ${panelPath}`);
        return {
          success: true,
          bundlePath: cached.bundlePath,
          htmlPath: cached.htmlPath,
        };
      }

      console.log(`Rebuilding panel ${panelPath} (cache miss or stale)`);

      const runtimeDependencies = this.mergeRuntimeDependencies(manifest.dependencies);

      const dependencyHash = await this.installDependencies(
        absolutePanelPath,
        runtimeDependencies,
        cached?.dependencyHash
      );

      // Determine entry point
      const entry = this.resolveEntryPoint(absolutePanelPath, manifest);
      const entryPath = path.join(absolutePanelPath, entry);

      const runtimeDir = this.ensureRuntimeDir(absolutePanelPath);
      const bundlePath = path.join(runtimeDir, "bundle.js");

      const nodePaths = this.getNodeResolutionPaths(absolutePanelPath);

      // Only keep fs virtual module plugin (natstack/* resolved via node_modules)
      const fsPlugin: esbuild.Plugin = {
        name: "fs-virtual-module",
        setup(build) {
          build.onResolve(
            { filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ },
            (args) => {
              const runtimePath = fsModuleMap.get(args.path);
              if (!runtimePath) return null;
              return { path: runtimePath };
            }
          );
        },
      };

      // Build with esbuild
      // We need to wrap the user's module and call auto-mount
      const tempEntryPath = path.join(runtimeDir, "_entry.js");
      const relativeUserEntry = path.relative(runtimeDir, entryPath);

      // Create a wrapper entry that imports user module and calls auto-mount
      const wrapperCode = `
import { autoMountReactPanel, shouldAutoMount } from "@natstack/panel";
import * as userModule from ${JSON.stringify(relativeUserEntry)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
      fs.writeFileSync(tempEntryPath, wrapperCode);

      await esbuild.build({
        entryPoints: [tempEntryPath],
        bundle: true,
        platform: "browser",
        target: "es2022",
        outfile: bundlePath,
        // Disable sourcemaps to avoid noisy ENOENT lookups for deps that ship maps without sources
        sourcemap: false,
        format: "esm",
        absWorkingDir: absolutePanelPath,
        nodePaths,
        plugins: [fsPlugin],
        // Mark packages that should be loaded from import map at runtime
        // isomorphic-git needs ESM version from esm.sh for Buffer polyfill
        external: ["isomorphic-git", "isomorphic-git/http/web"],
      });

      const htmlPath = this.resolveHtmlPath(absolutePanelPath, manifest.title);

      // Update cache
      const cacheEntry: PanelBuildCache = {
        path: absolutePanelPath,
        manifest,
        bundlePath,
        htmlPath,
        sourceHash,
        builtAt: Date.now(),
        dependencyHash,
        cacheVersion: PANEL_BUILD_CACHE_VERSION,
      };

      this.cache.set(absolutePanelPath, cacheEntry);
      this.saveCache();

      return {
        success: true,
        bundlePath,
        htmlPath,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getCachedBuild(panelPath: string): PanelBuildCache | undefined {
    const absolutePath = path.resolve(panelPath);
    return this.cache.get(absolutePath);
  }

  private mergeRuntimeDependencies(
    panelDependencies: Record<string, string> | undefined
  ): Record<string, string> {
    const merged = { ...defaultPanelDependencies };
    if (panelDependencies) {
      Object.assign(merged, panelDependencies);
    }
    return merged;
  }

  clearCache(panelPath?: string): void {
    if (panelPath) {
      const absolutePath = path.resolve(panelPath);
      this.cache.delete(absolutePath);
    } else {
      this.cache.clear();
    }
    this.saveCache();
  }
}
