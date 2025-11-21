import * as esbuild from "esbuild";
import * as fs from "fs";

const isDev = process.env.NODE_ENV === "development";

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
};

const panelRuntimeConfig = {
  entryPoints: ["src/panelRuntime/panelApi.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/panelRuntime.js",
  sourcemap: isDev,
  minify: !isDev,
};

const panelReactRuntimeConfig = {
  entryPoints: ["src/panelRuntime/reactPanel.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/panelReactRuntime.js",
  sourcemap: isDev,
  minify: !isDev,
};

const panelFsRuntimeConfig = {
  entryPoints: ["src/panelRuntime/panelFsRuntime.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/panelFsRuntime.js",
  sourcemap: isDev,
  minify: !isDev,
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
};

const rendererConfig = {
  entryPoints: ["src/renderer/index.tsx"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  outfile: "dist/renderer.js",
  sourcemap: isDev,
  minify: !isDev,
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

async function build() {
  let contexts = [];

  try {
  fs.mkdirSync("dist", { recursive: true });
    await esbuild.build(mainConfig);
    await esbuild.build(preloadConfig);
    await esbuild.build(panelPreloadConfig);
    await esbuild.build(panelRuntimeConfig);
    await esbuild.build(panelReactRuntimeConfig);
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
