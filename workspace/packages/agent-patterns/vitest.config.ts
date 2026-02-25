import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@workspace/agentic-protocol": path.resolve(__dirname, "../agentic-protocol/src/index.ts"),
      "@natstack/pubsub": path.resolve(__dirname, "../../../packages/pubsub/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
