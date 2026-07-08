// Correctness-focused lint for the frontend. Deliberately NOT a style linter:
// the rules here catch the bug classes that have actually shipped (undefined
// identifiers, broken hook usage) without churning the existing code.
// Run with: npm run lint
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-cond-assign": "error",
      "no-constant-condition": "warn",
      "no-unsafe-negation": "error",
      "no-compare-neg-zero": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
