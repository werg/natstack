// Bundle the headless host with esbuild: workspace packages (@natstack/*)
// are TS-source exports, so they get bundled; real npm deps stay external.
import * as esbuild from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  external: ["ws", "@puppeteer/browsers", "zod"],
  banner: {
    // Some transitive CJS deps probe require(); provide it under ESM output.
    js: "import { createRequire as __natstackCreateRequire } from 'node:module'; const require = __natstackCreateRequire(import.meta.url);",
  },
};

await esbuild.build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
});

await esbuild.build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

console.log("headless-host build complete");
