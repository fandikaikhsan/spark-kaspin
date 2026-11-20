import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: { "/api/staffing/warnings/document": ["./public/logo_sarkop_red.png"] },
};

export default nextConfig;
