import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace panel dependencies from pnpm's node_modules
      // These are needed for tests in workspace/panels/ which aren't pnpm workspace packages
      ignore: path.resolve(__dirname, "node_modules/.pnpm/ignore@5.3.2/node_modules/ignore"),
      picomatch: path.resolve(__dirname, "node_modules/.pnpm/picomatch@4.0.3/node_modules/picomatch"),
      // Workspace packages
      "@workspace/agentic-messaging": path.resolve(__dirname, "workspace/packages/agentic-messaging/src/index.ts"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "workspace/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist", "workspace/.contexts"],
  },
});
