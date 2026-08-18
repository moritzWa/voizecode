import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  async headers() {
    return [
      {
        // Apple fetches this to decide whether voizecode.com may open the iOS app, and it
        // rejects the file unless it is served as application/json. The file has no extension
        // (Apple requires that), so Next would otherwise serve it as octet-stream and universal
        // links would silently never work — no error anywhere, links just open Safari.
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
    ];
  },
};

export default nextConfig;
