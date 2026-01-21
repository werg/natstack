import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  testDir: path.resolve(__dirname, "../e2e"),
  fullyParallel: false, // Electron tests run serially
  workers: 1, // Single worker for Electron
  timeout: 60000, // Electron startup can be slow
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,

  reporter: [
    ["list"],
    ["html", { outputFolder: path.resolve(__dirname, "../../test-results/html") }],
    [
      "json",
      {
        outputFile: path.resolve(__dirname, "../../test-results/results.json"),
      },
    ],
    ...(process.env.CI ? [["github" as const]] : []),
  ],

  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: process.env.CI ? "on-first-retry" : "off",
  },

  expect: {
    timeout: 10000,
  },

  // Output directories
  outputDir: path.resolve(__dirname, "../../test-results/artifacts"),
});
