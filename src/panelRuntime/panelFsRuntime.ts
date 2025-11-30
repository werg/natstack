import { configureSingle, fs, promises } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";

const configureOpfsBackend = async (): Promise<void> => {
  if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
    throw new Error(
      "[NatStack] OPFS is unavailable in this browser. " +
        "The filesystem API requires OPFS support. " +
        "Please use a modern browser with OPFS enabled (Chrome 102+, Edge 102+, Safari 15.2+)."
    );
  }

  const handle = await navigator.storage.getDirectory();
  await configureSingle({ backend: WebAccess, handle });
};

const ready = (async () => {
  try {
    await configureOpfsBackend();
  } catch (error) {
    console.error("[NatStack] Failed to configure ZenFS WebAccess backend for OPFS", error);
    throw error;
  }
})();

// Timeout protection for initialization
const INIT_TIMEOUT_MS = 10000; // 10 seconds
const timeoutPromise = new Promise<never>((_, reject) => {
  setTimeout(() => {
    reject(
      new Error(
        `[NatStack] Filesystem initialization timed out after ${INIT_TIMEOUT_MS}ms. ` +
          "This may indicate a browser compatibility issue or OPFS access problem."
      )
    );
  }, INIT_TIMEOUT_MS);
});

await Promise.race([ready, timeoutPromise]);

export { fs, ready };
export { promises };
// Default export for `import fs from "fs"`
export default fs;
// Also mirror the Node pattern where `fs/promises` can be default-imported
// by panels bundling to CJS-like syntax and expecting a default object.
export const promisesDefault = promises;
