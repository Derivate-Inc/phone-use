import type { NextConfig } from "next";

const API_ORIGIN = process.env.PHONE_USE_API_ORIGIN ?? "https://api.phoneuse.dev";

const nextConfig: NextConfig = {
  // The repo root has its own bun.lock; pin Turbopack's root to this app so it
  // doesn't infer the parent directory.
  turbopack: { root: `${__dirname}/../..` },
  // Same-origin proxy to the control plane: the console calls /v1/* and
  // /api/auth/* on its own origin, Vercel forwards to Railway. First-party
  // cookies in every browser; no CORS, no dependency on the api.* cert.
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` },
      { source: "/api/auth/:path*", destination: `${API_ORIGIN}/api/auth/:path*` },
    ];
  },
};

export default nextConfig;
