import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@natstack/agentic-messaging": path.resolve(__dirname, "../agentic-messaging/src/index.ts"),
      "@natstack/agentic-messaging/utils": path.resolve(__dirname, "../agentic-messaging/src/utils-entry.ts"),
      "@natstack/agentic-messaging/async": path.resolve(__dirname, "../agentic-messaging/src/async-entry.ts"),
      "@natstack/agentic-messaging/json-schema": path.resolve(__dirname, "../agentic-messaging/src/json-schema-entry.ts"),
      "@natstack/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@natstack/pubsub": path.resolve(__dirname, "../pubsub/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
