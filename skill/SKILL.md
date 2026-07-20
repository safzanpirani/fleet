---
name: fleet
description: Run commands, launch detached background jobs, restart services, push files, screenshot desktops, and read live status across a fleet of machines (Linux, Windows, and Mac boxes) over SSH with zero quoting pain, via the `fleet` CLI or its MCP server. Use when the user wants to exec/run something on one or many of their boxes, spawn a long-running job that outlives the SSH session (and tail/wait/kill it), restart or tail logs for a service, copy a file to host(s), screenshot a remote machine, check fleet/host/GPU status or the status dashboard, register/use the fleet MCP server, or mentions fleet, @linux/@windows/@gpu, or "all my machines / servers".
---

# fleet

`fleet` is a global CLI (installed from the repo, on PATH via `bun link`) that drives a
whole machine fleet over SSH. Every exec is **quoting-proof**: `bash -ls` over
stdin on Linux, PowerShell `-EncodedCommand` on Windows — so **never escape anything**,
just pass the command. Prefer `fleet exec` over raw `ssh` for these boxes. The same
actions are also exposed as an **MCP server** (see below) for MCP clients/agents.

Host names, groups, and recipes come from `fleet.config.json`; the examples below use the
placeholder hosts from `fleet.config.example.json` (`web`, `gpu-box`, `win-box`, `vps`,
`laptop`) — substitute your own.

## Quick start

```sh
fleet ls                      # every host: reachability + configured services
fleet status                  # live CPU/mem/disk/gpu table (from the dashboard)
fleet exec win-box "nvidia-smi"
```

## Commands

| Command | Use |
|---|---|
| `fleet exec <sel> "<cmd>" [--cwd dir] [--wsl] [--raw] [--json]` | Run a command on host(s), **blocking** (returns exit code). `--cwd` runs in a dir and fails fast (exit 127) if it's missing; `--wsl` runs inside WSL on Windows boxes; `--raw` prints only remote stdout. |
| `fleet spawn <sel> "<cmd>" [--cwd dir] [--json]` | Launch a **detached** job that outlives the SSH session → returns a `host:id`. Fire-and-track (vs `exec`, which blocks). **Linux/mac only** for now; Windows errors with a clear stub message. |
| `fleet jobs [<sel>]` | List detached jobs across the fleet (running ● / exited ○ / dead ✗). |
| `fleet jobs log <host:id>` | Full captured output of a job. |
| `fleet jobs tail <host:id> [-n N] [-f]` | Last N lines; `-f` streams live (foreground until Ctrl-C). |
| `fleet jobs wait <host:id> [--until <regex>] [--timeout S]` | Block until the job exits (or its output matches `--until`). Scriptable exit code: job's own code on exit, `0` on match, `124` on timeout. |
| `fleet jobs kill <host:id>` | TERM the whole job process-group. |
| `fleet jobs prune [<sel>] [--all]` | Remove finished job spools (`--all` also drops dead ones; never touches running). |
| `fleet cp <local> <sel>:<remote>` | Copy a file to host(s); fan-out across a group. |
| `fleet shot <host> [--out f] [--grid] [--no-open]` | Screenshot the remote desktop → local image (webp default; `--grid` overlays a coord ruler). Alias: `fleet screenshot`. |
| `fleet cu <host> <args…> [--out f.png]` | Computer-use via [cua-driver](https://github.com/trycua/cua): `install`, or pass a tool + JSON (`click`, `type_text`, `get_window_state`…). |
| `fleet restart <host> <service>` | Restart a **configured** service (see config). |
| `fleet bios <sel> [--yes]` | Reboot Windows UEFI/systemd Linux hosts into firmware setup. |
| `fleet logs <host> <service> [-n N]` | Recent logs / status for a service. |
| `fleet gpu [--json]` | Every GPU: util · free VRAM · temp · loaded model. |
| `fleet disk [sel] [--json]` | Live free space on every mounted volume. |
| `fleet status [host] [--json]` | Live stats pulled from the dashboard API. |
| `fleet top <host>` | Live terminal btop for one host (interactive; runs until Ctrl-C). |
| `fleet run <recipe>` | Run a saved playbook from config (stops on first failure). |
| `fleet ssh <host>` | Interactive shell. |

## Selectors

Anywhere `<sel>` appears: a hostname, logical route, group, `all`, Daytona
`dt:<id|name|prefix>`, or a comma-mix (`vps,@gpu`). Groups: `@linux` `@windows`
`@mac` `@gpu`, plus custom ones from config (e.g. `@servers`).

## Critical rules

- **Don't escape commands.** `fleet exec vps 'echo "a & b | c"'` round-trips verbatim.
- **Command syntax is the target's native shell**: bash for Linux hosts, **PowerShell**
  for Windows hosts. So `fleet exec all "uptime"` works on Linux but fails on Windows
  (no native `uptime`). For cross-OS, pick portable commands or scope by group
  (`fleet exec @linux ...`).
- `restart`/`logs` need a service **defined in config** — run `fleet ls` to see each
  host's known services. Unknown name → it prints the valid ones.
- `fleet top` is a foreground live loop — only run it interactively, never to capture
  one-shot output (use `fleet status <host>` for that).
- A non-zero exit on any host makes `exec`/`cp` exit non-zero (good for scripting).
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
- **Linux/mac** launch via `setsid` (no privilege, survives disconnect).
- **Windows `spawn` is NOT yet implemented** — it needs Task Scheduler / a transient
  service with an *interactive* token so the job can see the GPU/OpenCL (session-0
  non-interactive tasks can't). It errors with that exact message until wired; don't
  promise Windows background jobs yet.
- `wait --until '<regex>'` returns as soon as output matches (e.g. detect an autotune /
  "Recovered.*1/1" marker) — beats `sleep`-and-hope. Plain `wait` blocks until exit and
  propagates the job's code, so `fleet jobs wait gpu-box:<id> && deploy` works.
- Typical flow: `fleet spawn gpu-box "./train.sh" --cwd /srv/app` → `fleet jobs` to find it
  → `fleet jobs tail gpu-box:<id> -f` or `fleet jobs wait gpu-box:<id> --until '<rx>'` →
  `fleet jobs prune` when done. **Not exposed over MCP yet** (CLI-only).

## Computer use (`fleet cu`)

`fleet cu <host> …` drives a host's desktop through **cua-driver** (trycua/cua) — a
self-contained binary that runs a background `serve` daemon in the interactive session
and exposes computer-use tools. Same interactive-desktop requirement as `fleet shot`
(a Windows box needs a real or virtual display + a logged-in session).

- **Install once per host:** `fleet cu <host> install` (runs the official installer +
  `autostart kick`; registers the `cua-driver-serve` autostart task). One-time UAC elevation
  on Windows for the RunLevel=Highest task.
- **Convenience verbs** (resolve the pid/window_id loop for you):
  - `fleet cu <host> apps [name]` — compact `pid  name` table (optional name filter).
  - `fleet cu <host> windows <pid|name>` — `window_id  title` table (name → pid auto-resolved).
  - `fleet cu <host> shot-window <pid|name> [--out f.png]` — resolve pid + first window +
    capture, in one call (auto-opens on Mac). This replaces the 3-step loop below.
- **Raw passthrough:** `fleet cu <host> <cua-driver args…>` for anything else:
  - `fleet cu win-box list-tools` — every tool + description (authoritative per version).
  - `fleet cu win-box get_screen_size` / `list_apps` / `list_windows '{"pid":3848}'`
  - `fleet cu win-box get_window_state '{"pid":3848,"window_id":66756,"capture_mode":"vision"}' --out win.png`
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
- `shot-window` resolves pid→window→capture in a **single remote round-trip** (~3s),
  not five. Plain `cu` calls are ~1.3s each.
- **`--grid` [--grid-step N]** overlays a labeled pixel-coordinate grid (default 100px) on
  any capture (`shot`, `cu --out`, `shot-window`) — read off x,y before a click, since cua
  coords are **window-local pixels**. Needs python3 + Pillow locally (best-effort).
- **JSON args:** pass the JSON as one arg; fleet pipes it via **stdin** (Windows
  PowerShell 5.1 strips quotes around JSON field names on native-command args — piping
  preserves them). `get_window_state` needs `window_id` (from `list_windows`); its image
  is base64 inside the JSON, but `--out` / `--screenshot-out-file` writes it to a file.
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
| `fleet_restart` | `host`, `service` | `fleet restart` |
| `fleet_logs` | `host`, `service`, `lines?` | `fleet logs` |
| `fleet_gpu` | — | `fleet gpu` |
| `fleet_disk` | `selector?` | `fleet disk [selector]` |
| `fleet_status` | `host?` | `fleet status` |
| `fleet_bios` | `selector` | `fleet bios <selector> --yes` |
| `fleet_run` | `recipe` | `fleet run` |

- `top` and `ssh` are **not** exposed — they need a live TTY. `spawn`/`jobs` are **not yet**
  exposed either (CLI-only for now).
- Same rules as the CLI: pass `command` verbatim (don't escape), syntax is the target's
  native shell, and `restart`/`logs` services must be config-defined.
- `fleet_restart` and `fleet_bios` are annotated `destructive`; `ls`/`logs`/`gpu`/`disk`/`status`/`screenshot` are
  `readOnly` (always registered, even with the kill-switch on).
  Host, group, and recipe names are baked into the tool descriptions, so an agent sees
  valid selectors without a round-trip.
- The CLI (`cli.ts`) and MCP server (`mcp.ts`) are both thin frontends over `src/core.ts`
  — one source of truth for the quoting-proof exec.

**Remote endpoint:** fleet can also be deployed as a public HTTP MCP server (Streamable
HTTP at `/mcp`, legacy SSE at `/sse`) for remote clients. It runs on one host as a service
(`src/http.ts`, `buildServer` from `src/server.ts`) behind a reverse proxy / tunnel, and is
**bearer-token gated** (`Authorization: Bearer <FLEET_MCP_TOKEN>`; the token lives only in
the service env). `FLEET_MCP_READONLY=1` is the kill-switch (drops exec/cp/restart/run).
The host it runs on is the SSH origin for the whole fleet. Build/run details are in
`DEPLOY.md`; `fleet restart <host> fleet-mcp` bounces it.

## Config & extending

Hosts, logical routes, groups, and recipes live in `fleet.config.json` (override path
with `FLEET_CONFIG`; copy `fleet.config.example.json` to start). A host has `ssh`, `os`,
optional `gpu`, `wsl`, `winShell`, and a `services` map; each service `type`
(`systemd` / `systemd-user` / `winservice` / `schtask`) decides how restart/logs run.
A route has an ordered `prefer` list of same-OS host entries.

## When NOT to use

For one-off work on the local machine, or hosts not in `fleet.config.json`, use plain
`ssh`/shell. `fleet` is for the configured fleet.
