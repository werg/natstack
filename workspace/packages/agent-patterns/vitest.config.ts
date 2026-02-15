import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@workspace/agentic-messaging": path.resolve(__dirname, "../agentic-messaging/src/index.ts"),
      "@workspace/agentic-messaging/utils": path.resolve(__dirname, "../agentic-messaging/src/utils-entry.ts"),
      "@workspace/agentic-messaging/async": path.resolve(__dirname, "../agentic-messaging/src/async-entry.ts"),
      "@workspace/agentic-messaging/json-schema": path.resolve(__dirname, "../agentic-messaging/src/json-schema-entry.ts"),
      "@workspace/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@workspace/pubsub": path.resolve(__dirname, "../pubsub/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
