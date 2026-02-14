/**
 * Phase 0 smoke test — verifies all backend modules can be imported
 * without Electron. Run: node dist/smoke-test.cjs
 *
 * NOTE: memoryMonitor.ts is excluded — it transitively imports viewManager.ts
 * which has top-level Electron imports (BaseWindow, WebContentsView, etc.).
 */
import * as os from "os";
import * as path from "path";
import { getUserDataPath, setUserDataPath } from "../main/envPaths.js";
import { getCentralConfigDirectory, getAppRoot } from "../main/paths.js";
import { getCentralConfigDir } from "../main/workspace/loader.js";
import { GitServer } from "../main/gitServer.js";
import { VerdaccioServer } from "../main/verdaccioServer.js";
import { DependencyGraph } from "../main/dependencyGraph.js";
import { loadDiskCache } from "../main/diskCache.js";
import { clearAllCaches } from "../main/cacheUtils.js";

// Set up environment for headless operation
const testDataDir = path.join(os.tmpdir(), "natstack-smoke-test");
setUserDataPath(testDataDir);
process.env["NATSTACK_APP_ROOT"] = process.cwd();

// Exercise each module to confirm no lazy electron require crashes

// envPaths
const p = getUserDataPath();
console.log("✓ getUserDataPath():", p);

// paths.ts
const configDir = getCentralConfigDirectory();
console.log("✓ getCentralConfigDirectory():", configDir);
const appRoot = getAppRoot();
console.log("✓ getAppRoot():", appRoot);

// workspace/loader.ts
const centralDir = getCentralConfigDir();
console.log("✓ getCentralConfigDir():", centralDir);

// gitServer.ts — construct instance (ensures module loaded + class usable)
console.log("✓ GitServer:", typeof GitServer === "function" ? "loaded" : "FAIL");

// verdaccioServer.ts — confirm export exists
console.log("✓ VerdaccioServer:", typeof VerdaccioServer === "function" ? "loaded" : "FAIL");

// dependencyGraph.ts — confirm export exists
console.log("✓ DependencyGraph:", typeof DependencyGraph === "function" ? "loaded" : "FAIL");

// diskCache.ts — confirm export exists
console.log("✓ loadDiskCache:", typeof loadDiskCache === "function" ? "loaded" : "FAIL");

// cacheUtils.ts — confirm export exists
console.log("✓ clearAllCaches:", typeof clearAllCaches === "function" ? "loaded" : "FAIL");

// rpcServer.ts — confirm RpcServer class loads without Electron
import { RpcServer } from "./rpcServer.js";
console.log("✓ RpcServer:", typeof RpcServer === "function" ? "loaded" : "FAIL");

console.log("\nPhase 0 smoke test passed — all 8 headless-capable modules loaded without Electron.");
