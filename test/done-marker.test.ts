import { describe, expect, test } from "bun:test";
import { doneMarker, takeDoneMarker, withDoneMarker } from "../src/ssh.ts";
import { useColor } from "../src/cli.ts";

describe("completion marker", () => {
  test("each call gets its own nonce", () => {
    expect(doneMarker()).not.toBe(doneMarker());
    expect(doneMarker()).toMatch(/^__FLEET_DONE_[0-9a-f]{32}__$/);
  });

  test("the marker line is removed and its status read", () => {
    const m = doneMarker();
    expect(takeDoneMarker(`warn: x\n${m}3\n`, m)).toEqual({ stderr: "warn: x", code: 3 });
    expect(takeDoneMarker(`\r\n${m}?\r\n`, m)).toEqual({ stderr: "", code: null });
    expect(takeDoneMarker("plain error", m)).toEqual({ stderr: "plain error" });
  });

  test("a real bash script reports its exit status even when a child keeps stdout open", async () => {
    const m = doneMarker();
    const script = withDoneMarker("echo out; (sleep 5 &); exit 7", "bash", m);
    const proc = Bun.spawn(["/bin/bash", "-s"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" });
    const reader = proc.stderr.getReader();
    const started = Date.now();
    let err = "";
    while (!err.includes(m)) {
      const { value, done } = await reader.read();
      if (done) break;
      err += new TextDecoder().decode(value);
    }
    // The marker arrives when the script ends, long before the child lets go.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(takeDoneMarker(err + "\n", m).code).toBe(7);
    proc.kill();
  });

  test("a command that reads stdin cannot swallow the rest of a bash program", async () => {
    const m = doneMarker();
    const script = withDoneMarker("echo before\ncat\necho after", "bash", m);
    const proc = Bun.spawn(["/bin/bash", "-s"], { stdin: new TextEncoder().encode(script + "\n"), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(out).toBe("before\nafter\n");
    expect(takeDoneMarker(err, m).code).toBe(0);
  });

  test("the PowerShell wrapper ships the program base64-encoded and dot-sources it", () => {
    const m = doneMarker();
    const wrapped = withDoneMarker("Write-Output 'héllo ✓'", "powershell", m);
    const b64 = /FromBase64String\('([^']+)'\)/.exec(wrapped)![1]!;
    expect(Buffer.from(b64, "base64").toString("utf8")).toStartWith("Write-Output 'héllo ✓'\n$__fleetOk = $?");
    expect(wrapped).toContain(". ([scriptblock]::Create(");
    expect(wrapped).toContain(`'${m}'`);
    expect(/^[\x20-\x7e\r\n\t]*$/.test(wrapped)).toBe(true);   // the wrapper itself is pure ASCII
  });
});

describe("colour", () => {
  test("only for a terminal, NO_COLOR always wins, FORCE_COLOR restores it", () => {
    expect(useColor({}, true)).toBe(true);
    expect(useColor({}, false)).toBe(false);
    expect(useColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
    expect(useColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(useColor({ FORCE_COLOR: "0" }, false)).toBe(false);
  });
});
