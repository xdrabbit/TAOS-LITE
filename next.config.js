/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Ship the harvested course markdown with the lessons API serverless fn.
    outputFileTracingIncludes: {
      "/api/tutor/lessons": ["./content/tutor-course/**/*"],
      // The ffmpeg binary is resolved at runtime by path, which file tracing
      // can't see — without this the deployed function has no ffmpeg.
      "/api/video/process": ["./node_modules/ffmpeg-static/ffmpeg"]
    }
  }
};

module.exports = nextConfig;
