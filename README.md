# fleet

One command to drive the whole fleet — run commands, restart services, check
status across every box — **without ever thinking about ssh/PowerShell/WSL
quoting**. Every exec goes over a quoting-proof primitive (`bash -ls` via stdin
on Linux/mac, PowerShell `-EncodedCommand` on Windows), so any command with
quotes, `$`, `&`, pipes, JSON, etc. round-trips verbatim.

## Install
```sh
cd ~/fleet
bun install
cp fleet.config.example.json fleet.config.json   # then edit for your own hosts
bun link            # puts `fleet` on your PATH
fleet ls
```
Or run without linking: `bun run src/cli.ts <cmd>`.

`fleet.config.json` is git-ignored, so your real host map never lands in git. If
it's absent, fleet falls back to the shipped `fleet.config.example.json` so the
commands still run against the placeholder hosts.

## Usage
```sh
fleet ls                            # reachability + services (◍ = ssh-down but health-URL ok)
fleet exec win-box "nvidia-smi"      # run on one host
fleet exec all "uptime"             # run on every host, in parallel
fleet exec --wsl web "uname -a"  # run inside WSL on a windows box
fleet exec --cwd /srv/app oracle "./build.sh"   # run in a dir; fails fast if missing
fleet exec --timeout 60 vps "slow-thing"        # wall-clock cap; a hung command exits 124
fleet spawn --cwd /srv/app oracle "./train.sh"  # detached job that outlives ssh -> job id
fleet jobs                          # every detached job across the fleet
fleet jobs tail oracle:mqtn19-9px -f# stream a job's output live
fleet jobs wait oracle:mqtn19-9px --until 'Recovered.*1/1'   # block until match (or exit)
fleet jobs kill oracle:mqtn19-9px   # signal the whole job process-group
fleet jobs prune                    # GC finished job spools
fleet cp -r ./dist oracle:~/dist    # copy a dir (recursive); pull with  cp oracle:~/f.log ./
fleet restart @linux cloudflared   # restart a configured service (fans out across the selector)
fleet svc cloudflared              # up/down of one service on every host that has it
fleet deploy gpu-box              # ship fleet source -> host, bun install, restart fleet-mcp
fleet status                        # live CPU/mem/disk/gpu from dash.example.com
fleet status vps                    # one host
fleet logs web cloudflared -n 50
fleet shot web                 # screenshot the remote desktop -> local PNG
fleet shot web --grid          # overlay a labeled pixel-coordinate grid (--grid-step N)
fleet cu web get_screen_size   # computer-use via cua-driver (install | click/type/...)
fleet cu web ... --grid        # same grid overlay on the cua capture, for click targeting
fleet doctor web               # diagnose why a host is unreachable (ssh -vv + health)
fleet completion zsh                # shell completion:  eval "$(fleet completion zsh)"
fleet ssh web                  # drop into an interactive shell
```

## Detached jobs
`exec` is **foreground**: it blocks, streams nothing, and returns the remote exit
code. `spawn` is **fire-and-track**: it launches a job that *outlives the SSH
session* and hands back a job id. The controller stays stateless — the only state
lives on the host, under a per-host spool (`~/.fleet/jobs/<id>/`: `cmd`, `cwd`,
`pid`, `out`, `exit`) — and every `jobs` verb is a thin read over the same
quoting-proof `exec`. Jobs are addressed as `host:id`.

```sh
fleet spawn --cwd /srv/app --label train oracle "long-running-thing"  # -> host:id, detaches
fleet jobs                              # list (running ● / exited ○ / dead ✗) across the fleet
fleet jobs log  oracle:<id>             # full output
fleet jobs tail oracle:<id> -n 40 -f    # last N lines, optionally follow live
fleet jobs wait oracle:<id> --until '<regex>' [--timeout S]   # block on match or exit
fleet jobs kill oracle:<id>             # kill the whole process tree (TERM, escalates to KILL)
fleet jobs prune [<sel>] [--all]        # remove finished spools (--all also drops dead)
```

`kill` sends SIGTERM to the process group, waits up to ~5s, escalates to SIGKILL
if needed, and only marks the job `exited` (sentinel code 143/137) once the
process is confirmed gone — a job that somehow survives is reported as an error
rather than silently mislabelled, so `prune` can never delete the spool out from
under a still-running job. (Windows uses `taskkill /T /F` + the same
confirm-then-sentinel dance.)

`wait` is scriptable: it exits with the job's own code on completion, `0` on a
`--until` match, `124` on timeout — so `fleet jobs wait oracle:<id> && deploy`
works. `--label` prefixes a readable slug onto the job id.

Works on **every OS**: Linux/mac launch via `setsid` (no privilege, survives
disconnect); **Windows** launches via a Scheduled Task with an *interactive*
logon principal, so the job lands in the logged-in console session and can see
the GPU/OpenCL — the task definition is unregistered once the runner records its
pid (the running instance survives), and `taskkill /T` reaps the tree. A Windows
job needs a user logged on at the console to host the interactive session.

## MCP server
The same fleet — same config, same quoting-proof exec, same selectors/recipes —
is also exposed as a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, so an agent can drive it as tools instead of a shell.

```sh
bun run src/mcp.ts            # or: bun run mcp   (FLEET_CONFIG honoured)
```

Register it with Claude Code:
```sh
claude mcp add fleet -- bun run ~/fleet/src/mcp.ts
```
…or in an MCP client config (`.mcp.json` / `claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "fleet": { "command": "bun", "args": ["run", "/path/to/fleet/src/mcp.ts"] }
  }
}
```

Tools: `fleet_ls`, `fleet_exec`, `fleet_cp`, `fleet_restart`, `fleet_logs`,
`fleet_svc`, `fleet_gpu`, `fleet_status`, `fleet_run`, `fleet_screenshot`,
`fleet_cu`, `fleet_spawn`, `fleet_jobs`, `fleet_job_log`, `fleet_job_kill`,
`fleet_reboot`, `fleet_boot`, `fleet_switch`. The interactive `top`/`ssh` commands and live job
`tail -f`/`wait` are intentionally **not** exposed — they need a live TTY / would
block. Mutating tools (`exec`/`cp`/`restart`/`spawn`/`job_kill`/`reboot`/`switch`/
`screenshot`/`cu`/`run`) vanish under the read-only kill-switch — `screenshot`
lives on that side because capturing executes commands on the host (and on
Windows registers a one-shot scheduled task). The read-only tools
(`ls`/`logs`/`svc`/`gpu`/`status`/`jobs`/`job_log`/`boot`) carry `readOnlyHint`.
`fleet_exec` takes an optional `timeout` (seconds) so a hung remote command
returns exit 124 instead of blocking the server. Host names, groups, and recipe names are baked into the tool
descriptions, so an agent sees valid selectors without a round-trip. Smoke-test
it end-to-end with `bun run scripts/smoke.ts`.

The tool set is defined once in `server.ts` (`buildServer`) and shared by the
stdio server (`mcp.ts`) and the remote HTTP server (`http.ts`). All of them —
plus the CLI (`cli.ts`) — are thin frontends over the `core.ts` action layer, so
the quoting-proof shell construction lives in exactly one place.

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
- Register in an MCP client with URL `https://fleet.example.com/mcp` (or `/sse`) and the
  token as the API key. Smoke-test locally with `bun run scripts/smoke-http.ts`
  (and `FLEET_MCP_READONLY=1 bun run scripts/smoke-http.ts` for the kill-switch).

## Config — `fleet.config.json`
Each host: `ssh` alias, `os` (`linux|windows|mac`), optional `wsl` distro, and a
`services` map. Service `type` controls how `restart`/`logs` work:

| type | restart | logs |
|---|---|---|
| `systemd` | `sudo systemctl restart` | `journalctl -u` |
| `winservice` / `nssm` | `Restart-Service` | `Get-Service … \| Format-List` |
| `schtask` | `schtasks /End` + `/Run` | `schtasks /Query /V` |

The config is **validated at load** — unknown OSes, bad service types, groups or
machine boots that reference non-existent hosts, and malformed recipes all fail
fast with the offending key named (a typo'd group member must error, not
silently shrink a `reboot @group` fan-out). Group members are also re-checked at
resolve time.

Override the config path with `FLEET_CONFIG=/path/to.json`. Keep a personal,
git-ignored `fleet.config.local.json` if you don't want hosts in git.

### Environment variables
| var | effect |
|---|---|
| `FLEET_CONFIG` | alternate config path |
| `FLEET_EXEC_TIMEOUT` | default wall-clock cap (seconds) for every exec; per-call `--timeout` / MCP `timeout` wins. Unset/0 = no cap |
| `FLEET_PROBE_TIMEOUT_MS` | reachability-probe cap (default 4000) |
| `FLEET_WIN_SHELL` | force `pwsh` or `powershell` on Windows hosts (skips the auto-probe) |
| `FLEET_NO_SSH_MUX` | `1` disables SSH connection multiplexing. By default fleet reuses one master connection per host (`ControlMaster=auto`, `ControlPersist=60s`, sockets under `~/.fleet/ssh/`) so fan-outs and poll loops don't re-handshake; a wedged socket is fixed by this flag or `rm ~/.fleet/ssh/cm-*` |

## Why
The `ssh → PowerShell → wsl bash` path with nested quoting is a recurring pain.
`fleet` encapsulates it once — a base64/EncodedCommand round-trip generalised to
every machine, so no command has to survive multiple layers of quoting.

## Stack
Bun + strict TypeScript. The CLI itself has zero runtime deps; the MCP server
adds `@modelcontextprotocol/sdk` + `zod`. `bun run typecheck` to verify.
