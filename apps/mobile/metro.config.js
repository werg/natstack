const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..", "..");

/**
 * Metro bundler configuration for NatStack mobile.
 *
 * Extends the default React Native config to resolve workspace packages
 * and handle a few Metro resolution quirks:
 * 1. `.js` extensions in relative imports → resolved to `.ts` files
 *    (TypeScript convention that Metro doesn't natively understand)
 * 2. react-native-screens → resolved via "main" (lib/) instead of
 *    "react-native" (src/). The raw src/ Fabric specs use CodegenTypes
 *    which @react-native/babel-plugin-codegen in RN 0.79 can't parse.
 *    The pre-built lib/ output works correctly with old architecture.
 */
const nodeBuiltinPolyfills = {
  path: require.resolve("path-browserify"),
  crypto: path.resolve(projectRoot, "src", "polyfills", "crypto.js"),
  fs: path.resolve(projectRoot, "src", "polyfills", "fs.js"),
  "node:crypto": path.resolve(projectRoot, "src", "polyfills", "crypto.js"),
  "node:path": require.resolve("path-browserify"),
  "node:fs": path.resolve(projectRoot, "src", "polyfills", "fs.js"),
};

const config = {
  watchFolders: [
    // Allow Metro to resolve workspace packages
    path.resolve(monorepoRoot, "packages"),
    // Root node_modules for hoisted dependencies
    path.resolve(monorepoRoot, "node_modules"),
  ],

  resolver: {
    // Ensure Metro can find node_modules in both mobile/ and the monorepo root
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(monorepoRoot, "node_modules"),
    ],

    resolveRequest: (context, moduleName, platform) => {
      // Node.js built-in polyfills for shared code running in React Native
      if (nodeBuiltinPolyfills[moduleName]) {
        return { type: "sourceFile", filePath: nodeBuiltinPolyfills[moduleName] };
      }
      // 0. Ensure a single copy of react is used (local if installed, else hoisted root)
      if (moduleName === "react" || moduleName === "react/jsx-runtime" || moduleName === "react/jsx-dev-runtime") {
        const localPath = path.resolve(projectRoot, "node_modules", moduleName);
        try {
          require.resolve(localPath);
          return context.resolveRequest(context, localPath, platform);
        } catch {
          const rootPath = path.resolve(monorepoRoot, "node_modules", moduleName);
          return context.resolveRequest(context, rootPath, platform);
        }
      }

      // 0b. Resolve @natstack/* packages to their TypeScript source.
      //     These packages export "main": "./dist/index.js" for Node/esbuild,
      //     but dist/ may not exist (it's built by the desktop build pipeline).
      //     Metro can bundle .ts directly, so point to src/index.ts instead.
      if (moduleName.startsWith("@natstack/") && !moduleName.startsWith("@natstack/shared/")) {
        const pkgName = moduleName.split("/").slice(0, 2).join("/");
        const subpath = moduleName.slice(pkgName.length);
        const pkgDir = path.resolve(monorepoRoot, "packages", pkgName.replace("@natstack/", ""));
        if (subpath) {
          // Subpath import like @natstack/rpc/types
          const resolved = path.resolve(pkgDir, "src", subpath.slice(1));
          return context.resolveRequest(context, resolved, platform);
        }
        // Bare import like @natstack/rpc -> packages/rpc/src/index.ts
        const srcEntry = path.resolve(pkgDir, "src", "index.ts");
        return { type: "sourceFile", filePath: srcEntry };
      }

      // 0c. Resolve react-native-screens via pre-built lib/ output.
      //     Metro's default "react-native" field points to src/ which contains
      //     Fabric NativeComponent specs using CodegenTypes -- a pattern the
      //     @react-native/babel-plugin-codegen in RN 0.79 cannot parse.
      //     The lib/commonjs/ output is already compiled and works correctly.
      if (moduleName === "react-native-screens") {
        const localBase = path.resolve(projectRoot, "node_modules", "react-native-screens");
        const rootBase = path.resolve(monorepoRoot, "node_modules", "react-native-screens");
        const fs = require("fs");
        const base = fs.existsSync(localBase) ? localBase : rootBase;
        const prebuilt = path.resolve(base, "lib", "commonjs", "index.js");
        return { type: "sourceFile", filePath: prebuilt };
      }

      // 1. Handle TypeScript's .js extension convention for relative imports.
      //    TypeScript emits `import from "./foo.js"` which should resolve to
      //    `./foo.ts` in source. Metro doesn't do this mapping, so we check
      //    if stripping .js yields a .ts file that exists.
      if (
        moduleName.endsWith(".js") &&
        (moduleName.startsWith("./") || moduleName.startsWith("../") || moduleName.startsWith("/"))
      ) {
        const withoutJs = moduleName.slice(0, -3);
        try {
          return context.resolveRequest(context, withoutJs, platform);
        } catch {
          // Fall through to default resolution
        }
      }

      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
