import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The live-fire measurement rig. Separate from vitest.config.ts on purpose:
// these files talk to the real OpenAI Realtime API and spend real money, so
// they must never be picked up by `npm test` or by CI.
//
//   npx vitest run --config vitest.measure.config.ts
//
// See tests/live-fire/realtime-cost.measure.ts for the knobs.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) }
  },
  test: {
    include: ["tests/live-fire/**/*.measure.ts"],
    // One session at a time: two sessions racing would compete for the same
    // rate limit and each would measure the other's backpressure.
    fileParallelism: false,
    // The measurement IS the console output; vitest must not buffer or drop it.
    disableConsoleIntercept: true,
    testTimeout: 20 * 60 * 1000
  }
});
