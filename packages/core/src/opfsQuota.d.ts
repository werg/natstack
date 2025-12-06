/**
 * OPFS (Origin Private File System) quota management utilities
 *
 * Provides quota checking, logging, and management to prevent exhausting
 * browser storage limits during git clones and panel builds.
 */
export interface QuotaInfo {
    /** Bytes currently used */
    used: number;
    /** Total bytes available (quota) */
    quota: number;
    /** Available bytes remaining */
    available: number;
    /** Usage as a percentage (0-100) */
    usagePercent: number;
}
/**
 * Check current OPFS quota and usage
 */
export declare function checkQuota(): Promise<QuotaInfo>;
/**
 * Format bytes as human-readable string
 */
export declare function formatBytes(bytes: number): string;
/**
 * Log current quota info to console
 */
export declare function logQuotaInfo(): Promise<void>;
/**
 * Ensure sufficient space is available before an operation
 * @param requiredBytes - Bytes needed for the operation
 * @throws Error if insufficient space
 */
export declare function ensureSpace(requiredBytes: number): Promise<void>;
/**
 * Estimated size of a typical git clone operation
 * Used as a conservative estimate when exact size isn't known
 */
export declare const ESTIMATED_CLONE_SIZE: number;
/**
 * Estimated size of a typical panel build operation
 */
export declare const ESTIMATED_BUILD_SIZE: number;
//# sourceMappingURL=opfsQuota.d.ts.map