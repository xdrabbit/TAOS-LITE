/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // ffmpeg-static resolves its binary relative to its own __dirname. Bundled
    // by webpack, that __dirname becomes the route chunk's directory and the
    // path points at a binary that isn't there (production 8/13: "spawn
    // .../app/api/video/process/ffmpeg ENOENT"). Keeping it external makes the
    // runtime require() resolve from node_modules, where the tracing include
    // below actually ships the binary.
    serverComponentsExternalPackages: ["ffmpeg-static"],
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
