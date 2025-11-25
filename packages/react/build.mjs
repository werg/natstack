import * as esbuild from "esbuild";
import { execSync } from "child_process";

// First build TypeScript for type definitions
console.log("Building TypeScript types...");
execSync("tsc --project tsconfig.build.json", { stdio: "inherit" });

// Then bundle everything together for browser use
console.log("Bundling @natstack/react for browser...");
await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/bundle.js",
  sourcemap: true,
  // Bundle React, react-dom, and Radix together
  // Don't externalize anything - create a complete bundle
  external: [],
});

console.log("@natstack/react build complete!");
