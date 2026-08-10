import js from "@eslint/js";

/**
 * Flat config. Kept small on purpose: this project has no framework, no
 * TypeScript and no build-time magic, so the value of a large rule set is low and
 * the cost of arguing about it in review is not.
 *
 * The rules that are on are the ones that catch real bugs in this codebase's
 * style: unused variables after a refactor, accidental globals, and `==`.
 */
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        // Browser surface actually used by the app.
        window: "readonly",
        document: "readonly",
        console: "readonly",
        fetch: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        Intl: "readonly",
        HTMLInputElement: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-implicit-globals": "error",
      "no-console": ["warn", { allow: ["info", "warn", "error"] }],
    },
  },
];
