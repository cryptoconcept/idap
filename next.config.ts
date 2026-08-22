import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/CJS-heavy packages are loaded from node_modules at runtime instead of
  // being bundled into the server build.
  serverExternalPackages: ["mongoose", "pdfkit", "bcryptjs"],

  async headers() {
    return [
      {
        // Baseline hardening for every dashboard and public page.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // The external API is designed for server-to-server calls from any origin.
        source: "/api/v1/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type,Authorization,X-API-KEY,X-API-SECRET",
          },
        ],
      },
      {
        /*
         * The public submission endpoints are called from a visitor's browser on
         * the institution's own website, so they must be reachable cross-origin.
         * They carry no credentials by design — abuse is handled by per-IP rate
         * limiting, not by the origin header, which a client controls anyway.
         */
        source: "/api/public/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
      {
        source: "/widget.js",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
    ];
  },
};

export default nextConfig;
