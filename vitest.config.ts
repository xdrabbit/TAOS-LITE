import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig.json sets `"jsx": "preserve"` because Next does its own JSX
  // transform. Vitest has no Next in front of it, so a test that RENDERS a
  // component (rather than calling a hook) needs the transform spelled out
  // here — otherwise vite hands raw JSX to its import analyser and reports it
  // as "invalid JS syntax" in a file the test never wrote.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    // Mirror tsconfig's "@/..." path alias so tests import app code verbatim.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) }
  },
  test: {
    include: ["tests/**/*.test.ts"]
  }
});
