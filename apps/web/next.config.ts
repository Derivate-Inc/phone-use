import type { NextConfig } from "next";

const API_ORIGIN = process.env.PHONE_USE_API_ORIGIN ?? "https://api.phoneuse.dev";

const nextConfig: NextConfig = {
  turbopack: { root: `${__dirname}/../..` },
  // Same-origin proxy to the control plane: the console calls /v1/* and
  // /api/auth/* on its own origin; Vercel forwards to Railway. First-party
  // cookies in every browser, no CORS, no dependency on the api.* cert.
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` },
      { source: "/api/auth/:path*", destination: `${API_ORIGIN}/api/auth/:path*` },
    ];
  },
};

export default nextConfig;
