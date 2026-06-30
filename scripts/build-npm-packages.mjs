#!/usr/bin/env node
// Stage the two publishable npm packages from a completed `pnpm build`:
//
//   dist-packages/server  → @natstack/server  (slim headless server, no electron)
//   dist-packages/app     → @natstack/app     (full Electron desktop app)
//
// The monorepo root stays private; this script synthesizes each package.json and
// assembles its file tree. Workspace (@natstack/* + @workspace/*) packages are
// not on npm, so they are vendored: the server bundle already inlines all of
// them except @natstack/extension-host, which is vendored via a self-contained
// publish build (so it resolves on any Node >=20 with no workspace:* / .ts at
// runtime); the app vendors the whole workspace graph.
//
// Run AFTER `pnpm build`:  node scripts/build-npm-packages.mjs
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outRoot = path.join(repoRoot, "dist-packages");
const rootPkg = readJson(path.join(repoRoot, "package.json"));
const VERSION = rootPkg.version;

// Host-provided build deps that live in root devDependencies (browser polyfills
// and alternative panel compilers) — needed to build the default template's
// panels/workers at runtime.
const HOST_BUILD_DEV_DEPS = ["buffer", "sql.js", "svelte", "esbuild-svelte"];

// Runtime/build deps not present in root.dependencies: the headless-host Chromium
// downloader, and react-devtools-core (pulled by `ink`, which the terminal
// workers bundle — hoisted via react-native in the dev monorepo). The npm CLI,
// esbuild, workerd, ws, zod, arborist, pi-ai are already root dependencies and
// come in via the root.dependencies mirror.
const SERVER_EXTRA_DEPS = ["@puppeteer/browsers", "react-devtools-core"];

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  console.log(`Staging npm packages @ v${VERSION}`);
  assertBuilt();
  buildSelfContainedExtensionHost();
  rmrf(outRoot);
  stageServer();
  stageApp();
  console.log("\n✔ Staged dist-packages/{server,app}. Validate with:");
  console.log("    (cd dist-packages/server && npm publish --dry-run)");
  console.log("    (cd dist-packages/app && npm publish --dry-run)");
}

function assertBuilt() {
  const required = ["dist/server.mjs", "dist/main.cjs", "dist/cli/client.mjs"];
  const missing = required.filter((p) => !fs.existsSync(path.join(repoRoot, p)));
  if (missing.length) {
    throw new Error(`Run \`pnpm build\` first — missing: ${missing.join(", ")}`);
  }
}

function buildSelfContainedExtensionHost() {
  console.log("• Building self-contained @natstack/extension-host (publish)…");
  execFileSync("pnpm", ["--filter", "@natstack/extension-host", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, NATSTACK_EXTHOST_PUBLISH: "1" },
  });
}

// ---------------------------------------------------------------------------
// @natstack/server
// ---------------------------------------------------------------------------
function stageServer() {
  const root = path.join(outRoot, "server");
  console.log("• Staging @natstack/server…");
  mkdirp(root);

  // Server runtime files (see paths.ts / internalDoLoader.ts / headlessHostManager.ts).
  copyFile("dist/server.mjs", path.join(root, "dist/server.mjs"));
  copyFile("dist/internal-do.bundle.mjs", path.join(root, "dist/internal-do.bundle.mjs"));
  copyTree(path.join(repoRoot, "dist/cli"), path.join(root, "dist/cli"), defaultSkip);
  copyTree(path.join(repoRoot, "dist/headless-host"), path.join(root, "dist/headless-host"), defaultSkip);

  // First-run workspace template (runtimePaths.ts: appRoot/workspace-template).
  stageWorkspaceTemplate(path.join(root, "workspace-template"));

  // Bin shims.
  copyFile("scripts/natstack-launcher.mjs", path.join(root, "scripts/natstack-launcher.mjs"));
  copyFile("scripts/natstack-server-shim.mjs", path.join(root, "scripts/natstack-server-shim.mjs"));

  // Vendor the host's @natstack/* packages into node_modules. The runtime build
  // system seeds esbuild nodePaths from the app's node_modules
  // (getExistingAppNodeModulesRoots → builder.ts initBuilder), so panel/worker
  // builds resolve the @natstack API surface from here even though the host
  // bundles inline @natstack for their own code. extension-host ships
  // self-contained; @workspace/* are NOT host deps (workspace's own build).
  const natstackDeps = vendorNatstackPackages(root);
  vendorExtensionHost(root);
  const bundled = { ...natstackDeps, "@natstack/extension-host": VERSION };

  writeJson(path.join(root, "package.json"), {
    name: "@natstack/server",
    version: VERSION,
    description: "NatStack headless server (build, git, channels, AI, agents) over WebSocket RPC.",
    type: "module",
    license: rootPkg.license ?? "MIT",
    bin: {
      "natstack-server": "scripts/natstack-server-shim.mjs",
      natstack: "scripts/natstack-launcher.mjs",
    },
    engines: { node: ">=20" },
    files: ["dist", "workspace-template", "scripts"],
    // Full host build-dependency surface (app minus electron). Bundled @natstack
    // packages are in both dependencies and bundledDependencies so npm packs them.
    dependencies: computeHostDependencies(bundled, { electron: false }),
    bundledDependencies: Object.keys(bundled).sort(),
    publishConfig: { access: "public" },
  });
}

// ---------------------------------------------------------------------------
// @natstack/app
// ---------------------------------------------------------------------------
function stageApp() {
  const root = path.join(outRoot, "app");
  console.log("• Staging @natstack/app…");
  mkdirp(root);

  // Full host build (main + all preloads + server-electron + cli + headless-host).
  copyTree(path.join(repoRoot, "dist"), path.join(root, "dist"), defaultSkip);

  // The app runs unpackaged: it reads appRoot/workspace as the first-run template.
  stageWorkspaceTemplate(path.join(root, "workspace"));

  copyFile("scripts/natstack-launcher.mjs", path.join(root, "scripts/natstack-launcher.mjs"));
  copyFile("scripts/natstack-server-shim.mjs", path.join(root, "scripts/natstack-server-shim.mjs"));
  copyFile("scripts/branded-electron.mjs", path.join(root, "scripts/branded-electron.mjs"));
  if (fs.existsSync(path.join(repoRoot, "build-resources"))) {
    copyTree(path.join(repoRoot, "build-resources"), path.join(root, "build-resources"), defaultSkip);
  }

  // Vendor the host's @natstack/* packages into node_modules for the runtime
  // build system (same mechanism as the server). The managed workspace's
  // @workspace/* packages are NOT host deps — they have their own build system
  // and ship only as first-run template content under workspace/ (above).
  const natstackDeps = vendorNatstackPackages(root);
  vendorExtensionHost(root);
  const bundled = { ...natstackDeps, "@natstack/extension-host": VERSION };
  const dependencies = computeHostDependencies(bundled, { electron: true });

  writeJson(path.join(root, "package.json"), {
    name: "@natstack/app",
    version: VERSION,
    productName: rootPkg.productName ?? "NatStack",
    description: rootPkg.description,
    type: "module",
    license: rootPkg.license ?? "MIT",
    main: "dist/main.cjs",
    bin: {
      natstack: "scripts/natstack-launcher.mjs",
      "natstack-server": "scripts/natstack-server-shim.mjs",
    },
    engines: { node: ">=20" },
    files: ["dist", "workspace", "scripts", "build-resources"],
    dependencies,
    bundledDependencies: Object.keys(bundled).sort(),
    publishConfig: { access: "public" },
  });
}

// ---------------------------------------------------------------------------
// Vendoring
// ---------------------------------------------------------------------------
function vendorExtensionHost(pkgRoot) {
  const distPublish = path.join(repoRoot, "packages/extension-host/dist-publish");
  if (!fs.existsSync(distPublish)) {
    throw new Error("extension-host dist-publish/ missing — self-contained build did not run");
  }
  const dest = path.join(pkgRoot, "node_modules/@natstack/extension-host");
  rmrf(dest);
  copyTree(distPublish, path.join(dest, "dist"), () => false);
  writeJson(path.join(dest, "package.json"), {
    name: "@natstack/extension-host",
    version: VERSION,
    type: "module",
    main: "./dist/index.js",
    exports: {
      ".": { default: "./dist/index.js" },
      "./child-runtime": { default: "./dist/childRuntime.js" },
    },
  });
}

// Vendor the host's own @natstack/* packages (from packages/) into the staged
// package's node_modules, so the runtime build system resolves the @natstack API
// surface that panels/workers import. Returns { name: version }. Excludes
// extension-host (vendored self-contained). @workspace/* are intentionally NOT
// vendored — they belong to the managed workspace's own build system.
function vendorNatstackPackages(pkgRoot) {
  const vendored = {};
  const packagesDir = path.join(repoRoot, "packages");
  for (const entry of fs.readdirSync(packagesDir)) {
    const manifest = path.join(packagesDir, entry, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const name = readJson(manifest).name;
    if (!name || !name.startsWith("@natstack/")) continue;
    if (name === "@natstack/extension-host") continue; // self-contained, vendored separately
    const base = name.slice("@natstack/".length);
    const dest = path.join(pkgRoot, "node_modules", "@natstack", base);
    copyTree(path.join(packagesDir, entry), dest, defaultSkip);
    vendored[name] = normalizeVendoredManifest(path.join(dest, "package.json"));
  }
  return vendored;
}

// Normalize a vendored @natstack manifest. Critically, KEEP its workspace:*
// specifiers for inter-@natstack/@workspace deps: the runtime build system skips
// workspace:* deps from its registry `npm install` and resolves them from the
// app's node_modules (externalDeps.ts:47). Rewriting them to a concrete version
// would make panel/worker builds try to fetch e.g. @natstack/dev-log@0.1.0 from
// the public registry (404). Drop dev-only fields that would otherwise trigger
// lifecycle scripts or extra registry installs. (The package is listed at its
// concrete version at the host package's top level for bundledDependencies.)
function normalizeVendoredManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return VERSION;
  const pkg = readJson(manifestPath);
  delete pkg.devDependencies;
  delete pkg.scripts;
  writeJson(manifestPath, pkg);
  return pkg.version ?? VERSION;
}

// ---------------------------------------------------------------------------
// Workspace template
// ---------------------------------------------------------------------------
function stageWorkspaceTemplate(dest) {
  const src = path.join(repoRoot, "workspace");
  const include = new Set([
    "meta", "panels", "packages", "agents", "workers", "skills", "about", "templates", "apps", "extensions",
  ]);
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || !include.has(entry.name)) continue;
    copyTree(path.join(src, entry.name), path.join(dest, entry.name), templateSkip);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaultSkip(name, dirent) {
  if (dirent.isDirectory()) {
    return name === "node_modules" || name === ".git" || name === "tests" ||
      name === "__tests__" || name === "dist-publish";
  }
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || name.endsWith(".tsbuildinfo") || name.endsWith(".map");
}

function templateSkip(name, dirent) {
  if (dirent.isDirectory()) {
    // Skip build/vcs cruft and the workspace's dot-prefixed runtime dirs. Do NOT
    // skip a plain "state" dir: panels legitimately have state/ source (e.g.
    // workspace/panels/spectrolite/state). The workspace's runtime state lives at
    // the top level and is already excluded by stageWorkspaceTemplate's include-list.
    return name === "node_modules" || name === ".git" ||
      name === ".databases" || name === ".contexts" || name === ".cache";
  }
  return name === ".env" || name === ".secrets.yml";
}

function copyTree(src, dest, skip) {
  const st = fs.statSync(src);
  if (!st.isDirectory()) {
    mkdirp(path.dirname(dest));
    fs.copyFileSync(src, dest);
    return;
  }
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name, entry)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d, skip);
    else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      if (fs.statSync(real).isDirectory()) copyTree(real, d, skip);
      else fs.copyFileSync(real, d);
    } else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function copyFile(rel, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(path.join(repoRoot, rel), dest);
}

function resolveVersion(name) {
  // Read the installed package.json directly — require.resolve fails for packages
  // whose `exports` map doesn't expose ./package.json.
  const direct = path.join(repoRoot, "node_modules", ...name.split("/"), "package.json");
  if (fs.existsSync(direct)) return `^${readJson(direct).version}`;
  return rootPkg.dependencies?.[name] ?? rootPkg.devDependencies?.[name] ?? null;
}

// The dependency surface a host package needs to build the default template at
// runtime: all public root.dependencies + the build-relevant root devDeps +
// headless extras + the vendored @natstack packages (passed in). The server
// omits electron; the app includes it. (Building panels needs the full host dep
// surface, so the headless server is really "app minus electron", not slim.)
function computeHostDependencies(bundled, { electron }) {
  const deps = { ...bundled };
  for (const [name, range] of Object.entries(rootPkg.dependencies ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) continue;
    deps[name] = range;
  }
  for (const name of HOST_BUILD_DEV_DEPS) {
    const v = rootPkg.devDependencies?.[name];
    if (v) deps[name] = v;
  }
  for (const name of SERVER_EXTRA_DEPS) {
    if (deps[name]) continue;
    const v = resolveVersion(name);
    if (v) deps[name] = v;
    else console.warn(`  ⚠ could not resolve a version for ${name}`);
  }
  if (electron) {
    deps["electron"] = rootPkg.devDependencies?.electron ?? resolveVersion("electron");
  }
  return deps;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
