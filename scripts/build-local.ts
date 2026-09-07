import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const dist = join(root, "dist");
const suffix = process.platform === "win32" ? ".exe" : "";
const candidate = join(dist, `.fleet-local-${crypto.randomUUID()}${suffix}`);
const output = join(dist, `fleet-local${suffix}`);

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command[0]} exited ${code}; previous artifact preserved`);
}

await mkdir(dist, { recursive: true });
await run([process.execPath, "build", "--compile", "src/cli.ts", "--outfile", candidate]);

if (process.platform === "darwin") {
  // Some Bun builds append the bundle after signing. Check the final bytes.
  const verify = Bun.spawn(["/usr/bin/codesign", "--verify", candidate], { stdout: "ignore", stderr: "ignore" });
  if (await verify.exited !== 0)
    await run(["/usr/bin/codesign", "--force", "--sign", "-", candidate]);
  await run(["/usr/bin/codesign", "--verify", candidate]);
}

const smoke = Bun.spawn([candidate, "--help"], {
  cwd: dist,
  env: { ...process.env, FLEET_CONFIG: `${candidate}.no-config` },
  stdin: "ignore", stdout: "pipe", stderr: "pipe",
  timeout: 5000, killSignal: "SIGKILL",
});
const [stdout, stderr, code] = await Promise.all([
  new Response(smoke.stdout).text(), new Response(smoke.stderr).text(), smoke.exited,
]);
if (code !== 0 || !stdout.includes("fleet jobs") || stderr)
  throw new Error(`compiled help smoke failed (exit ${code}); previous artifact preserved\n${stderr}`);

await rename(candidate, output);
console.log(output);
