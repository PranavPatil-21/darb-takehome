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
