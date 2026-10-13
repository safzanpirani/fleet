import { watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { submit } from "../../src/spikes/safe-exec.ts";
import type { Phase, Request } from "../../src/spikes/safe-exec.ts";

const [spool, encoded, fault, marker] = process.argv.slice(2);
const request = JSON.parse(encoded!) as Request;
try {
  if (fault === "before-admit") {
    watch(dirname(marker!), () => {}); // Keep this real broker alive until the parent's SIGKILL.
    writeFileSync(marker!, fault);
    await new Promise<void>(() => {});
  }
  const result = await submit(spool!, request, async (phase: Phase) => {
    if (phase === fault) {
      watch(dirname(marker!), () => {});
      writeFileSync(marker!, phase);
      await new Promise<void>(() => {}); // Parent SIGKILLs at the exact durable boundary.
    }
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
