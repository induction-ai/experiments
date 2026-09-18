// @ts-check

import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import noInlineOrDynamicImport from "./eslint-rules/no-inline-or-dynamic-import.js";

const localPlugin = {
  meta: { name: "local", version: "0.0.0" },
  rules: {
    "no-inline-or-dynamic-import": noInlineOrDynamicImport,
  },
};

export default defineConfig(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    plugins: { local: localPlugin },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-base-to-string": "warn",
      "local/no-inline-or-dynamic-import": "error",
    },
  },
  {
    files: ["**/*.mjs", "**/*.js", "eslint-rules/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    ignores: [
      ".claude/",
      ".temp/",
      "dist/",
      "logs/",
      "node_modules/",
      "**/dist/",
      "**/node_modules/",
    ],
  }
);
