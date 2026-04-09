/**
 * Photon image processing wrapper.
 *
 * Ported literally from @mariozechner/pi-coding-agent/src/utils/photon.ts.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that
 * runs server-side (Node.js). The photon-node CJS entry uses
 * `fs.readFileSync(__dirname + '/photon_rs_bg.wasm')` which works in plain
 * Node.js but bakes absolute paths into bundled binaries. The patch below
 * redirects missing wasm reads to fallback locations next to the executable
 * or in cwd, mirroring pi-coding-agent's logic so we keep behaviour parity
 * for the headless server build.
 *
 * NOTE: this file is server-only. workerd cannot import it.
 */
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

// In ESM this resolves via `import.meta.url`; in the CJS server-electron
// bundle esbuild stubs `import.meta` (it logs a warning), so `import.meta.url`
// is `undefined` and `createRequire(undefined)` throws ERR_INVALID_ARG_VALUE.
// Fall back to __filename when running in CJS.
declare const __filename: string | undefined;
const requireFromUrl: string =
  (typeof import.meta !== "undefined" && import.meta.url)
    ? import.meta.url
    : (typeof __filename !== "undefined" && __filename)
      ? pathToFileURL(__filename).href
      : pathToFileURL(process.cwd() + "/").href;

const require = createRequire(requireFromUrl);
const fs = require("fs") as typeof import("fs");

const WASM_FILENAME = "photon_rs_bg.wasm";

// Lazy-loaded photon module
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

function pathOrNull(file: unknown): string | null {
  if (typeof file === "string") {
    return file;
  }
  if (file instanceof URL) {
    return fileURLToPath(file);
  }
  return null;
}

function getFallbackWasmPaths(): string[] {
  const execDir = path.dirname(process.execPath);
  return [
    path.join(execDir, WASM_FILENAME),
    path.join(execDir, "photon", WASM_FILENAME),
    path.join(process.cwd(), WASM_FILENAME),
  ];
}

function patchPhotonWasmRead(): () => void {
  const originalReadFileSync = fs.readFileSync.bind(fs) as typeof fs.readFileSync;
  const fallbackPaths = getFallbackWasmPaths();
  const mutableFs = fs as { readFileSync: typeof fs.readFileSync };

  const patchedReadFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const [file, options] = args;
    const resolvedPath = pathOrNull(file);
    if (resolvedPath?.endsWith(WASM_FILENAME)) {
      try {
        return originalReadFileSync(...args);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code && err.code !== "ENOENT") {
          throw error;
        }
        for (const fallbackPath of fallbackPaths) {
          if (!fs.existsSync(fallbackPath)) {
            continue;
          }
          if (options === undefined) {
            return originalReadFileSync(fallbackPath);
          }
          return originalReadFileSync(fallbackPath, options);
        }
        throw error;
      }
    }
    return originalReadFileSync(...args);
  }) as typeof fs.readFileSync;

  try {
    mutableFs.readFileSync = patchedReadFileSync;
  } catch {
    Object.defineProperty(fs, "readFileSync", {
      value: patchedReadFileSync,
      writable: true,
      configurable: true,
    });
  }

  return () => {
    try {
      mutableFs.readFileSync = originalReadFileSync;
    } catch {
      Object.defineProperty(fs, "readFileSync", {
        value: originalReadFileSync,
        writable: true,
        configurable: true,
      });
    }
  };
}

/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
  if (photonModule) {
    return photonModule;
  }
  if (loadPromise) {
    return loadPromise;
  }
  loadPromise = (async () => {
    const restoreReadFileSync = patchPhotonWasmRead();
    try {
      photonModule = await import("@silvia-odwyer/photon-node");
      return photonModule;
    } catch {
      photonModule = null;
      return photonModule;
    } finally {
      restoreReadFileSync();
    }
  })();
  return loadPromise;
}
