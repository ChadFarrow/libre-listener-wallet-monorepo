// Flat ESLint config for the monorepo. Type-aware linting is enabled via
// typescript-eslint's projectService, which resolves each package's own
// tsconfig automatically. The emphasis is correctness in a wallet full of async
// payment paths — floating/misused promises are ERRORS — while the noise that
// LDK's raw bindings force (pervasive `any`, non-null assertions) is relaxed so
// the signal stays high.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    // Never lint build output, deps, or generated bundles.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/public/**",
      "**/*.cjs",
      "**/*.mjs",
      "**/*.config.ts",
      "**/*.config.mjs",
      "**/scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // --- The rules that matter for a wallet: unhandled async is a bug. ---
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],

      // --- Relaxed: LDK's generated bindings make these unavoidable/noisy. ---
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // `const self = this` is a deliberate pattern for LDK closure callbacks.
      "@typescript-eslint/no-this-alias": "off",
      // LDK binding signatures surface `{}` types we don't control.
      "@typescript-eslint/no-empty-object-type": "off",

      // --- Surfaced as warnings for gradual cleanup, not blocking (pre-existing
      //     style debt across the codebase; not what this lint pass enforces). ---
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: false }],
      "prefer-const": "warn",
    },
  },
  {
    // Tests exercise error paths and use loose fixtures; keep them lint-clean
    // without fighting deliberate throwaways.
    files: ["**/*.test.ts", "**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
