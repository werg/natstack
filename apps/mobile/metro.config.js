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
      // 0. Force react/react-native to resolve from mobile's node_modules
      //    (prevents hoisted root version from shadowing mobile's pinned version)
      if (moduleName === "react" || moduleName === "react/jsx-runtime" || moduleName === "react/jsx-dev-runtime") {
        const localPath = path.resolve(projectRoot, "node_modules", moduleName);
        return context.resolveRequest(context, localPath, platform);
      }

      // 0b. Resolve react-native-screens via pre-built lib/ output.
      //     Metro's default "react-native" field points to src/ which contains
      //     Fabric NativeComponent specs using CodegenTypes -- a pattern the
      //     @react-native/babel-plugin-codegen in RN 0.79 cannot parse.
      //     The lib/commonjs/ output is already compiled and works correctly.
      if (moduleName === "react-native-screens") {
        const prebuilt = path.resolve(
          projectRoot, "node_modules", "react-native-screens", "lib", "commonjs", "index.js",
        );
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
