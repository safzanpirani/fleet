#!/usr/bin/env bun
/**
 * Day-to-day computer-use suite for `fleet cu` against a live Windows desktop.
 *
 *   bun run scripts/cu-daily.ts <host> [case…] [--paid]
 *
 * Each case does a small everyday task through the real CLI, checks the result
 * through the app's own state or the file system, and closes what it opened.
 * `--paid` adds the `elements --task` case, which makes one paid TypeSafe call.
 * FLEET_BIN picks the fleet to test (default: this checkout's src/cli.ts).
 *
 * Needs a logged-in desktop with cua-driver installed (`fleet cu <host> install`).
 * Windows it opens stay behind other windows; nothing is raised or focused
 * except where a case says so.
 */

type Win = { pid: number; window_id: number; title: string };
type El = { token: string; role: string; label: string; value?: unknown; selected?: boolean; center?: { x: number; y: number } };

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith("--"));
if (!host) { console.error("usage: bun run scripts/cu-daily.ts <host> [case…] [--paid]"); process.exit(2); }
const only = args.filter((a) => !a.startsWith("--") && a !== host);
const paid = args.includes("--paid");
const fleetBin = process.env.FLEET_BIN?.split(" ") ?? ["bun", "run", `${import.meta.dir}/../src/cli.ts`];

async function fleet(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([...fleetBin, ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

async function ok(...argv: string[]): Promise<string> {
  const r = await fleet(...argv);
  if (r.code !== 0) throw new Error(`fleet ${argv.join(" ")} exited ${r.code}: ${(r.err || r.out).trim().split("\n").slice(0, 3).join(" | ")}`);
  return r.out;
}

async function open(app: string, arg?: string): Promise<Win> {
  const out = await ok("cu", host!, "open", app, ...(arg ? [arg] : []), "--json");
  const w = JSON.parse(out).window;
  if (!w?.pid) throw new Error(`open ${app} named no window`);
  return w;
}

async function elements(target: string | number, ...extra: string[]): Promise<El[]> {
  return JSON.parse(await ok("cu", host!, "elements", String(target), ...extra, "--json")).elements;
}

/** UIA values arrive padded ("69104 ", "Ω\r"); compare trimmed. */
const val = (e: El | undefined) => String(e?.value ?? "").trim();

async function exec(ps: string): Promise<string> {
  const out = await ok("exec", "--json", host!, ps);
  const r = JSON.parse(out);
  const first = Array.isArray(r) ? r[0] : r.results?.[0] ?? r;
  return String(first.stdout ?? "").trim();
}

async function close(w: Win | undefined) {
  if (w) await fleet("cu", host!, "click", String(w.pid), "--label", "Close", "--role", "Button");
}


function expectEq(what: string, got: unknown, want: unknown) {
  if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── cases ─────────────────────────────────────────────────────────────────────

const cases: Record<string, { paid?: boolean; run: () => Promise<string> }> = {
  /** Arithmetic: 1234 × 56 in one ordered batch of element clicks. */
  calculator: {
    async run() {
      const w = await open("Calculator");
      try {
        const buttons = await elements(w.pid, "--role", "Button", "--max", "200");
        const token = (label: string) => {
          const b = buttons.find((e) => e.label === label);
          if (!b) throw new Error(`Calculator has no "${label}" button`);
          return b.token;
        };
        const steps = ["Clear", "1", "2", "3", "4", "Multiply", "5", "6", "Equals"]
          .map((l) => ({ tool: "click", args: { element_token: token(l) } }));
        await ok("cu", host!, "batch", String(w.pid), JSON.stringify(steps), "--json");
        const result = (await elements(w.pid, "Result")).find((e) => e.label === "Result");
        expectEq("Result", val(result), "69104");
        return "1234 × 56 = 69104";
      } finally { await close(w); }
    },
  },

  /** Files: make a folder in Explorer and name it, then check the disk. */
  "explorer-folder": {
    async run() {
      const dir = "C:\\Users\\Public";
      const name = `fleet-cu-daily-${Date.now().toString(36)}`;
      if (await exec(`Test-Path -LiteralPath '${dir}\\New folder'`) === "True")
        throw new Error(`${dir}\\New folder already exists; Explorer would name the new one "New folder (2)"`);
      const w = await open("explorer", dir);
      try {
        await ok("cu", host!, "click", String(w.pid), "--label", "New", "--role", "Button");
        await ok("cu", host!, "click", String(w.pid), "--label", "Folder", "--role", "MenuItem");
        await ok("cu", host!, "set", String(w.pid), name, "--label", "New folder", "--role", "ListItem");
        await Bun.sleep(500);
        expectEq("folder on disk", await exec(`Test-Path -LiteralPath '${dir}\\${name}' -PathType Container`), "True");
        return `created ${dir}\\${name}`;
      } finally {
        await exec(`Remove-Item -LiteralPath '${dir}\\${name}','${dir}\\New folder' -Force -ErrorAction SilentlyContinue; 'ok'`).catch(() => {});
        await close(w);
      }
    },
  },

  /** Text: find Ω in Character Map by name and put it in the copy field. */
  "charmap-omega": {
    async run() {
      const w = await open("charmap");
      try {
        let els = await elements(w.pid);
        const advanced = els.find((e) => e.label === "Advanced view");
        if (!advanced?.selected) {
          await ok("cu", host!, "click", String(w.pid), "--label", "Advanced view");
          els = await elements(w.pid);
        }
        const search = els.find((e) => e.role === "Edit" && e.label.startsWith("Search for"));
        if (!search?.center) throw new Error("no Search for field");
        // set_value fills the box without the change notice that enables Search,
        // so clear it, focus it with a click, and type like a person would.
        await ok("cu", host!, "set", String(w.pid), "", "--element", search.token);
        await ok("cu", host!, "click", String(w.pid), String(search.center.x), String(search.center.y));
        // cua-driver's synthetic-events route reports delivery_failed for this
        // type_text even though every character lands, so judge by the field.
        const phrase = "greek capital letter omega";
        const typed = await fleet("cu", host!, "type", String(w.pid), phrase);
        const field = (await elements(w.pid, "--role", "Edit")).find((e) => e.label.startsWith("Search for"));
        expectEq("Search for", val(field), phrase);
        const falseAlarm = typed.code !== 0;
        await fleet("cu", host!, "key", String(w.pid), "return");
        // The grid is custom-drawn and exposes no cells, and the search also finds
        // Ώ and other Omega variants. Try the first row by pixel (cells start at
        // 40,104, about 24 px apart) and read what each one puts in the copy field.
        let cell = -1, copied = "";
        for (let i = 0; i < 8 && cell < 0; i++) {
          await ok("cu", host!, "set", String(w.pid), "", "--label", "Characters to copy");
          await ok("cu", host!, "click", String(w.pid), String(40 + 24 * i), "104");
          await ok("cu", host!, "click", String(w.pid), "--label", "Select", "--role", "Button");
          const copy = (await elements(w.pid, "--role", "Edit")).find((e) => e.label.startsWith("Characters to copy"));
          copied = val(copy);
          if (copied === "\u03a9") cell = i;
        }
        if (cell < 0) throw new Error(`no U+03A9 in the first row; last copied ${JSON.stringify(copied)}`);
        return `Ω (U+03A9) from cell ${cell + 1}` + (falseAlarm ? "; the driver called the typing undelivered, the field says otherwise" : "");
      } finally { await close(w); }
    },
  },

  /** Settings: read the device name from System › About and match hostname. */
  "settings-about": {
    async run() {
      // A running Settings reuses its window, so the launch names none; the
      // window is addressed by its title instead.
      await ok("cu", host!, "open", "ms-settings:about", "--json");
      await Bun.sleep(1500);
      const w = JSON.parse(await ok("cu", host!, "elements", "Settings", "Device name", "--json")).target?.window as Win | undefined;
      try {
        const texts = await elements("Settings", "--role", "Text", "--max", "300");
        const i = texts.findIndex((e) => e.label === "Device name");
        if (i < 0) throw new Error("System › About shows no Device name");
        const shown = texts[i + 1]?.label ?? "";
        expectEq("device name", shown, await exec("hostname"));
        return `device name ${shown}`;
      } finally { await close(w); }
    },
  },

  /** Focus: `--task` must keep the row the task needs and drop most others. */
  "explorer-task": {
    paid: true,
    async run() {
      const w = await open("explorer", "C:\\Windows");
      try {
        const all = await elements(w.pid, "--max", "1000");
        const kept = await elements(w.pid, "--max", "1000", "--task", "open the Fonts folder");
        if (!kept.some((e) => e.label === "Fonts")) throw new Error("the Fonts row was hidden");
        if (kept.length * 2 > all.length) throw new Error(`kept ${kept.length} of ${all.length} rows; expected under half`);
        return `${all.length} rows → ${kept.length}, Fonts kept`;
      } finally { await close(w); }
    },
  },
};

// ── runner ────────────────────────────────────────────────────────────────────

const names = only.length ? only : Object.keys(cases).filter((n) => paid || !cases[n]!.paid);
const unknown = names.filter((n) => !cases[n]);
if (unknown.length) { console.error(`unknown case(s): ${unknown.join(", ")}; have: ${Object.keys(cases).join(", ")}`); process.exit(2); }

let failed = 0;
for (const name of names) {
  const t0 = performance.now();
  try {
    const note = await cases[name]!.run();
    console.log(`● ${name.padEnd(16)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${note}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name.padEnd(16)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${(e as Error).message}`);
  }
}
console.log(`${names.length - failed}/${names.length} passed on ${host}`);
process.exit(failed ? 1 : 0);
