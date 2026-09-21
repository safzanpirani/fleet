<h1><img src="assets/pulse.svg" width="28" height="28" align="center" alt="●" />&nbsp;fleet</h1>

**Run commands across all your machines without fighting SSH quoting.**

Fleet is a small CLI and MCP server for managing Linux, Windows, and macOS
machines from one place. Use it for a single command, a whole group, or every
machine at once.

![fleet in action](demo/fleet-demo.gif)

```sh
fleet exec win-box "nvidia-smi"  # one machine
fleet exec @linux "uptime"       # a group, in parallel
fleet status                     # the whole fleet at a glance
```

## Why Fleet?

- Commands containing quotes, pipes, `$`, JSON, and shell operators arrive intact.
- Logical routes can prefer a fast connection and fall back to another.
- Long-running jobs survive SSH disconnects and remain easy to inspect.
- The same operations are available to people through the CLI and agents through MCP.

Driving fleet from Claude Code, Codex, or another agent? Start with
**[Agent setup](#agent-setup)**.

## Quick start

Install [Bun](https://bun.sh), clone the repository, then:

```sh
cd ~/fleet
bun install
cp fleet.config.example.json fleet.config.json
# Edit fleet.config.json with your SSH hosts
bun link
fleet ls
```

Your real `fleet.config.json` is git-ignored, so host details stay local. Without
one, Fleet uses the safe placeholder configuration in
`fleet.config.example.json`.

Prefer not to link the command globally? Run it with
`bun run src/cli.ts <command>`.

## Usage
```sh
fleet ls                            # reachability + services (◍ = ssh-down but health-URL ok)
fleet hosts                         # alias for `fleet ls`
fleet exec win-box "nvidia-smi"      # run on one host
fleet exec windows-auto "hostname"  # resolve a logical route before dispatch
fleet exec all "uptime"             # run on every host, in parallel
fleet exec --wsl win-box "uname -a"  # run inside WSL on a windows box
fleet dt                            # list Daytona sandboxes (DAYTONA_API_KEY)
fleet exec --cwd /srv/app web "./build.sh"   # run in a dir; fails fast if missing
fleet exec --timeout 60 vps "slow-thing"        # wall-clock cap; a hung command exits 124
fleet spawn --cwd /srv/app web "./train.sh"  # detached job that outlives ssh -> job id
fleet jobs                          # every detached job across the fleet
fleet jobs tail web:mqtn19-9px -f # stream a job's output live
fleet jobs wait web:mqtn19-9px --until 'Recovered.*1/1'   # block until match (or exit)
fleet jobs kill web:mqtn19-9px   # signal the whole job process-group
fleet jobs prune                    # GC finished job spools
fleet cp -r ./dist web:~/dist    # copy a dir (recursive); pull with  cp web:~/f.log ./
fleet restart @linux cloudflared   # restart a configured service (fans out across the selector)
fleet bios windows-auto --yes      # reboot directly into UEFI/BIOS firmware setup
fleet svc cloudflared              # up/down of one service on every host that has it
fleet deploy gpu-box              # ship fleet source -> host, bun install, restart fleet-mcp
fleet status                        # live CPU/mem/disk/gpu from dash.example.com
fleet disk                          # live free space on every mounted volume
fleet status vps                    # one host
fleet logs web cloudflared -n 50
fleet shot web                 # screenshot the remote desktop -> local PNG
fleet shot web --grid          # overlay a labeled pixel-coordinate grid (--grid-step N)
fleet cu @windows install      # install cua-driver across a selector (computer use)
fleet cu web get_screen_size   # drive a desktop: click/type/read window state
fleet cu web ... --grid        # same grid overlay on the cua capture, for click targeting
fleet doctor web               # diagnose why a host is unreachable (ssh -vv + health)
fleet completion zsh                # shell completion:  eval "$(fleet completion zsh)"
fleet ssh web                  # drop into an interactive shell
```

`fleet bios` supports Windows UEFI and systemd Linux hosts. macOS entries in a
fan-out are reported as unsupported without blocking the other hosts. Firmware
that ignores the OS boot-to-firmware request may perform a normal reboot instead.

## Logical routes

A logical route chooses one concrete host entry from an ordered `prefer` list
before dispatching a command:

```json
{
  "routes": {
    "windows-auto": { "prefer": ["win-box"] }
  }
}
```

Fleet probes transports in order and never retries an already-dispatched command
on another transport, so a connection loss cannot execute a mutation twice.

## Daytona sandboxes (`dt:`)

Ephemeral Daytona sandboxes can use the normal exec/copy interface over Daytona's
REST toolbox API. Set `DAYTONA_API_KEY`, then address a sandbox by ID, name, or a
unique prefix:

```sh
fleet dt
fleet exec dt:spore-run42 "uname -a"
fleet exec --cwd /home/daytona/repo dt:spore- "git status"
fleet cp ./artifact.tgz dt:spore-:/home/daytona/artifact.tgz
```

Daytona targets are Linux-only. A command deadline maps to exit 124, and
recursive copy is not currently supported. Daytona uses a five-minute default
timeout. Set a positive `--timeout` to change it; explicit `--timeout 0` is
rejected for Daytona and only disables the cap for SSH.

## CLI validation and screenshots

Help works without configuration or network access: `fleet help exec`,
`fleet jobs --help`, and `fleet help tools`. Fleet validates its own flags before
contacting a host. Flags inside an opaque remote command remain command payload.
Value flags support `--flag=value`; integer timeouts reject fractional values.
`exec` and `spawn` accept `--` immediately after the selector. Everything after
that separator belongs to the remote command, including flags such as `--json`.

`fleet edit` treats replacement text literally, including `$&`. Omitting `--new`
or passing `--new ""` deletes the match. A present `--new` without a value fails.
Use `--old=--flag` for option-looking text. Edit diffs omit unchanged context and
return a content-free summary when line alignment exceeds its work limit.

Screenshot commands require a local PNG/WebP artifact before reporting success.
Transfers use temporary files and preserve existing output on failure. Windows
capture checks its interactive task's completion and error records, then removes
the task and temporary control files.

## Detached jobs

`jobs list` aliases the bare listing command; `jobs tail --lines N` aliases `-n N`.
Addressed commands accept both `host:id` and `host id`. Use `--json` for one JSON
result; live `tail --follow` cannot combine with `--json`.

Linux and macOS cancellation tracks descendant identities through TERM and KILL,
including children that survive their runner. Exit records are published atomically.
Empty or malformed records do not hide a live runner or permit pruning it.

Wait timeouts and Ctrl-C stop observation without cancelling the job. Resume
with the same reference. Unconfirmed launches retain their attempted ID and are
never retried automatically. Inspect their existing spool before resubmitting.

`exec` is **foreground**: it blocks, streams nothing, and returns the remote exit
code. `spawn` is **fire-and-track**: it launches a job that *outlives the SSH
session* and hands back a job id. The controller stays stateless — the only state
lives on the host, under a per-host spool (`~/.fleet/jobs/<id>/`: `cmd`, `cwd`,
`pid`, `out`, `exit`) — and every `jobs` verb is a thin read over the same
quoting-proof `exec`. Jobs are addressed as `host:id`.

```sh
fleet spawn --cwd /srv/app --label train web "long-running-thing"  # -> host:id, detaches
fleet jobs                              # list (running ● / exited ○ / dead ✗) across the fleet
fleet jobs log  web:<id>             # full output
fleet jobs tail web:<id> -n 40 -f    # last N lines, optionally follow live
fleet jobs wait web:<id> --until '<regex>' [--timeout S]   # block on match or exit
fleet jobs kill web:<id>             # kill the whole process tree (TERM, escalates to KILL)
fleet jobs prune [<sel>] [--all]        # remove finished spools (--all also drops dead)
```

`kill` verifies the runner before signalling its process tree. It sends TERM,
waits up to five seconds, then escalates against surviving tracked descendants.
It publishes a sentinel exit code only after those processes are gone. Windows
uses `taskkill /T /F` and confirms that the owned runner has stopped.

`wait` is scriptable: it exits with the job's own code on completion, `0` on a
`--until` match, `124` on timeout — so `fleet jobs wait web:<id> && deploy`
works. `--label` prefixes a readable slug onto the job id.

Works on **every OS**: Linux/mac launch via `setsid` (no privilege, survives
disconnect); **Windows** launches via a Scheduled Task with an *interactive*
logon principal, so the job lands in the logged-in console session and can see
the GPU/OpenCL — the task definition is unregistered once the runner records its
pid (the running instance survives), and `taskkill /T` reaps the tree. A Windows
job needs a user logged on at the console to host the interactive session.

## Computer use (`fleet cu`)

`fleet shot` gets you a picture of a remote desktop. `fleet cu` lets something
*act* on it — click, type, read window state — by driving
[cua-driver](https://github.com/trycua/cua) on the host: a self-contained binary
that runs a background `serve` daemon inside the interactive session and exposes
computer-use tools. Same requirement as `fleet shot`: a **logged-in interactive
desktop**. Nothing can drive a lock screen.

### Install it everywhere in one command

```sh
fleet cu <host> install         # one box
fleet cu @windows install       # a whole group, in parallel
fleet cu all install            # the entire fleet
```

Each selected host runs its OS's official current-release installer (`install.ps1`
on Windows, `install.sh` elsewhere). Re-run `install` to update. Windows registers
the autostart task and starts it with `autostart kick`; UAC elevation is required
once for RunLevel=Highest. Linux creates and enables a missing systemd user unit
with `DISPLAY=:0`, then restarts it. Existing units keep their display settings.
Adjust the unit if your desktop uses another display.

Fleet reports a result for each host and returns a non-zero exit if a download,
installation, or daemon restart fails.

Cua-driver 0.24 supports `include_accessibility_tree:false` for screenshot-only
window previews and `max_dimension` for thumbnails. Inspect the installed schema
with `fleet cu <host> describe get_window_state`, then pass these options as JSON.

### Driving a desktop

Every verb takes the same kind of target: a pid, a process name (with or without
`.exe`), an app display name, or a window title.

```sh
fleet cu web apps                       # pid + name table (optional name filter)
fleet cu web windows                    # every top-level window on the desktop
fleet cu web windows firefox            # one process's windows, blockers flagged
fleet cu web shot-window firefox --grid --out w.png
```

### Input you can trust

`click`, `key`, `type` and `act` resolve the target, address it explicitly, and
report what the window's pixels **actually did**:

```sh
fleet cu web click firefox 166 447      # ● changed / ○ no_change / ? indeterminate
fleet cu web key firefox escape
fleet cu web type firefox "hello"
fleet cu web act firefox scroll '{"direction":"down"}'
```

This exists because cua-driver's own `effect` field returns `"unverifiable"` for
input that worked and input that silently did nothing, alike. Fleet hashes the
window bitmap before and after the action instead, and takes a third capture when
they differ so a window that repaints on its own (a clock, a spinner, video) is
not reported as a false change. A failed settling capture reports `indeterminate`.
Driver errors and missing requested images return failure. A title match selects
that window, including dialogs. `act` JSON must omit `pid` and `window_id`; Fleet
supplies them and validates `x,y`. Raw `click {JSON}` remains a driver passthrough.

The immediate payoff: a background click that reports `no_change` tells you the
target's input stack dropped it, and `--foreground` is the fix — a decision that
otherwise costs a screenshot after every single action.

Shared flags: `--space window|screen`, `--button`, `--count`, `--foreground`,
`--settle MS`, and `--shot [--grid]` to pull the after-image.

Anything else passes straight through to cua-driver:

```sh
fleet cu web list-tools                 # authoritative tool list for the installed version
fleet cu web get_screen_size
fleet cu web click '{"pid":3848,"window_id":66756,"x":100,"y":200}'
```

- **Always send `window_id`.** Omitted, cua-driver targets the process's
  *frontmost* window — which is the modal dialog whenever one is open, so
  window-local coordinates get anchored to the dialog's frame and the click lands
  somewhere unrelated, often in another application. The verbs above always send
  it; raw passthrough is on you.
- **A capture of one window is not the whole truth.** A modal dialog over a window
  swallows all input while the window underneath still looks entirely normal.
  `shot-window` captures the process's owned popups too, composites them onto the
  result, and prints a `BLOCKED?` warning naming them. For anything it cannot see,
  verify with a full `fleet shot <host>`.
- **Coordinates are window-local pixels**, not screen-global. Add `--grid`
  (`--grid-step N`) to any capture for a labeled coordinate ruler; on
  `shot-window` the image also carries a caption strip stating the exact frame
  (pid, window_id, origin) the numbers are in. `--probe X,Y` draws a crosshair
  where a click would land without clicking, and a point that resolves outside the
  target window is refused rather than delivered to whatever is underneath it.
- **Empty accessibility trees.** `get_window_state` on a WPF, canvas or
  custom-drawn window returns `degraded: true, element_count: 0` and still ships
  its entire envelope — megabytes of nothing. Fleet collapses that to the
  diagnostic plus the fact the payload never states: element addressing is
  unavailable there, use pixels. `--full` restores the raw body, and
  `describe <tool> --brief --for <target>` probes the real window and drops the
  "prefer element_index" advice when that window has no tree to index.
- **JSON args are piped over stdin**, not passed as argv — Windows PowerShell 5.1
  strips the quotes around JSON field names on native-command args, and piping
  preserves them.
- An image comes back only when you pass `--out` (or use `shot-window`).
- Exposed to agents as `fleet_cu` (raw), `fleet_cu_act` (verified input),
  `fleet_cu_windows`, `fleet_cu_screenshot_window` and `fleet_cu_describe`;
  `args: ["install"]` fans out over a selector there too.

## Agent setup

Fleet is built to be driven by a coding agent as much as by a human. For most
setups that's two things: the **CLI** on PATH, and the **skill** that teaches the
agent when to reach for it. Steps 3 and 4 are optional.

**Prefer the CLI to the MCP server.** Any agent that can run shell commands can
already run `fleet` — one install serves every agent on the box, and each new
one works the day you install it with no extra wiring. Registering the MCP server
means a per-client config entry in Claude Code *and* Codex *and* Cursor *and* the
desktop app, each with its own file, syntax, and restart, all pointing at the
same binary the shell already has. That's N configs to keep in sync for
capability you get once from `bun link`. The CLI is also the fuller surface:
`top`, `ssh`, and `jobs tail -f` need a TTY and are deliberately absent from MCP.

Reach for MCP when the agent **can't** shell out — a sandboxed or remote client,
a hosted assistant — or when you specifically want tool-level gating, since
`FLEET_MCP_READONLY=1` can drop every mutating tool in a way a shell can't.

### 1. Install the CLI and describe your machines

```sh
git clone https://github.com/safzanpirani/fleet ~/fleet
cd ~/fleet && bun install && bun link
cp fleet.config.example.json fleet.config.json
$EDITOR fleet.config.json          # your ssh aliases, OSes, services, groups
fleet ls                           # every host should answer
```

Each host key is an **ssh alias**, so whatever `ssh <alias>` already does — keys,
jump hosts, Tailscale names — fleet inherits. Get `fleet ls` green before wiring
up any agent: everything below is a thin layer over the same config, and a host
that fails here fails there too.

Strongly recommended before an agent touches it:

```sh
fleet doctor <host>                # explains an unreachable host (ssh -vv + health)
fleet exec all 'echo ok'           # proves fan-out and auth on every box at once
```

### 2. Install the skill

An agent with the CLI on PATH still has to know it's there. The skill is what
tells it *when to reach for fleet at all* — without one, agents fall back to
hand-rolled `ssh host "…"` and rediscover the quoting problem fleet exists to
delete. This is the step that does the most work, and it applies whether or not
you register the MCP server.

`skill/SKILL.md` is a ready-made [Agent Skill](https://code.claude.com/docs/en/skills)
covering the commands, selector syntax (`host`, `a,b`, `@group`, `all`), the
quoting rules, the detached-jobs workflow, and the MCP tool names.

Install it straight from this repo with [`skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add safzanpirani/fleet -g        # user-level, every agent
npx skills add safzanpirani/fleet           # …or scoped to the current project
```

It installs as `fleet`; `--list` shows what's in the repo, `-a claude-code`
targets one agent, and `npx skills update fleet` pulls later changes. Prefer to
do it by hand? Copy the folder in:

```sh
cp -R ~/fleet/skill ~/.claude/skills/fleet
```

**Install it wherever the `fleet` CLI is reachable.** The skill is only useful to
an agent that can actually run `fleet` — so put it in every context you drive the
fleet from: your global agent config, any project whose agent does remote ops,
and, if you run agents *on* your boxes (a coding agent on the GPU machine, a
cloud session), the skill and a working `fleet` install belong on those too.
Installed where the CLI is missing, it just teaches the agent commands it can't
call.

Then edit the installed copy's frontmatter `description` to name **your** hosts
and groups. That line is what the agent matches against, so "run something on
gpu-box / all my servers" is far more likely to trigger it than the generic
wording shipped here.

### 3. Register the MCP server — only if you need it

Skip this if steps 1 and 2 already gave your agent what it needs. If a client
can't run shell commands, or you want the read-only kill-switch, the same config,
selectors, and quoting-proof exec are exposed over
[MCP](https://modelcontextprotocol.io) on stdio — register it per client:

```sh
bun run src/mcp.ts            # or: bun run mcp   (FLEET_CONFIG honoured)
```

**Claude Code**
```sh
claude mcp add fleet -- bun run ~/fleet/src/mcp.ts
```
**Any client that reads an MCP config** (`.mcp.json`, `claude_desktop_config.json`,
Cursor, Windsurf, Zed, …):
```json
{
  "mcpServers": {
    "fleet": { "command": "bun", "args": ["run", "/path/to/fleet/src/mcp.ts"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.fleet]
command = "bun"
args = ["run", "/path/to/fleet/src/mcp.ts"]
```

Use an **absolute path** — the server resolves `fleet.config.json` from the repo
root, and MCP clients rarely launch from a predictable cwd. To point one client
at a different fleet, add `"env": { "FLEET_CONFIG": "/path/to/other.json" }`.

Restart the client, then ask it to list tools; you should see 20 named `fleet_*`.

### 4. If the agent doesn't run on this machine

A cloud agent, a phone client, or a teammate's session can't spawn a local stdio
process. For those, run the [HTTP endpoint](#remote-mcp-endpoint-http) instead
and register `https://fleet.example.com/mcp` with the token as the API key. The
token is a root credential for every machine in the config — treat it that way,
and start read-only:

```sh
FLEET_MCP_READONLY=1 FLEET_MCP_TOKEN=<long-random> bun run serve
```

### 5. Optional: let the agent use a desktop

Everything above gives an agent a shell on your machines. If you also want it
clicking and typing in GUI apps, install [cua-driver](https://github.com/trycua/cua)
— one command, and a selector installs it everywhere at once:

```sh
fleet cu @windows install       # …or a single host, or `all`
```

Windows registers and starts an autostart task. Linux updates require an existing
`cua-driver.service` user unit. You get a result for each selected host.
See [Computer use](#computer-use-fleet-cu) for what the agent can then do
with it, and skip this entirely if your agents only need a shell.

### Give the agent room to work

Two habits make the difference between an agent that uses fleet well and one that
fights it:

- **Let it fan out.** `fleet exec @linux 'uptime'` is one call that runs in
  parallel; a loop over hosts is N calls and N round-trips. The selector is the
  parallelism.
- **Never let it sleep-poll.** For anything long-running, `fleet spawn` returns a
  job id immediately, and `fleet jobs wait <id> --until '<regex>'` blocks until
  the output matches — no blind `sleep 60`, no lost work when the SSH session
  drops. See [Detached jobs](#detached-jobs).

### Verify the whole path

```sh
fleet ls                                  # CLI → hosts
bun run scripts/smoke.ts                  # MCP stdio → tools → hosts
bun run scripts/smoke-http.ts             # HTTP transport + auth
FLEET_MCP_READONLY=1 bun run scripts/smoke-http.ts   # kill-switch drops mutating tools
```

Then ask the agent something it can only answer by actually calling out — *"how
much disk is free on every machine?"* — and confirm it comes back with your real
hosts rather than a plausible guess.

### MCP tools

All prefixed `fleet_`, grouped by access:

| Group | Tools |
|---|---|
| **Read-only** — carry `readOnlyHint`, always registered | `ls` · `logs` · `svc` · `gpu` · `disk` · `status` · `jobs` · `job_log` · `boot` |
| **Mutating** — dropped by the read-only kill-switch | `exec` · `cp` · `restart` · `spawn` · `job_kill` · `reboot` · `bios` · `switch` · `screenshot` · `cu` · `run` |
| **Not exposed** | `top` / `ssh` (need a live TTY) · job `tail -f` / `wait` (would block) |

- `screenshot` counts as **mutating** — capturing runs commands on the host (on Windows it registers a one-shot scheduled task).
- `exec` accepts an optional `timeout` (seconds); a hung remote command returns exit **124** instead of blocking the server.
- Host, group, and recipe names are **baked into the tool descriptions**, so an agent sees valid selectors without a round-trip.
- Smoke-test end-to-end: `bun run scripts/smoke.ts`.

The tool set is defined once in `server.ts` (`buildServer`) and shared by the
stdio server (`mcp.ts`) and the remote HTTP server (`http.ts`). All of them —
plus the CLI (`cli.ts`) — are thin frontends over the `core.ts` action layer, so
the quoting-proof shell construction lives in exactly one place.

### Computer-use controls and batches

`fleet cu` has named `click`, `right-click`, `double-click`, `drag`, `scroll`,
`hotkey`, `key`, and `type` commands. Use `act <target> <tool> <JSON>` for other
window input, or `<tool> <JSON>` for raw driver access. Drag endpoints and other
coordinates are checked against the selected window. `--space screen` translates
desktop coordinates; `--json` returns one structured result.

```sh
fleet cu web drag "Example App" 100 80 300 200 --duration 500
fleet cu web scroll "Example App" down 2 --by page
fleet cu web batch "Example App" '[{"tool":"click","args":{"x":100,"y":80}},{"tool":"type_text","args":{"text":"example"}}]' --shot --json
```

A batch targets one fixed window, executes ordered input on the host, and captures
before/after the whole sequence. Use `--file actions.json` or `-` for stdin. Each
entry has `tool`, optional `args`, optional coordinate `space`, and optional
`delayMs`. It stops on the first driver error or structured refusal without retrying.
Linux/macOS batches require `python3` on the target; Windows uses PowerShell.
Per-step status is
`completed`, `failed`, `not_run`, or `unconfirmed`; completion confirms driver exit,
not an application effect. Inspect the desktop after unconfirmed input. Observe
again between batches that open a dialog, move a window, or change the layout.

Limits are 100 actions, 256 KiB JSON, ten seconds per explicit delay and sixty
seconds total delay. The MCP tool `fleet_cu_batch` returns a final image by default.
Run `fleet cu <host> tools` and `describe <tool>` for the installed raw inventory
and schemas. The Fleet skill's Computer Use section catalogs every raw tool in
the published platform registries, including platform-specific controls.

## Remote MCP endpoint (HTTP)
For remote clients (e.g. Poke) the server also speaks **HTTP** — modern Streamable
HTTP at `POST /mcp` and legacy SSE at `GET /sse` + `POST /messages`. It is meant
to sit behind a Cloudflare tunnel at `https://fleet.example.com`.

```sh
FLEET_MCP_TOKEN=<long-random> bun run src/http.ts     # or: bun run serve
```

- **Auth is mandatory.** Every MCP request needs `Authorization: Bearer <FLEET_MCP_TOKEN>`
  (or `X-API-Key`); without it you get `401`. The token is effectively a root
  credential for the whole fleet — keep it long, random, and out of git. `GET /health`
  is the only unauthenticated route (returns just host count + read-only flag).
- **Kill-switch:** `FLEET_MCP_READONLY=1` drops every mutating tool (including
  `screenshot`/`cu`, which execute on the host) so only
  `ls`/`status`/`svc`/`gpu`/`logs`/`jobs`/`job_log`/`boot` are exposed.
- **Binding:** defaults to `127.0.0.1:8787` (`FLEET_MCP_HOST` / `FLEET_MCP_PORT`) —
  only the local cloudflared should reach it; the token is the public gate.
- Register in an MCP client with URL `https://fleet.example.com/mcp` and the
  token as the API key. Smoke-test locally with `bun run scripts/smoke-http.ts`
  (and `FLEET_MCP_READONLY=1 bun run scripts/smoke-http.ts` for the kill-switch).

## Config — `fleet.config.json`
Each host has an `ssh` alias, `os` (`linux|windows|mac`), optional `wsl` distro,
optional `winShell` (`pwsh|powershell`), and a `services` map. Configuring
`winShell` skips a shell-discovery round trip on every short-lived CLI process.
Top-level `routes` map logical names to ordered, same-OS host lists. Service
`type` controls how `restart`/`logs` work:

| type | restart | logs |
|---|---|---|
| `systemd` | `sudo systemctl restart` | `journalctl -u` |
| `systemd-user` | `systemctl --user restart` | `journalctl --user -u` |
| `winservice` / `nssm` | `Restart-Service` | `Get-Service … \| Format-List` |
| `schtask` | `schtasks /End` + `/Run` | `schtasks /Query /V` |

The config is **validated at load** — unknown OSes, bad service types, groups or
machine boots that reference non-existent hosts, and malformed recipes all fail
fast with the offending key named (a typo'd group member must error, not
silently shrink a `reboot @group` fan-out). Group members are also re-checked at
resolve time.

A source checkout also accepts `fleet.config.example.json` when its main config
is absent. Compiled binaries search beside the executable, then the user config
and deployed source directories. Missing-config errors list usable locations.
An explicit `FLEET_CONFIG` that does not exist fails without falling back.

Override the config path with `FLEET_CONFIG=/path/to.json`. Keep a personal,
git-ignored `fleet.config.local.json` if you don't want hosts in git.

### Environment variables
| var | effect |
|---|---|
| `FLEET_CONFIG` | alternate config path |
| `FLEET_SOURCE_ROOT` | source checkout for deployment from a compiled binary |
| `FLEET_EXEC_TIMEOUT` | default wall-clock cap in seconds; per-call timeout wins. Unset/0 disables the SSH cap; Daytona retains its five-minute default |
| `FLEET_PROBE_TIMEOUT_MS` | reachability-probe cap (default 4000) |
| `FLEET_WIN_SHELL` | force `pwsh` or `powershell` on every Windows host (overrides per-host `winShell`) |
| `FLEET_NO_SSH_MUX` | `1` disables SSH connection multiplexing. By default fleet reuses one master connection per host (`ControlMaster=auto`, `ControlPersist=60s`, sockets under `~/.fleet/ssh/`) so fan-outs and poll loops don't re-handshake; a wedged socket is fixed by this flag or `rm ~/.fleet/ssh/cm-*` |

## Why
The `ssh → PowerShell → wsl bash` path with nested quoting is a recurring pain.
`fleet` encapsulates it once through stdin-based shell transport, generalised to
every machine, so no command has to survive multiple layers of quoting.

## Stack
Bun + strict TypeScript. The CLI itself has zero runtime deps; the MCP server
adds `@modelcontextprotocol/sdk` + `zod`. `bun run typecheck` to verify.

## Tool synchronization and deployment

`fleet tools status [tool] [selector] --json` compares local fingerprints with
sync manifests. Missing, stale, or unreachable targets return exit 1. A current
manifest does not verify the active launcher or detect remote edits after sync.

Tool sync fingerprints and archives the same copied source snapshot. Portable
exclusion globs apply to both operations. Hashing retains one batch of up to 16
files per tool. Source and paired skill identities are separate: `--no-skill`
leaves a skipped skill stale. Existing manifests may require one resync after
this fingerprint format update.

Sync and Fleet deployment use unique archives and a shared lock per installation
directory. A timeout or disconnect retains the lock because installation may
still be running. Inspect the previous operation before removing its lock or
retrying. Overlay installations preserve runtime files; obsolete source files
are not automatically removed.

HTTP MCP request bodies are limited to 16 MiB. Malformed JSON returns 400 and
oversized bodies return 413. Authentication remains mandatory outside health.

Set `"compile": true` in a tool registry entry to build a native Bun executable
on Linux or macOS. Sync builds the configured entry on the target, signs and
verifies macOS candidates, and runs `--help` with a ten-second timeout before
replacing the launcher. Failed builds preserve the previous executable and
manifest; source and skill files may already have changed. Bun remains required
for later builds. Windows targets reject compiled mode before any host is synced.
Changing the compilation mode makes the previous manifest stale.

## Development checks

Run `bun run check` for TypeScript and the full test suite. `bun run build:local`
builds a native candidate, verifies its macOS code signature where applicable,
and runs help without configuration before replacing `dist/fleet-local`.
