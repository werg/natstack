import { execSync } from "child_process";

// Build TypeScript - outputs to dist/ with .js files and .d.ts type definitions
// React and react-dom are peerDependencies - they will be resolved by the panel build
// which uses createReactDedupePlugin to ensure a single React instance
console.log("Building @workspace/git-ui...");
execSync("tsc --project tsconfig.build.json", { stdio: "inherit" });

console.log("@workspace/git-ui build complete!");
