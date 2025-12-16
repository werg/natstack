import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["node_modules", "dist"],
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
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      // Non-null assertions are common after test assertions
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
];
