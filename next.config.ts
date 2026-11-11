import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex" }, { key: "X-Frame-Options", value: "DENY" }] }];
  },
};

export default nextConfig;
