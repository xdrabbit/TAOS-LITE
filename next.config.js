/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Ship the harvested course markdown with the lessons API serverless fn.
    outputFileTracingIncludes: {
      "/api/tutor/lessons": ["./content/tutor-course/**/*"]
    }
  }
};

module.exports = nextConfig;
