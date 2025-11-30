import "./panelFsRuntime.js";
import * as zenfsPromises from "@zenfs/core/promises";

// Re-export named members
export * from "@zenfs/core/promises";
// Provide a default export to mirror Node's fs/promises default import pattern.
export default zenfsPromises;
