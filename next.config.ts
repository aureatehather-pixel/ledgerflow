import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fail the build on type errors rather than shipping them. This is already the
  // Next.js default; stated explicitly so that a future "just unblock the build"
  // edit has to be a deliberate, reviewable change.
  typescript: { ignoreBuildErrors: false },
  // Next 16 removed `eslint` from NextConfig -- `next build` no longer runs lint.
  // Linting is therefore a separate gate: `npm run lint` (and `npm run check`),
  // which CI must run. Dropping it from CI would silently remove the lint gate.
};

export default nextConfig;
