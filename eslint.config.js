import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "node_modules",
      "dist",
      "apps/mobile/*.config.js",
      "apps/mobile/index.js",
      "workspace/apps/mobile/src/polyfills/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow dynamic delete for config/state cleanup patterns
      "@typescript-eslint/no-dynamic-delete": "warn",
      // Allow non-null assertions as warnings (prototype code, will be fixed incrementally)
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  // Test files - more permissive rules
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"],
    rules: {
      // Non-null assertions are common after test assertions
      "@typescript-eslint/no-non-null-assertion": "off",
      // Test doubles are frequently modeled as empty/static-only stub classes
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
];
