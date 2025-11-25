import * as esbuild from "esbuild";
import typiaPlugin from "@ryoppippi/unplugin-typia/esbuild";
import * as fs from "fs";
import { execSync } from "child_process";

const isDev = process.env.NODE_ENV === "development";

const typiaPlugins = [
  typiaPlugin({
    tsconfig: "tsconfig.json",
    cache: true,
    log: false,
  }),
];

const logOverride = {
  "suspicious-logical-operator": "silent",
};

const mainConfig = {
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron", "esbuild", "@npmcli/arborist"],
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

const preloadConfig = {
  entryPoints: ["src/preload/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/preload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

const panelPreloadConfig = {
  entryPoints: ["src/preload/panelPreload.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/panelPreload.cjs",
  external: ["electron"],
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

// Keep only fs runtime configs (these remain as virtual modules for now)
const panelFsRuntimeConfig = {
  entryPoints: ["src/panelRuntime/panelFsRuntime.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/panelFsRuntime.js",
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

const panelFsPromisesRuntimeConfig = {
  entryPoints: ["src/panelRuntime/panelFsPromisesRuntime.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/panelFsPromisesRuntime.js",
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
};

const rendererConfig = {
  entryPoints: ["src/renderer/index.tsx"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  outfile: "dist/renderer.js",
  sourcemap: isDev,
  minify: !isDev,
  plugins: typiaPlugins,
  logOverride,
  loader: {
    ".html": "text",
    ".css": "css",
  },
};

function copyAssets() {
  fs.copyFileSync("src/renderer/index.html", "dist/index.html");
  // Copy panel runtime type definitions
  fs.copyFileSync("src/panelRuntime/globals.d.ts", "dist/panelRuntimeGlobals.d.ts");
}

async function buildWorkspacePackages() {
  console.log("Building workspace packages...");
  try {
    execSync('pnpm --filter "@natstack/*" build', { stdio: 'inherit' });
    console.log("Workspace packages built successfully!");
  } catch (error) {
    console.error("Failed to build workspace packages:", error);
    throw error;
  }
}

async function build() {
  let contexts = [];

  try {
    fs.mkdirSync("dist", { recursive: true });

    // Build workspace packages first
    await buildWorkspacePackages();

    // Build main app
    await esbuild.build(mainConfig);
    await esbuild.build(preloadConfig);
    await esbuild.build(panelPreloadConfig);
    await esbuild.build(panelFsRuntimeConfig);
    await esbuild.build(panelFsPromisesRuntimeConfig);
    await esbuild.build(rendererConfig);

    copyAssets();
    console.log("Build successful!");
  } catch (error) {
    console.error("Build failed:", error);
    // Cleanup contexts on error
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    process.exit(1);
  }
}

build();
