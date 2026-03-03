import type { NextConfig } from "next";

// Serve this Next app under /app on app.splui.com
// and proxy API/static asset requests to the external CoupElephant backend.
const backendOrigin = (
  process.env.COUPANG_ELEPHANT_BACKEND_ORIGIN || "https://app2.splui.com"
).replace(/\/+$/, "");

const nextConfig: NextConfig = {
  basePath: "/app",
  async rewrites() {
    return [
      // Proxy existing Express APIs (must work outside basePath)
      { source: "/api/:path*", destination: `${backendOrigin}/api/:path*`, basePath: false },
      // Proxy existing console UI (legacy) so we can embed it
      { source: "/console/:path*", destination: `${backendOrigin}/console/:path*`, basePath: false },
      // Proxy hosted images
      { source: "/couplus-out/:path*", destination: `${backendOrigin}/couplus-out/:path*`, basePath: false },
      { source: "/tmp/:path*", destination: `${backendOrigin}/tmp/:path*`, basePath: false },
    ];
  },
};

export default nextConfig;
