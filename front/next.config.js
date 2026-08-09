const isDev = process.env.NODE_ENV !== "production";

// In development the front is on 3005 and the API on 6800, so calls are
// cross-origin and the API has to be allowed explicitly. In production nginx
// serves both from one domain and /api/ is same-origin, so 'self' covers it and
// there is nothing to configure. This is why the front has no env file.
const apiOrigin = isDev ? "http://localhost:6800" : null;

const devConnectSources = ["ws:", "wss:"];

// Fonts are self-hosted through next/font, so no external font host is allowed
// here. An app for private infrastructure should make no third-party request.
const cspDirectives = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "script-src": [
    "'self'",
    // Next injects an inline bootstrap script unless CSP nonces are used.
    "'unsafe-inline'",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'", ...(apiOrigin ? [apiOrigin] : []), ...(isDev ? devConnectSources : [])],
  "frame-src": ["'none'"],
  "worker-src": ["'self'", "blob:"],
};

const contentSecurityPolicy = Object.entries(cspDirectives)
  .map(([directive, values]) => `${directive} ${values.join(" ")}`)
  .join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
