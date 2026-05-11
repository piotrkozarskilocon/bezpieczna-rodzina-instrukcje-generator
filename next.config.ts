import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/generator-instrukcji",
  assetPrefix: "/generator-instrukcji",
  reactStrictMode: true,
  // Match hub site's `trailingSlash: true` (vercel.json) so the proxy chain
  // doesn't bounce between `/generator-instrukcji` (hub canonical) and
  // `/generator-instrukcji/` (Next.js default canonical) → ERR_TOO_MANY_REDIRECTS.
  trailingSlash: true,
};

export default nextConfig;
