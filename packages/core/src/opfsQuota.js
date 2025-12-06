/**
 * OPFS (Origin Private File System) quota management utilities
 *
 * Provides quota checking, logging, and management to prevent exhausting
 * browser storage limits during git clones and panel builds.
 */
/**
 * Check current OPFS quota and usage
 */
export async function checkQuota() {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
        // Not in a browser environment or storage API not supported
        return {
            used: 0,
            quota: 0,
            available: 0,
            usagePercent: 0,
        };
    }
    const estimate = await navigator.storage.estimate();
    const used = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    const available = quota - used;
    const usagePercent = quota > 0 ? (used / quota) * 100 : 0;
    return {
        used,
        quota,
        available,
        usagePercent,
    };
}
/**
 * Format bytes as human-readable string
 */
export function formatBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
/**
 * Log current quota info to console
 */
export async function logQuotaInfo() {
    const info = await checkQuota();
    if (info.quota === 0) {
        console.log('[OPFS] Storage quota API not available');
        return;
    }
    console.log('[OPFS] Storage quota:');
    console.log(`  Used: ${formatBytes(info.used)} (${info.usagePercent.toFixed(1)}%)`);
    console.log(`  Available: ${formatBytes(info.available)}`);
    console.log(`  Total: ${formatBytes(info.quota)}`);
    // Warn if usage is high
    if (info.usagePercent > 90) {
        console.warn(`[OPFS] WARNING: Storage usage is at ${info.usagePercent.toFixed(1)}%!`);
    }
    else if (info.usagePercent > 75) {
        console.warn(`[OPFS] CAUTION: Storage usage is at ${info.usagePercent.toFixed(1)}%`);
    }
}
/**
 * Ensure sufficient space is available before an operation
 * @param requiredBytes - Bytes needed for the operation
 * @throws Error if insufficient space
 */
export async function ensureSpace(requiredBytes) {
    const info = await checkQuota();
    if (info.quota === 0) {
        // Quota API not available - can't check, proceed with caution
        return;
    }
    if (info.available < requiredBytes) {
        throw new Error(`Insufficient OPFS space: need ${formatBytes(requiredBytes)}, ` +
            `have ${formatBytes(info.available)} available`);
    }
    // Also warn if this operation would push us over 90%
    const afterUsage = info.used + requiredBytes;
    const afterPercent = (afterUsage / info.quota) * 100;
    if (afterPercent > 90) {
        console.warn(`[OPFS] Operation will use ${formatBytes(requiredBytes)}, ` +
            `bringing total usage to ${afterPercent.toFixed(1)}%`);
    }
}
/**
 * Estimated size of a typical git clone operation
 * Used as a conservative estimate when exact size isn't known
 */
export const ESTIMATED_CLONE_SIZE = 50 * 1024 * 1024; // 50MB
/**
 * Estimated size of a typical panel build operation
 */
export const ESTIMATED_BUILD_SIZE = 10 * 1024 * 1024; // 10MB
//# sourceMappingURL=opfsQuota.js.map