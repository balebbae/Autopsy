import type { NextConfig } from "next";

// Pin the Turbopack/tracing root to this directory. Next.js 16 auto-detects
// the project root by walking up looking for any lockfile, which can pick up
// stray lockfiles in the monorepo root (e.g. an empty package-lock.json
// produced by an accidental `npm` invocation) and break CSS/Tailwind module
// resolution. Setting `turbopack.root` makes the resolution deterministic.
//
// See: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/turbopack.md
//
// Next.js compiles this file to CJS, so the global `__dirname` is available.
const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
