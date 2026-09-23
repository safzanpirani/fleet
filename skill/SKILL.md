---
name: fleet
description: Run commands, launch detached background jobs, restart services, push files, screenshot desktops, and read live status across a fleet of machines (Linux, Windows, and Mac boxes) over SSH with zero quoting pain, via the `fleet` CLI or its MCP server. Use when the user wants to exec/run something on one or many of their boxes, spawn a long-running job that outlives the SSH session (and tail/wait/kill it), restart or tail logs for a service, copy a file to host(s), screenshot a remote machine, check fleet/host/GPU status or the status dashboard, register/use the fleet MCP server (Claude Code, Factory Droid, Codex), drive a remote desktop with `fleet cu`, or mentions fleet, @linux/@windows/@gpu, or "all my machines / servers".
---

# fleet

`fleet` is a global CLI (installed from the repo, on PATH via `bun link`) that drives a
whole machine fleet over SSH. Every exec is **quoting-proof**: `bash -ls` over
stdin on Linux and PowerShell `-Command -` over stdin on Windows — so **never escape anything**,
just pass the command. Prefer `fleet exec` over raw `ssh` for these boxes. The same
actions are also exposed as an **MCP server** (see below) for MCP clients/agents.

Host names, groups, and recipes come from `fleet.config.json`; the examples below use the
placeholder hosts from `fleet.config.example.json` (`web`, `gpu-box`, `win-box`, `vps`,
`laptop`) — substitute your own.

## Quick start

```sh
fleet ls                      # every host: reachability + configured services  (alias: fleet hosts)
fleet status                  # live CPU/mem/disk/gpu table (from the dashboard)
fleet exec win-box "nvidia-smi"
```

## Commands

| Command | Use |
|---|---|
| `fleet exec [--cwd dir] [--wsl] [--raw] [--json] <sel> "<cmd>"` | Run a command on host(s), **blocking** (returns exit code). `--cwd` expands a leading `~` and fails fast (exit 127) if the directory is missing. `--wsl` runs inside WSL on Windows boxes. `--raw` prints only remote stdout. |
| `fleet exec --script <file\|-> [--interp cmd] <sel>` | Run a local script file or stdin on host(s). Fleet infers file extensions and supported stdin shebangs. Untyped stdin requires `--interp`. |
| `fleet spawn [--wsl] [--cwd dir] [--json] <sel> "<cmd>"` | Launch a detached job that outlives the SSH session and returns a `host:id`. `--wsl` runs it under `bash -l` in a Windows box's WSL distro, so `> /tmp/x` lands in WSL. |
| `fleet jobs [<sel>]` | List detached jobs across the fleet (running ● / exited ○ / dead ✗). |
| `fleet jobs log <host:id>` | Full captured output of a job. |
| `fleet jobs tail <host:id> [-n N] [-f]` | Last N lines; `-f` streams live (foreground until Ctrl-C). |
| `fleet jobs wait <host:id> [--until <regex>] [--timeout S]` | Block until the job exits (or its output matches `--until`). Scriptable exit code: job's own code on exit, `0` on match, `124` on timeout. |
| `fleet jobs kill <host:id>` | TERM the verified job process tree and escalate against surviving descendants. |
| `fleet jobs prune [<sel>] [--all]` | Remove finished job spools (`--all` also drops dead ones; never touches running). |
| `fleet cp [-r] [--resume] <local> <sel>:<remote>` | Copy a file to host(s); fan-out across a group. `--resume` copies with rsync `--partial`, so rerunning after a drop continues the partial file (POSIX hosts only). A single-host copy on a terminal shows a progress meter. |
| `fleet edit <sel>:<path> --old S --new S` | Edit a remote file in place, reject ambiguous matches, and print the diff. `--old-file`/`--new-file <file or ->` read multi-line text from a file or stdin; fleet never unescapes `\n`. `--sudo` edits root-owned files through passwordless `sudo -n` (POSIX). |
| `fleet shot <host> [--out f] [--grid] [--no-open]` | Screenshot the remote desktop → local image (webp default; `--grid` overlays a coord ruler). Alias: `fleet screenshot`. |
| `fleet cu <host> <args…> [--out f.png]` | Computer-use via [cua-driver](https://github.com/trycua/cua): `install`, or pass a tool + JSON (`click`, `type_text`, `get_window_state`…). |
| `fleet cu <host> click\|key\|type\|act <target> …` | Verified input: resolves the target, sends an explicit `window_id`, reports `changed` / `no_change` / `indeterminate`. |
| `fleet cu <host> windows [target]` · `shot-window <target>` | List windows (blockers flagged) or capture one, with owned popups composited in. |
| `fleet cu <host> elements <target> [filter]` · `verify <target> …` | List a window's controls with tokens (no screenshot), or check its state with `verify_state`. |
| `fleet cu <host> click\|set\|type <target> --label TEXT` · `menu <target> <item…>` | Act on a control by label or `--element TOKEN` instead of x,y; invoke a native menu path. |
| `fleet restart <host> <service>` | Restart a **configured** service (see config). |
| `fleet bios <sel> [--yes]` | Reboot Windows UEFI/systemd Linux hosts into firmware setup. |
| `fleet logs <host> <service> [-n N]` | Recent logs / status for a service. |
| `fleet gpu [--json]` | Every GPU: util · free VRAM · temp · loaded model. |
| `fleet disk [sel] [--json]` | Live free space on every mounted volume. |
| `fleet status [host] [--json]` | Live stats pulled from the dashboard API. |
| `fleet top <host>` | Live terminal btop for one host (interactive; runs until Ctrl-C). |
| `fleet run <recipe>` | Run a saved playbook from config (stops on first failure). |
| `fleet proxy [list]` · `check [name…]` · `drop <sel>` | Configured proxies and what routes through each; probe each endpoint and re-run its `verify` fetch through it; close ssh control masters after a route change. `--proxy NAME\|URL` / `--no-proxy` override the route on any command (before the selector). |
| `fleet tools status [tool] [sel]` | Report stale CLI and skill installations. Use `tools sync` to ship source, a launcher, and paired skills. |
| `fleet ssh <host>` | Interactive shell. |

## Prefer the LAN entry over the Tailscale one

A machine can appear in `fleet.config.json` twice: once on the local network and once over
Tailscale. Reach for the LAN entry — tailnet traffic can leave the network and come back,
so copying anything large over the remote entry burns bandwidth for no gain.

Name them so the transport is obvious: the plain name for the LAN box and a `-ts` suffix
for its Tailscale twin (`lan-host` / `lan-host-ts`). `fleet ls` shows the ssh alias for
every host, and a `routes` entry (`{"prefer": ["lan-host", "lan-host-ts"]}`) falls back
to Tailscale automatically only when the LAN box does not answer. Dual-boot `machines`
probe LAN first too.

## Selectors

Anywhere `<sel>` appears: a hostname, logical route, group, `all`, Daytona
`dt:<id|name|prefix>`, or a comma-mix (`vps,@gpu`). Groups: `@linux` `@windows`
`@mac` `@gpu`, plus custom ones from config (e.g. `@servers`).

## Critical rules

- **Don't escape commands.** `fleet exec vps 'echo "a & b | c"'` round-trips verbatim.
- **Put Fleet flags before the selector.** Use `fleet exec web -- program --json` or the same separator with `spawn` to keep all following flags in the remote command.
- **Command syntax is the target's native shell**: bash for Linux hosts, **PowerShell**
  for Windows hosts. So `fleet exec all "uptime"` works on Linux but fails on Windows
  (no native `uptime`). For cross-OS, pick portable commands or scope by group
  (`fleet exec @linux ...`).
- `restart`/`logs` need a service **defined in config** — run `fleet ls` to see each
  host's known services. Unknown name → it prints the valid ones.
- `fleet top` is a foreground live loop — only run it interactively, never to capture
  one-shot output (use `fleet status <host>` for that).
- A non-zero exit on any host makes `exec`/`cp` exit non-zero (good for scripting).
- **Use `--script` for stdin programs and quote-heavy PowerShell.** Fleet accepts a supported shebang or an explicit `--interp`. It rejects untyped stdin.
- **Use real newlines with `fleet edit`.** The CLI preserves argument bytes and does not translate the characters `\\n`. A leading `~` in Unix edit paths expands safely.
- **Sync paired skills to every agent root.** `fleet tools sync` installs `SKILL.md` under `~/.claude/skills`, `~/.agents/skills`, and `~/.openclaw/skills`.
- **Windows shell:** fleet uses a host's configured `winShell` (`pwsh` or `powershell`)
  without an extra discovery round-trip. When omitted, it auto-prefers **PowerShell 7
  (`pwsh`)** and falls back to Windows PowerShell 5.1. Override every host with
  `FLEET_WIN_SHELL=powershell|pwsh`.
- **Screenshots default to WebP** (lossless, crisp text, smaller) when `cwebp` is on the
  local machine; otherwise PNG. Pass `--out foo.png` to force PNG. Applies to `shot` and
  `cu` image pulls.
- `fleet shot` needs a **logged-in interactive session** to capture a real desktop.
  On Windows it hops into the user session via a one-shot `schtasks /IT` task (sshd runs
  in session 0 with no desktop), so a direct grab would otherwise be blank. A **headless**
  box with no monitor returns black 800×600 unless it has a virtual display (a Virtual
  Display Driver pinned to a resolution). Nothing can capture when no user is logged in
  (lock screen).

## Detached jobs (`fleet spawn` / `fleet jobs`)

`exec` is **foreground** (blocks, returns the exit code). `spawn` is **fire-and-track**:
it launches a job that *outlives the SSH session* and hands back a `host:id`. Use `spawn`
for anything long-running (training runs, builds, 8h jobs) — never hold an `exec` /
harness-backgrounded SSH session open for it.

- **State lives on the host, not the controller**: a per-host spool `~/.fleet/jobs/<id>/`
  (`cmd`, `cwd`, `pid`, `out`, `exit`). Every `jobs` verb is a thin read over the same
  quoting-proof `exec`. Jobs are addressed as **`host:id`** (e.g. `gpu-box:mqtn19dk-96px`).
- **Linux** uses `setsid`, **macOS** uses `nohup`, and **Windows** uses an interactive Scheduled Task.
- Linux runners carry an ownership marker. The marker keeps a live job visible when its child process changes the runner command line.
- `jobs wait` retries brief SSH failures and spool-visibility delays. Three consecutive failures stop the waiter with the underlying error.
- `wait --until '<regex>'` returns as soon as output matches (e.g. detect an autotune /
  "Recovered.*1/1" marker) — beats `sleep`-and-hope. Plain `wait` blocks until exit and
  propagates the job's code, so `fleet jobs wait gpu-box:<id> && deploy` works.
- Typical flow: `fleet spawn --cwd /srv/app gpu-box "./train.sh"` → `fleet jobs` to find it
  → `fleet jobs tail gpu-box:<id> -f` or `fleet jobs wait gpu-box:<id> --until '<rx>'` →
  `fleet jobs prune` when done. MCP exposes bounded job waits and inspection; live tailing stays CLI-only.

## Exec behavior you can rely on

- **Exit codes are real on Windows.** A PowerShell program stops at its first terminating
  error (`throw`, a cmdlet under `-ErrorAction Stop`) and exits 1; a failing native command
  as the last statement reports its own code (`cmd /c exit 3` → 3). `exit N` above 1
  reports N through the kept-open session (below); only the one-shot fallback collapses it to 1.
- **Unicode survives both ways** on Windows: the program is shipped base64-encoded and
  output is UTF-8. Detached Windows jobs get `PYTHONUTF8=1`, so Python tools that print
  ✓ or emoji no longer die with a cp1252 codec error.
- **A remote command that runs ssh/scp itself, or leaves `cmd &` behind, no longer hangs**
  `fleet exec`. The script reports its own completion; fleet waits `FLEET_DONE_GRACE_MS`
  (default 1500) for output to drain, then returns with the reported exit code.
- **Windows exec reuses a kept-open pwsh.** After the first call to a Windows host, a
  background `fleet __win-session` process keeps one pwsh open over its own ssh
  connection, and later calls take ~50-250 ms instead of ~0.6 s. Each call runs in a
  child scope from the home directory, with environment variables restored after;
  `$global:` state and imported modules carry over. Each program runs as a script file,
  so `exit 7` reports 7 exactly (one-shot pwsh reports 1). A busy or unresponsive
  session falls back to a one-shot pwsh, a timeout restarts it, and it closes after 10 idle minutes
  (`FLEET_WIN_SESSION_IDLE_S`). `FLEET_WIN_SESSION=0` turns it off.
- **Commands that read stdin get an empty one.** Scripts arrive over stdin, so a
  command that reads stdin used to swallow the rest of the script. Now it sees EOF.
- **Output is plain text when piped** (no ANSI); `FORCE_COLOR=1` restores colour, and
  `| head` no longer crashes fleet with a stack trace.

## Computer use (`fleet cu`)

`fleet cu <host> …` drives a host's desktop through **cua-driver** (trycua/cua) — a
self-contained binary that runs a background `serve` daemon in the interactive session
and exposes computer-use tools. Same interactive-desktop requirement as `fleet shot`
(a Windows box needs a real or virtual display + a logged-in session).

- **Install or update:** `fleet cu <selector> install` runs each host's official
  current-release installer. Windows registers the `cua-driver-serve` autostart task
  and runs `autostart kick`, with one-time UAC elevation for RunLevel=Highest.
  Linux creates and enables `cua-driver.service` when absent, with `DISPLAY=:0`,
  and preserves existing units. Adjust the unit for other displays. Download,
  installation, and service restart failures return a non-zero exit.
- **Target by anything.** Every verb takes a pid, a process name (with or without
  `.exe`), an app display name, or a window title. One resolver serves all of them,
  and it reports which identity matched.
- **Controls before pixels.** Read a window's controls, act on them by name, and check the
  result by state. None of it needs a screenshot, and it works on a background window:
  - `fleet cu win-box elements charmap [filter] [--role Button] [--json]` lists each
    control's `element_token`, role, label, value, actions (`invoke`, `set_value`,
    `toggle`, `expand`…), and its center in window-local pixels as a fallback.
  - `fleet cu win-box click charmap --label "Advanced view"` · `set charmap "text" --label
    "Characters to copy"` · `type <target> "text" --label Search` · `key`/`scroll`/`hotkey`/`act`
    take the same `--label TEXT [--role R] [--nth N]` or `--element TOKEN` in place of x,y.
    An exact label beats a substring. An ambiguous label is refused with every candidate's
    token listed.
  - `fleet cu win-box menu notepad File "Save As..."` invokes a native menu path through
    accessibility. It never falls back to pixels.
  - `fleet cu win-box verify charmap --label "Search for"` or `verify <target>
    '[{"element":{"selector":{"role":"Edit"},"exists":true,"value_equals":"x"}}]'` runs
    `verify_state`: `satisfied` exits 0, while `unsatisfied` and `unknown` exit 1. Prefer it
    over the pixel `effect` whenever the outcome shows up in the tree: a blinking caret
    makes the pixel check report `indeterminate`.
  - `fleet cu win-box open explorer 'C:\Windows'`, `open notepad`, or `open https://bun.sh`
    (default browser) launches through `launch_app` and prints the window to address next.
    MCP: `fleet_cu_open`.
  - `fleet cu win-box elements "<title>" --task "open the Fonts folder"` hides the controls a
    TypeSafe Jev judge is confident the task does not need: Explorer at `C:\Windows` went
    from 295 rows to 18 with Fonts kept, in ~1.6 s. It needs `TYPESAFE_API_KEY` (or a JSON
    file with `apiKey` named by `FLEET_JEV_CONFIG`), runs only past 30 rows, and fails open.
    Each use is a paid Jev call. MCP: `fleet_cu_elements` `task`.
  - MCP: `fleet_cu_elements`, `fleet_cu_open`, `fleet_cu_verify`, and `fleet_cu_act` with
    `element: {token | label, role?, nth?}`.
  - cua-driver's CLI exits 0 even when it refuses. Raw `fleet cu <host> <tool> <json>`
    exits 1 with `fleet: the driver reported …` when the reply is a refusal, `isError`, a
    failed delivery, or a lookup code such as `window_id_not_found`. A plain-text error
    (Windows prints some that way) still exits 0, so read the reply.
  - A token from one call stays valid in the next (the daemon keeps the cache) until a
    new tree read of that window replaces it.
  - A reply with `escalation.reason: delivery_failed` means the app dropped the
    background input. Fleet fails the action; retry with `--foreground` (it takes focus).
    Windows 11 Notepad and Electron apps ignore background input; classic Win32 controls
    (Character Map, most dialogs) accept it.
- **Convenience verbs** (resolve the pid/window_id loop for you):
  - `fleet cu <host> apps [name]` — compact `pid  name` table (optional name filter).
  - `fleet cu <host> windows [target]` — every top-level window, or one process's
    windows with the one Fleet targets marked and anything **above** it flagged.
  - `fleet cu <host> shot-window <target> [--out f.png] [--grid] [--probe X,Y]` —
    resolve target + window + capture in one call (auto-opens on Mac).
- **Verified input** — `click`, `key`, `type`, and generic `act` resolve the target,
  send an explicit `window_id`, and report what the window's pixels **actually did**:
  - `fleet cu win-box click firefox 166 447` → `● changed` / `○ no_change` / `? indeterminate`
  - `fleet cu win-box key firefox escape` · `fleet cu win-box type firefox "hello"`
  - `fleet cu win-box act firefox <tool> '{…}'` for any other input tool
  - Flags: `--space window|screen`, `--button`, `--count`, `--foreground`,
    `--settle MS`, `--shot [--grid]` to pull the after-image.
  Fleet hashes the target before and after input. A differing pair requires a
  successful settling capture; failure reports `indeterminate`. Driver errors and
  missing requested images return failure. A title match selects that window,
  including dialogs. `act` JSON must omit `pid` and `window_id`; Fleet supplies
  them and validates `x,y`.
- **Traps that cost whole sessions.** The verbs above handle each one; they still bite
  raw passthrough:
  1. **Omitting `window_id` does not mean "the main window".** cua-driver targets the
     process's **frontmost** window instead — the modal dialog whenever one is open — so
     window-local coordinates get anchored to the dialog's frame and the click lands
     somewhere unrelated, often in another application. With no `pid` either, `x,y` are
     desktop coordinates. Always send both.
  2. **`shot-window` alone can hide a blocker.** A window with a modal over it captures
     completely normally, and `windows <target>` reporting one window does not prove
     nothing else is up. Fleet composites owned popups onto the capture and prints
     `BLOCKED? …` naming them. For anything it cannot see — another app's overlay, a
     system dialog — verify with a full `fleet shot <host>`, not `shot-window`.
  3. **`effect: "unverifiable"` is not a result.** cua-driver returns it for successful
     input, for input that silently no-ops, and for hotkeys alike. Infer nothing from it;
     read Fleet's `changed` / `no_change` verdict instead.
  4. **On Windows, `window_id` is a real HWND you cannot use over ssh.** Window handles
     are per-session, and the ssh shell runs in session 0 while the desktop is session 1,
     so `IsWindow()` from `fleet exec` returns false on a perfectly valid handle. Drive
     the window through cua-driver, or run user32 calls inside the interactive session.
  5. **Launching a GUI app over ssh puts it in session 0, with no window.** cua-driver
     will never see it. Relaunch it in the interactive session — on Windows,
     `schtasks /create /sc once /ru <user> /it /rl LIMITED …` then `schtasks /run`.
     `/rl LIMITED` is not optional: without it the app runs elevated, which makes some
     apps throw a modal that blocks all input, and anything it launches inherits admin.
- **Coordinates survive only until the next capture of the same pid.** cua-driver stores
  its downscale ratio per **pid**, not per window, and rescales every incoming `x,y` by
  whatever the last capture set. Read coordinates off the most recent capture of the
  window you are clicking. The verbs capture immediately before acting; a hand-rolled
  sequence of raw `cu` calls does not.
- **Empty accessibility trees.** `get_window_state` on a WPF/canvas/custom-drawn window
  returns `degraded: true`, `element_count: 0` — and still ships its whole envelope,
  megabytes of it. Fleet collapses that to the diagnostic plus "use pixels"; `--full`
  restores the raw body. `element_index` cannot resolve at all on such a window, so the
  tool's own "prefer element_index" advice does not apply:
  `fleet cu <host> describe click --brief --for <target>` probes the real window and says
  which addressing mode actually works.
- **cua-driver 0.28:** `get_window_state` accepts `include_screenshot:false` for a
  tree-only read, `query` for a host-side projection, `include_accessibility_tree:false`
  for screenshot-only previews, and `max_dimension` for thumbnails. `capture_mode` is
  deprecated and ignored. `verify_state`, `invoke_menu`, `set_window_frame`, and `zoom`
  are new since 0.24.
- **Latency.** On Windows, a `cua-driver` CLI call whose output PowerShell captures or
  redirects costs ~600 ms more than one printing straight to ssh. Fleet leaves plain calls
  uncaptured and runs captures, actions, and batches through one
  `cua-driver mcp --socket \\.\pipe\cua-driver` session per script: it starts in ~180 ms,
  and each call inside it costs milliseconds. Images return base64-encoded in the same
  stdout, so a capture costs one round trip. Measured on a Windows host: a verified click
  went from ~4.6 s to ~2.9 s, and `shot-window` on a window with owned popups from ~10 s
  to ~3.8 s.
- **Driver traps worth knowing before raw calls:**
  - `move_cursor` with `scope:"desktop"` moves the user's REAL mouse pointer. Only
    `scope:"window"` (with `pid` and `window_id`) moves the agent overlay cursor.
  - The agent overlay moves only toward a screen point; accessibility input has none.
    Its default motion makes short glides loop; straight lines need `arc_size:0`,
    `arc_flow:0`, `turn_radius:0`, `spring:1`, `start_handle:0`, `end_handle:0`.
  - `set_window_frame` refuses a maximized window; restore it first.
  - Foreground input lands on whatever window is on top at that point. `bring_to_front`
    the target first; maximizing through accessibility does not raise a window.

### Complete raw computer-use command catalog

Every tool below uses `fleet cu <host> <tool> '<JSON>'`. Fleet also accepts the
explicit `fleet cu <host> call <tool> '<JSON>'` form to bypass named convenience
verbs. Read `fleet cu <host> describe <tool>` for the installed argument schema;
platforms differ, and the driver returns an error for unavailable operations.
`fleet cu <host> tools` is the live inventory. This catalog was checked on
2026-09-12 against the Windows 0.24.0 registry (57 tools) and the published
[macOS](https://cua.ai/docs/reference/cua-driver/mcp-tools),
[Linux](https://cua.ai/docs/reference/cua-driver/mcp-tools-linux), and
[Windows](https://cua.ai/docs/reference/cua-driver/mcp-tools-windows) registries
(61 distinct names across platforms). The final two rows are platform-specific.

| Function | Raw commands |
|---|---|
| Desktop and window inspection | `list_apps`, `list_windows`, `get_accessibility_tree`, `get_window_state`, `get_desktop_state`, `get_screen_size`, `get_cursor_position`, `zoom` |
| Pointer, keyboard, and editable values | `click`, `right_click`, `double_click`, `drag`, `scroll`, `press_key`, `hotkey`, `type_text`, `set_value`, `move_cursor` |
| Applications and window management | `launch_app`, `kill_app`, `bring_to_front`, `set_window_frame`, `invoke_menu` |
| Clipboard | `clipboard_read`, `clipboard_write` |
| Browser discovery and navigation | `get_browser_state`, `browser_prepare`, `browser_navigate` |
| Browser input, dialogs, and files | `browser_click`, `browser_type`, `browser_pointer`, `browser_dialog`, `browser_set_input_files`, `browser_download` |
| Browser compatibility | `page` |
| Post-action predicates | `verify_state` |
| Recording and replay | `start_recording`, `stop_recording`, `get_recording_state`, `replay_trajectory`, `install_ffmpeg` |
| Sessions | `start_session`, `get_session`, `list_sessions`, `end_session` |
| Legacy sessions | `escalate_session`, `get_session_state` |
| Agent cursor appearance and motion | `get_agent_cursor_state`, `set_agent_cursor_enabled`, `set_agent_cursor_motion`, `set_agent_cursor_theme` |
| Configuration and diagnostics | `get_config`, `set_config`, `check_permissions`, `health_report`, `check_for_update` |
| Windows diagnostics | `debug_window_info` |
| Linux held-button and multi-pointer gestures | `mouse_button_down`, `mouse_drag`, `mouse_button_up`, `parallel_mouse_drag` |

Raw calls retain the driver's semantics. In window scope, `move_cursor` moves the
agent overlay; it does not establish a general hover guarantee. `set_window_frame`
is the direct geometry command for moving/resizing windows. Linux's held-button
commands expose lower-level drag control; finish a held gesture with
`mouse_button_up`. Use `browser_pointer` for browser hover/scroll/drag.

Accessibility calls require current `element_token` or `element_index` plus
`snapshot_id`, as described by the installed tool. Observe again after a layout
change; do not guess or reuse stale handles. Raw desktop input uses `scope:desktop`
or the driver's explicit desktop `target`; named Fleet inputs keep one window.
Cua does not currently expose Codex Sky's separate `paste`, `select_text`, or
`perform_secondary_action` names. Clipboard writing, `set_value`, menu invocation,
and supported click actions provide related operations with different contracts.

Other raw CLI commands are available through `fleet cu <host> <command> …`:
`--version`, `list-tools`, `describe`, `call`, `status`, `stop`, `serve`, `mcp`,
`mcp-config`, `config`, `recording`, `autostart`, and the installed version's
`permissions`, `telemetry`, `cursor-theme`, `skills`, `channel`, `check-update`,
`update`, `doctor`, `diagnose`, `revoke`, `manifest`, and `dump-docs` commands.
Use the installed command's help for its exact subcommands. `serve` and `mcp`
are long-lived processes; Fleet's ordinary tool calls use an existing daemon.
For Fleet-managed recording, use `record start|stop|status` so output persists
across short-lived CLI invocations. Raw `recording render` converts an existing
trajectory to video. See the [driver CLI reference](https://cua.ai/docs/reference/cua-driver/cli-reference).

### Named controls and batches

```sh
fleet cu win-box right-click "Example App" 120 80
fleet cu win-box double-click "Example App" 120 80
fleet cu win-box drag "Example App" 120 80 400 240 --duration 500
fleet cu win-box scroll "Example App" down 2 --by page
fleet cu win-box hotkey "Example App" ctrl a
fleet cu win-box batch "Example App" --file actions.json --shot --json
```

The drag endpoints and `x,y` are screenshot pixels in the full target window.
`--space screen` converts desktop coordinates. `act` JSON must omit `pid`,
`window_id`, `target`, and `from_zoom`; Fleet sets the target and validates every
coordinate pair. Raw drag/scroll/hotkey/click JSON calls remain passthroughs.
Named inputs support `--json`, `--settle MS`, `--shot`, and `--foreground`.
Use background delivery first; select foreground only when the result calls for it.

An `actions.json` file contains an ordered array:

```json
[
  {"tool":"click","args":{"x":120,"y":80}},
  {"tool":"type_text","args":{"text":"example text"}},
  {"tool":"press_key","args":{"key":"Tab"},"delayMs":100},
  {"tool":"scroll","args":{"direction":"down","amount":2,"by":"page"}}
]
```

The array may also be one quoted argument, or stdin with `batch <target> -`.
Batch tools: `click`, `right_click`, `double_click`, `drag`, `scroll`, `press_key`,
`hotkey`, `type_text`, `set_value`, and `invoke_menu`. Other driver operations use
raw calls. A batch shares one fixed window and one coordinate frame. Target
resolution happens once, followed by one remote execution for the sequence and
its before/after captures. Image transfer adds a copy and cleanup when requested.
The MCP equivalent is `fleet_cu_batch`, which returns the final image by default.

All coordinates are checked before any input. A nonzero driver exit, structured
refusal, or delivery-failure escalation stops the batch. Linux and macOS batches
require `python3` on the target to inspect JSON replies; Windows uses PowerShell.
Each step reports `completed`, `failed`, `not_run`, or `unconfirmed` with
its driver output. `completed` confirms the driver's exit, not the application's
effect. The pixel verdict describes the whole batch; it cannot prove every step.
A transport failure never triggers a replay. Inspect the desktop before issuing
more input after `unconfirmed`. Use a new observation before actions that depend
on a newly opened dialog, changed layout, or moved/resized window. Keep such
transitions at the end of a batch, then re-resolve the next target.

Limits: 100 actions, 256 KiB of input JSON, 10 seconds per `delayMs`, and 60 seconds
of total explicit delay. Each step may override `space` with `window` or `screen`.
Only batch completion is observed; do not batch steps that need model decisions
between them. This provides the same act-several-times-then-observe workflow as
Codex's native computer-use API, over Fleet's remote transport.

### Raw examples and operational contracts

- **Raw passthrough:** `fleet cu <host> <cua-driver args…>` for anything else:
  - `fleet cu win-box list-tools` — every tool + description (authoritative per version).
  - `fleet cu win-box get_screen_size` / `list_apps` / `list_windows '{"pid":3848}'`
  - `fleet cu win-box get_window_state '{"pid":3848,"window_id":66756,"include_accessibility_tree":false}' --out win.png`
  - `fleet cu win-box click '{"pid":3848,"window_id":66756,"x":100,"y":200}'`
  - `fleet cu win-box type_text '{"text":"hello"}'` · `press_key` · `scroll` · `move_cursor`
  - `fleet cu win-box hotkey '{"pid":3848,"window_id":66756,"keys":["alt","f4"]}'` (close window)
  - `fleet cu win-box kill_app '{"pid":3848}'` (quit an app entirely)
- **Manual loop** (what the verbs automate): `list_apps` → `list_windows {pid}` →
  `get_window_state {pid,window_id}` (perceive; `--out` pulls the window PNG) →
  `click`/`type_text` (act). Coords are **window-local** screenshot pixels, not global.
- An image is pulled back **only when `--out` is passed** (or via the `shot-window` verb);
  if a call errors, cua-driver's own message is surfaced (e.g. "Missing window_id — use
  list_windows"), not a misleading scp error.
- `shot-window` reads the desktop snapshot, captures the selected windows, then
  transfers and cleans up images. Raw `click {JSON}` bypasses Fleet target
  resolution, coordinate checks, and effect verification.
- **`--grid` [--grid-step N]** overlays a labeled pixel-coordinate grid (default 100px) on
  any capture (`shot`, `cu --out`, `shot-window`) — read off x,y before a click, since cua
  coords are **window-local pixels**. On `shot-window` the image also carries a caption
  strip stating the exact frame (`pid`, `window_id`, origin, and the capture's own size),
  a red banner when something owns a window above the target, minor ticks every 25px for
  small toolbar icons, `x,y` labels at interior crossings, and line/label colours picked
  per segment from the underlying luminance so saturated artwork stays readable.
  Needs python3 + Pillow locally (best-effort).
- **`--probe X,Y`** draws a crosshair where a click at those coordinates would land,
  resolved through the same conversion the click path uses — aim verification without
  clicking. **`--space window|screen`** says which frame `X,Y` are in; a point that
  resolves outside the target window is refused rather than delivered to whatever is
  underneath it there.
- **JSON args:** pass the JSON as one arg; fleet pipes it via **stdin** (Windows
  PowerShell 5.1 strips quotes around JSON field names on native-command args — piping
  preserves them). `get_window_state` needs `window_id` (from `list_windows`); its image
  is base64 inside the JSON. Fleet's `--out` sets cua-driver's `screenshot_out_file`
  JSON field and pulls the resulting image locally.
- Exposed as MCP tool `fleet_cu` (`{host, args[], image?}`; returns the PNG when `image:true`).

## MCP server

fleet is also a stdio **MCP server** (`src/mcp.ts`, bin `fleet-mcp`) — same config, exec,
selectors, and recipes, exposed as tools. Use it when an MCP client/agent should drive the
fleet as tools instead of shelling out to the CLI. Register with Claude Code:

```sh
claude mcp add fleet -- bun run /path/to/fleet/src/mcp.ts
```

Run standalone with `bun run mcp` (honours `FLEET_CONFIG`); smoke-test end-to-end with
`bun run scripts/smoke.ts`.

| Tool | Args | CLI equivalent |
|---|---|---|
| `fleet_ls` | — | `fleet ls` |
| `fleet_exec` | `selector`, `command`, `wsl?` | `fleet exec` |
| `fleet_cp` | `local`, `selector`, `remote` | `fleet cp` |
| `fleet_screenshot` | `host` | `fleet shot` (returns the PNG as an image) |
| `fleet_cu` | `host`, `args[]`, `image?` | `fleet cu` (computer-use; returns PNG when `image`) |
| `fleet_cu_act` | `host`, `app`, `tool`, `x?`, `y?`, `space?` | verified input; returns `changed` / `no_change` / `indeterminate` |
| `fleet_restart` | `host`, `service` | `fleet restart` |
| `fleet_logs` | `host`, `service`, `lines?` | `fleet logs` |
| `fleet_gpu` | — | `fleet gpu` |
| `fleet_disk` | `selector?` | `fleet disk [selector]` |
| `fleet_status` | `host?` | `fleet status` |
| `fleet_bios` | `selector` | `fleet bios <selector> --yes` |
| `fleet_run` | `recipe` | `fleet run` |

- `top`, `ssh`, and live `jobs tail -f` remain CLI-only. Detached jobs and bounded waits are available over MCP.
- Same rules as the CLI: pass `command` verbatim (don't escape), syntax is the target's
  native shell, and `restart`/`logs` services must be config-defined.
- `fleet_restart` and `fleet_bios` are annotated `destructive`; `ls`/`logs`/`gpu`/`disk`/`status` are
  `readOnly` where they only inspect state. Screenshot and computer-use tools execute on hosts and are hidden in read-only mode.
  Host, group, and recipe names are baked into the tool descriptions, so an agent sees
  valid selectors without a round-trip.
- The CLI (`cli.ts`) and MCP server (`mcp.ts`) are both thin frontends over `src/core.ts`
  — one source of truth for the quoting-proof exec.

**Remote endpoint:** fleet can also be deployed as a public HTTP MCP server (Streamable
HTTP at `/mcp`; legacy `/sse` returns 410) for remote clients. It runs on one host as a service
(`src/http.ts`, `buildServer` from `src/server.ts`) behind a reverse proxy / tunnel, and is
**bearer-token gated** (`Authorization: Bearer <FLEET_MCP_TOKEN>`; the token lives only in
the service env). `FLEET_MCP_READONLY=1` is the kill-switch (drops exec/cp/restart/run).
The host it runs on is the SSH origin for the whole fleet. Build/run details are in
`DEPLOY.md`; `fleet restart <host> fleet-mcp` bounces it.

## Proxied hosts (`proxy` / `fleet proxy`)

Some hosts must never see the controller's own IP. Give the host a `proxy` and **every**
transport is routed through it: `exec`, `spawn`/`jobs`, `cp`, `edit`, `restart`, `reboot`,
`deploy`, `tools sync`, the `ls`/`wait` probes, `doctor`, and interactive `fleet ssh`.

```sh
fleet proxy                    # what is configured, and which hosts ride each proxy
fleet proxy check              # is the endpoint alive; does `verify` still see the right exit IP
fleet proxy drop <sel>         # close the ssh control master after changing a route
fleet exec --proxy other <sel> 'echo $SSH_CLIENT'
fleet exec --no-proxy <sel> 'echo $SSH_CLIENT'      # the direct route, for comparison
```

Config lives under a top-level `proxies` map plus `"proxy": "<name>"` on a host (or
`defaultProxy` for a fleet-wide default). Resolution, first match wins: `--proxy` →
`FLEET_NO_PROXY=1` → `FLEET_PROXY` → `hosts.<h>.proxy` → `defaultProxy` → direct.

- **Verify by the source IP the remote sees**, not by "the command worked":
  `fleet exec <host> 'echo $SSH_CLIENT'` must report the proxy's exit IP.
- **After changing a host's proxy, run `fleet proxy drop <host>`.** A live control master
  keeps the old route until `ControlPersist` expires.
- **A dead proxy is not a dead host.** `fleet ls` shows `proxy down` and `fleet doctor`
  says which leg failed.
- **Never put credentials in the command line.** Use `passwordEnv` or `passwordFile`
  (chmod 600).
- **Daytona (`dt:`) hosts are HTTP, not ssh**, so a proxy configured for one is ignored.

## Config & extending

Hosts, logical routes, groups, and recipes live in `fleet.config.json` (override path
with `FLEET_CONFIG`; copy `fleet.config.example.json` to start). A host has `ssh`, `os`,
optional `gpu`, `wsl`, `winShell`, `proxy`, and a `services` map; each service `type`
(`systemd` / `systemd-user` / `winservice` / `schtask`) decides how restart/logs run.
A route has an ordered `prefer` list of same-OS host entries.

## When NOT to use

For one-off work on the local machine, or hosts not in `fleet.config.json`, use plain
`ssh`/shell. `fleet` is for the configured fleet.

## Validation and recovery contracts

- Help is static: `fleet help <command>` works without configuration or network access.
- Validate owned flags before dispatch. Value flags accept `--flag=value`; integer timeouts reject fractions. Remote command flags remain payload.
- `fleet edit` uses literal replacement text. Omit `--new` or pass `--new ""` to delete. A present flag without a value is an error. Use `--old=--flag` for option-looking text.
- Screenshot success requires a local PNG/WebP artifact. Failed transfers preserve existing output. Windows capture checks its interactive task's completion and errors.
- Save each job reference. An unconfirmed launch keeps its attempted ID and is never automatically retried. Inspect the spool before another submission.
- Wait deadlines stop observation, not jobs. Resume using the same job reference. CLI waits are unbounded by default; MCP waits require a finite timeout.
- `tools status` compares manifests, not the active launcher or later remote edits. Missing and unreachable targets fail status checks.
- Tool sync fingerprints and archives a copied snapshot with the same portable glob exclusions. Hashing retains one batch of up to 16 files per tool.
- `--no-skill` leaves a skipped paired skill stale. Existing manifests may need one resync after the fingerprint format update.
- Sync and deploy share a lock per installation directory and use unique archives. A timeout or disconnect retains the lock; inspect the operation before removing it or retrying.
- Daytona defaults to five minutes and requires positive explicit timeouts. `--timeout 0` only disables SSH execution deadlines.
- HTTP MCP limits request bodies to 16 MiB. Malformed JSON returns 400; oversized requests return 413.

- Exit records are published atomically. Empty or malformed records do not hide a live runner or allow pruning it. Linux and macOS cancellation tracks surviving descendants through TERM and KILL.
- Set `tools.<name>.compile` to `true` for native Bun executables on Linux/macOS. Sync builds, signs macOS candidates, and requires `--help` to succeed within ten seconds before replacing the launcher. Failed builds preserve the prior executable and manifest; source and skills may already be updated. Windows selections fail before syncing.
- `FLEET_CONFIG` takes precedence and fails if its file is absent. Source checkouts retain the example-config fallback. Missing-config diagnostics omit Bun embedded filesystem paths.
