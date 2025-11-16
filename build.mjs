import * as esbuild from "esbuild";
import * as fs from "fs";

const isDev = process.env.NODE_ENV === "development";
const isWatch = process.argv.includes("--watch");

const mainConfig = {
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron"],
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
}

async function build() {
  try {
    fs.mkdirSync("dist", { recursive: true });

    if (isWatch) {
      const contexts = await Promise.all([
        esbuild.context(mainConfig),
        esbuild.context(preloadConfig),
        esbuild.context(rendererConfig),
      ]);

      await Promise.all(contexts.map((ctx) => ctx.watch()));

      copyAssets();
      console.log("Watching for changes...");
    } else {
      await esbuild.build(mainConfig);
      await esbuild.build(preloadConfig);
      await esbuild.build(rendererConfig);

      copyAssets();
      console.log("Build successful!");
    }
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
