/**
 * Safe preload script for panels and workers with context isolation.
 *
 * Runs with nodeIntegration: false, contextIsolation: true, sandbox: true.
 * The kind (panel/worker) is determined by --natstack-kind argument.
 */

import { contextBridge } from "electron";
import { initSafePreload } from "./preloadUtils.js";

initSafePreload(contextBridge);
