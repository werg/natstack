import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });

// Bundle JS for the host entry and the forked-child runtime entry. Runtime JS
// must not resolve @natstack/shared directly: shared is a source-only package
// whose exports point at .ts files with NodeNext-style .js specifiers.
await esbuild.build({
  entryPoints: ["src/index.ts", "src/childRuntime.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  external: ["@natstack/extension", "@natstack/process-adapter", "yaml"],
});

// Emit real .d.ts files alongside the bundled JS. Use the project's
// tsconfig.build.json with --emitDeclarationOnly so tsc doesn't double-write
// the JavaScript that esbuild already produced.
const tscBin = require.resolve("typescript/lib/tsc.js");
execFileSync(
  process.execPath,
  [tscBin, "--project", "tsconfig.build.json", "--emitDeclarationOnly"],
  { stdio: "inherit", cwd: path.dirname(new URL(import.meta.url).pathname) }
);
