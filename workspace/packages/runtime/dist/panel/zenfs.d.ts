/**
 * ZenFS provider for panels with immediate initialization.
 *
 * Initialization starts on module load (not lazy). The `fsReady` promise
 * can be awaited if you need to know when initialization is complete,
 * but each fs method also awaits it internally.
 */
import type { RuntimeFs } from "../types.js";
/**
 * Promise that resolves when ZenFS is initialized.
 * Initialization starts immediately on module load.
 */
export declare const fsReady: Promise<void>;
/**
 * RuntimeFs implementation backed by ZenFS.
 * Each method awaits fsReady internally, so callers don't need to wait.
 */
export declare const fs: RuntimeFs;
//# sourceMappingURL=zenfs.d.ts.map