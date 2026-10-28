// `--clips <dir>` for tests/live-fire/transcribe-accuracy.measure.ts.
//
//   node tests/live-fire/transcribe-accuracy.run.mjs [--clips <dir>] [--runs <n>]
//
// vitest rejects options it doesn't know, so this turns the flags into the env
// vars the probe reads and runs it under the measure config. Live fire: spends
// real money (about two cents for the synthetic set).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const env = { ...process.env };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--clips") env.TRANSCRIBE_CLIPS_DIR = resolve(args[++i] ?? "");
  else if (args[i] === "--runs") env.TRANSCRIBE_RUNS = args[++i] ?? "2";
  else {
    console.error(`unknown option ${args[i]} (expected --clips <dir> or --runs <n>)`);
    process.exit(2);
  }
}
const run = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.measure.config.ts", "tests/live-fire/transcribe-accuracy.measure.ts"],
  { stdio: "inherit", env }
);
process.exit(run.status ?? 1);
