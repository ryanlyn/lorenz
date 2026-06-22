import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "log/**", "node_modules/**", "apps/traceviz/dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: [
      "packages/**/*.{ts,tsx}",
      "extensions/**/*.{ts,tsx}",
      "apps/**/*.{ts,tsx}",
      "scripts/**/*.ts",
      "test/**/*.ts",
    ],
    plugins: {
      "import-x": importX,
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/promise-function-async": "error",
      "import-x/order": ["warn", { "newlines-between": "always" }],
    },
  },
  {
    files: ["packages/*/test/**/*.ts", "extensions/*/test/**/*.ts", "apps/*/test/**/*.ts", "test/**/*.ts"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Flake guard: ban fixed-delay sleeps in tests. `disableTypeChecked` strips
    // the type-aware rules above, so this lives in its own block to survive that
    // reset and to also cover `.tsx` test files.
    files: [
      "packages/*/test/**/*.{ts,tsx}",
      "extensions/*/test/**/*.{ts,tsx}",
      "apps/*/test/**/*.{ts,tsx}",
      "test/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']",
          message:
            "Fixed-delay sleep in a test (`new Promise(r => setTimeout(r, ms))`) is a flake source. Poll the condition with `vi.waitFor`/`vi.waitUntil`, drive timer code with `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`, or—only when asserting something does NOT happen—use `settle()` from @lorenz/test-utils.",
        },
      ],
    },
  },
);
