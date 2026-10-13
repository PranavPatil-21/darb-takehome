import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Type-aware linting, on the source only.
    //
    // `next/typescript` ships the *untyped* recommended set, so the entire `no-unsafe-*`
    // tier and `no-floating-promises` were switched off. The repo has no `any` today, but
    // "lint is clean" meant less than it looked: an `any` arriving from an untyped
    // boundary would have flowed through unflagged, and an unawaited promise anywhere in
    // the ingestion pipeline would not have been an error. These are the rules that make
    // the type-safety claim enforced rather than observed.
    files: ["lib/**/*.ts", "lib/**/*.tsx", "app/**/*.ts", "app/**/*.tsx", "components/**/*.tsx"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      // A symbol nobody imports is either dead or a mistake; neither should pass CI as a
      // warning that scrolls past.
      "@typescript-eslint/no-unused-vars": "error",
    },
  },
  {
    // Generated output only. `.next-build` is the production build's distDir, kept
    // separate from the dev server's `.next` so that running a build never corrupts a
    // running dev server (see ARCHITECTURE.md). Both have to be listed: `npm run lint`
    // is a bare `eslint`, which walks the whole tree, and linting compiled output
    // produces thousands of findings that bury the real ones.
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-build/**",
      "out/**",
      "build/**",
      "coverage/**",
      "next-env.d.ts",
      "*.tsbuildinfo",
    ],
  },
];

export default eslintConfig;
