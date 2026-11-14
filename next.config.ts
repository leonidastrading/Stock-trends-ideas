import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDF text extraction for the GitHub inbox runs as plain Node (pdf.js), not through the bundler.
  serverExternalPackages: ["unpdf"],
  // The chatter test's look-back data is read from disk at request time.
  outputFileTracingIncludes: { "/chatter": ["./data/chatter-explore/*.json"] },
  async headers() {
    return [{ source: "/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex" }, { key: "X-Frame-Options", value: "DENY" }] }];
  },
};

export default nextConfig;
