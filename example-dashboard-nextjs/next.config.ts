import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the webhook URL already registered with KPC working: /webhooks/kpc -> /api/webhooks/kpc
  async rewrites() {
    return [{ source: "/webhooks/kpc", destination: "/api/webhooks/kpc" }];
  },
};

export default nextConfig;
