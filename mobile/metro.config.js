const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");

/**
 * Metro bundler configuration for NatStack mobile.
 *
 * Extends the default React Native config to resolve modules from the
 * parent `src/shared/` directory, allowing the mobile app to import
 * shared types and utilities used by the desktop Electron app.
 */
const config = {
  watchFolders: [
    // Allow Metro to resolve imports from the shared source directory
    path.resolve(monorepoRoot, "src", "shared"),
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

    // Map @shared/* path alias to ../src/shared/*
    extraNodeModules: {
      "@shared": path.resolve(monorepoRoot, "src", "shared"),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
