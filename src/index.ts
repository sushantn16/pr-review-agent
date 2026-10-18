// Entry point for the GitHub Actions runner (node24 runs the TypeScript directly).
import { log } from "./actions.ts";
import { run } from "./main.ts";

try {
  await run();
} catch (e) {
  log.error(`pr-review-agent: ${(e as Error).message}`);
  process.exitCode = 1;
}
