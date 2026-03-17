/**
 * Shared filesystem utilities for panels and workers.
 */
import type { FileStats } from "../types.js";
/**
 * Convert any stat-like object to our FileStats interface.
 * Captures boolean values at creation time so they can be returned as methods.
 * Preserves `mode` for isomorphic-git compatibility.
 */
export declare function toFileStats(stats: unknown): FileStats;
//# sourceMappingURL=fs-utils.d.ts.map