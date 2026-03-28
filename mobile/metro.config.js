const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");
const sharedDir = path.resolve(monorepoRoot, "src", "shared");

/**
 * Metro bundler configuration for NatStack mobile.
 *
 * Extends the default React Native config to resolve modules from the
 * parent `src/shared/` directory, allowing the mobile app to import
 * shared types and utilities used by the desktop Electron app.
 *
 * Two resolution quirks handled here:
 * 1. `@shared/*` imports → rewritten to `src/shared/*` filesystem paths
 * 2. `.js` extensions in relative imports → resolved to `.ts` files
 *    (TypeScript convention that Metro doesn't natively understand)
 */
const config = {
  watchFolders: [
    // Allow Metro to resolve imports from the shared source directory
    sharedDir,
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

      // 1. Rewrite @shared/* imports to src/shared/* filesystem paths
      if (moduleName.startsWith("@shared/")) {
        const subpath = moduleName.slice("@shared/".length);
        const redirected = path.resolve(sharedDir, subpath);
        return context.resolveRequest(context, redirected, platform);
      }

      // 2. Handle TypeScript's .js extension convention for relative imports.
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
