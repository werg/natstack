/**
 * Built-in Worker Builder
 *
 * Builds built-in workers (shipped with the app) for safe mode (OPFS).
 * Built-in workers only run in safe mode - they don't have Node.js access.
 *
 * Currently includes:
 * - template-builder: Clones template repositories to OPFS
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { getPackagesDir, getCentralConfigDirectory, getAppNodeModules, getAppRoot, getPrebuiltBuiltinWorkersDir } from "./paths.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("BuiltinWorkerBuilder");
import {
  generateAsyncTrackingBanner,
  generateModuleMapBanner,
} from "./panelBuilder.js";
import {
  isFsModule,
  isFsPromisesModule,
  generateFsShimCode,
  isPathModule,
  generatePathShimCode,
} from "@natstack/runtime/typecheck";

const BUILTIN_WORKERS = ["template-builder"] as const;
type BuiltinWorker = (typeof BUILTIN_WORKERS)[number];

// In-memory cache for built workers
const builtinWorkerBundles = new Map<BuiltinWorker, string>();

function createFsShimPlugin(resolveDir: string): esbuild.Plugin {
  return {
    name: "builtin-worker-fs-shim",
    setup(build) {
      build.onResolve({ filter: /^(fs|node:fs|fs\/promises|node:fs\/promises)$/ }, (args) => {
        if (!isFsModule(args.path)) return null;
        return { path: args.path, namespace: "builtin-worker-fs-shim" };
      });

      build.onLoad({ filter: /.*/, namespace: "builtin-worker-fs-shim" }, (args) => {
        const isPromises = isFsPromisesModule(args.path);
        const contents = generateFsShimCode(isPromises);
        return { contents, loader: "js", resolveDir };
      });
    },
  };
}

function createPathShimPlugin(resolveDir: string): esbuild.Plugin {
  return {
    name: "builtin-worker-path-shim",
    setup(build) {
      build.onResolve({ filter: /^(path|node:path|path\/posix|node:path\/posix)$/ }, (args) => {
        if (!isPathModule(args.path)) return null;
        return { path: args.path, namespace: "builtin-worker-path-shim" };
      });

      build.onLoad({ filter: /.*/, namespace: "builtin-worker-path-shim" }, () => {
        const contents = generatePathShimCode();
        return { contents, loader: "js", resolveDir };
      });
    },
  };
}

/**
 * Get the directory containing built-in workers.
 * In development: src/builtin-workers/
 * In production: dist/builtin-workers/ (inside app.asar)
 */
function getBuiltinWorkersDir(): string {
  const appRoot = getAppRoot();

  // Try source path first (development)
  const srcPath = path.join(appRoot, "src", "builtin-workers");
  if (fs.existsSync(srcPath)) {
    return srcPath;
  }

  // Try dist path (production build)
  const distPath = path.join(appRoot, "dist", "builtin-workers");
  if (fs.existsSync(distPath)) {
    return distPath;
  }

  throw new Error(`Built-in workers directory not found. Tried: ${srcPath}, ${distPath}`);
}

/**
 * Try to load a pre-built worker from the app resources.
 * Returns null if the worker is not pre-built (needs runtime compilation).
 */
function tryLoadPrebuiltWorker(worker: BuiltinWorker): string | null {
  const prebuiltDir = getPrebuiltBuiltinWorkersDir();
  if (!prebuiltDir) {
    // Development mode or prebuilt workers not available
    return null;
  }

  const workerDir = path.join(prebuiltDir, worker);
  const bundlePath = path.join(workerDir, "bundle.js");

  if (!fs.existsSync(bundlePath)) {
    return null;
  }

  try {
    const bundle = fs.readFileSync(bundlePath, "utf-8");
    console.log(`[BuiltinWorkerBuilder] Loaded prebuilt worker: ${worker}`);
    return bundle;
  } catch (error) {
    console.warn(
      `[BuiltinWorkerBuilder] Failed to load prebuilt worker ${worker}:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * Build a built-in worker for safe mode (OPFS).
 * Built-in workers only run in safe mode.
 * In production, tries to load pre-built workers first.
 */
export async function buildBuiltinWorker(worker: BuiltinWorker): Promise<string> {
  const cached = builtinWorkerBundles.get(worker);
  if (cached) {
    log.verbose(` Using cached bundle for ${worker}`);
    return cached;
  }

  // Try to load prebuilt worker first (production builds)
  const prebuilt = tryLoadPrebuiltWorker(worker);
  if (prebuilt) {
    builtinWorkerBundles.set(worker, prebuilt);
    return prebuilt;
  }

  // Fall back to runtime build
  log.verbose(` Building ${worker}...`);

  const workersDir = getBuiltinWorkersDir();
  const workerDir = path.join(workersDir, worker);

  if (!fs.existsSync(workerDir)) {
    throw new Error(`Built-in worker directory not found: ${workerDir}`);
  }

  const entryFile = ["index.ts", "index.tsx", "index.js"].find(f =>
    fs.existsSync(path.join(workerDir, f))
  );
  if (!entryFile) {
    throw new Error(`No entry point found for built-in worker: ${worker}`);
  }

  const entryPath = path.join(workerDir, entryFile);
  const packagesDir = getPackagesDir();

  if (!packagesDir) {
    throw new Error("Cannot build built-in worker: packages/ directory not found");
  }

  const outdir = path.join(getCentralConfigDirectory(), "builtin-worker-cache", worker);
  fs.mkdirSync(outdir, { recursive: true });
  const bundlePath = path.join(outdir, "bundle.js");

  const bannerJs = [
    generateAsyncTrackingBanner(),
    generateModuleMapBanner(),
  ].join("\n");

  // Always build for safe mode (browser platform, ESM)
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "browser",
    target: "es2022",
    conditions: ["natstack-panel"],
    outfile: bundlePath,
    sourcemap: "inline",
    keepNames: true,
    format: "esm",
    absWorkingDir: workerDir,
    nodePaths: [getAppNodeModules(), packagesDir],
    plugins: [
      createFsShimPlugin(packagesDir),
      // Path shim uses appRoot so it can resolve 'pathe' from node_modules
      createPathShimPlugin(getAppRoot()),
    ],
    banner: { js: bannerJs },
    tsconfigRaw: "{}", // Intentional: disable tsconfig paths so natstack-panel condition works
  });

  const bundle = fs.readFileSync(bundlePath, "utf-8");

  try {
    fs.rmSync(outdir, { recursive: true, force: true });
  } catch { /* best effort */ }

  builtinWorkerBundles.set(worker, bundle);
  log.verbose(` Built ${worker} (${bundle.length} bytes)`);

  return bundle;
}

/**
 * Check if a worker name is a built-in worker.
 */
export function isBuiltinWorker(name: string): name is BuiltinWorker {
  return (BUILTIN_WORKERS as readonly string[]).includes(name);
}

/**
 * Clear the built-in worker cache.
 * Useful for development when worker code changes.
 */
export function clearBuiltinWorkerCache(): void {
  builtinWorkerBundles.clear();
  console.log("[BuiltinWorkerBuilder] Cache cleared");
}
