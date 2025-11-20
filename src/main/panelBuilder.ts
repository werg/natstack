import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import Arborist from "@npmcli/arborist";
import type { PanelManifest, PanelBuildResult, PanelBuildCache } from "./panelTypes.js";

const CACHE_FILENAME = "build-cache.json";
const PANEL_RUNTIME_DIRNAME = ".natstack";

const panelApiModulePath = path.join(__dirname, "panelRuntime.js");
const panelReactModulePath = path.join(__dirname, "panelReactRuntime.js");
const runtimeModuleMap = new Map([
  ["natstack/panel", panelApiModulePath],
  ["natstack/react", panelReactModulePath],
]);

for (const [name, modulePath] of runtimeModuleMap) {
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Runtime module ${name} not found at ${modulePath}`);
  }
}

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
        this.cache = new Map(cacheArray.map((item) => [item.path, item]));
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
      if (file.includes("node_modules") || file.includes("dist") || file.includes(PANEL_RUNTIME_DIRNAME)) {
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
    const defaultHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
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
    const manifestPath = path.join(absolutePanelPath, "panel.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`panel.json not found in ${panelPath}`);
    }

    const manifestContent = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestContent) as PanelManifest;

    if (!manifest.title) {
      throw new Error("panel.json must include a 'title' field");
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

    const defaultCandidates = ["index.tsx", "index.ts", "index.jsx", "index.js", "main.tsx", "main.ts"];
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
      dependencies,
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
      console.log(`  Cached hash:  ${cached?.sourceHash || 'none'}`);
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

      const dependencyHash = await this.installDependencies(
        absolutePanelPath,
        manifest.dependencies,
        cached?.dependencyHash
      );

      // Determine entry point
      const entry = this.resolveEntryPoint(absolutePanelPath, manifest);
      const entryPath = path.join(absolutePanelPath, entry);

      const runtimeDir = this.ensureRuntimeDir(absolutePanelPath);
      const bundlePath = path.join(runtimeDir, "bundle.js");

      const nodePaths = this.getNodeResolutionPaths(absolutePanelPath);

      const panelApiPlugin: esbuild.Plugin = {
        name: "panel-api-module",
        setup(build) {
          build.onResolve({ filter: /^natstack\/(panel|react)$/ }, (args) => {
            const runtimePath = runtimeModuleMap.get(args.path);
            if (!runtimePath) return null;
            return { path: runtimePath };
          });
        },
      };

      // Build with esbuild
      await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: "browser",
        target: "es2020",
        outfile: bundlePath,
        sourcemap: true,
        format: "esm",
        absWorkingDir: absolutePanelPath,
        nodePaths,
        plugins: [panelApiPlugin],
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
