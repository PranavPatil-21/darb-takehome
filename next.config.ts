import type { NextConfig } from 'next';

/**
 * `next dev` and `next build` both write to `.next` by default, and they write
 * incompatible things into it. Running a build while a dev server is up leaves the dev
 * server serving a half-overwritten client manifest, and every affected route then fails
 * with `Could not find the module … in the React Client Manifest` — an error that points
 * at the React Server Components bundler and says nothing about the actual cause.
 *
 * That is not a theoretical hazard: it happened three times during development here, and
 * it would happen to anyone evaluating this who runs `npm run build` in a second terminal
 * to check the project compiles. Giving the production build its own output directory
 * removes the collision entirely rather than relying on everybody remembering.
 */
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
};

export default nextConfig;
