import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // R2配信ドメイン(またはAPI GatewayのWorkerドメイン)を本番では指定する
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
