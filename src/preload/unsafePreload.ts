/**
 * Unsafe preload script for panels and workers with Node.js integration.
 *
 * Runs with nodeIntegration: true, contextIsolation: false, sandbox: false.
 * The kind (panel/worker) is determined by --natstack-kind argument.
 */

import { initUnsafePreload } from "./preloadUtils.js";

initUnsafePreload();
