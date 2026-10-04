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

Driving fleet from Claude Code, Factory Droid, Codex, or another agent? Start with
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
fleet exec --script ./deploy.sh web v2 --dry    # a local script; tokens after the host are its $1 $2
fleet exec --sudo web "systemctl restart nginx"  # as root; a sudo password comes from a 0600 file
fleet exec --fresh web "id -Gn"    # new ssh login (after usermod -aG); `fleet drop web` closes shared ones
# a timeout returns within a second and keeps the output printed so far
fleet spawn --cwd /srv/app web "./train.sh"  # detached job that outlives ssh -> job id
fleet jobs                          # every detached job across the fleet
fleet jobs tail web:mqtn19-9px -f # stream a job's output live
fleet jobs wait web:mqtn19-9px --until 'Recovered.*1/1'   # block until match (or exit)
fleet jobs kill web:mqtn19-9px   # signal the whole job process-group
fleet jobs prune                    # GC finished job spools
fleet cp -r ./dist web:~/dist    # copy a dir (recursive); pull with  cp web:~/f.log ./
fleet cp --resume big.tar web:~/   # rsync --partial: rerun after a drop to continue
fleet restart @linux cloudflared   # restart a configured service (fans out across the selector)
fleet bios windows-auto --yes      # reboot directly into UEFI/BIOS firmware setup
fleet svc cloudflared              # up/down of one service on every host that has it
fleet deploy gpu-box              # ship fleet source -> host, bun install, restart fleet-mcp
fleet status                        # live CPU/mem/disk/gpu from your status dashboard
fleet disk                          # live free space on every mounted volume
fleet ps web python --sort cpu     # processes, the same columns on every OS
fleet kill web 4242 --dry-run      # show the stop plan; --tree, --force, --all
fleet status vps                    # one host
fleet logs web cloudflared -n 50
fleet shot web                 # screenshot the remote desktop -> local PNG
fleet shot web --grid          # overlay a labeled pixel-coordinate grid (--grid-step N)
fleet shot web --output DP-1 --region top-right   # one monitor, or part of it (--list shows the layout)
fleet session web              # logged in, locked or at the login screen; idle time; displays on/off
fleet cu @windows install      # install cua-driver across a selector (computer use)
fleet cu web get_screen_size   # drive a desktop: click/type/read window state
fleet cu web ... --grid        # same grid overlay on the cua capture, for click targeting
fleet cu phone elements        # an Android phone's screen as a UI tree, no screenshot
fleet doctor web               # diagnose why a host is unreachable (ssh -vv + health)
fleet switch box --to linux --dry-run   # dual-boot: show the UEFI entry a switch would use
fleet find box --from web      # find a machine's LAN address by its MAC
fleet completion zsh                # shell completion:  eval "$(fleet completion zsh)"
fleet ssh web                  # drop into an interactive shell
```

`fleet bios` supports Windows UEFI and systemd Linux hosts. macOS entries in a
fan-out are reported as unsupported without blocking the other hosts. Firmware
that ignores the OS boot-to-firmware request may perform a normal reboot instead.

`fleet exec` never forwards your local stdin: the remote program travels on
ssh's stdin. A command that reads stdin (`bash -s`, `python3 -`, `cat > f`) with
a file or pipe on local stdin is refused; use `fleet exec --script - --interp bash
<host> < job.sh`. Commands that look like a reboot or power-off are refused
without `--confirm-reboot`; `fleet reboot` and `fleet switch` confirm and verify.

## Dual-boot machines

A `machines` entry names the host entries of each boot of one physical box.
`fleet boot box` says which boot is live, and `fleet switch box --to linux`
reboots into another one, printing each phase: which boot is live, the trigger,
the source going down, and the wait. On a timeout it names the boot that
answers instead.

```jsonc
"machines": { "box": {
  "mac": "02:00:00:aa:bb:cc",
  "boots": {
    "windows": { "host": "box-win-ts", "lan": "box-win", "firmware": "Windows Boot Manager" },
    "linux":   { "host": "box-linux-ts", "lan": "box-linux", "firmware": "Arch Linux" }
  },
  "switch": { "windows": { "linux": "sudo boot-windows" } }
} }
```

- Without a `switch` command for the live boot, fleet sets a one-time UEFI boot
  itself. It looks the target's `firmware` label up at switch time
  (`bcdedit /enum firmware` on Windows, `efibootmgr -v` on Linux), because entry
  ids change when entries are added or recreated. A missing label refuses before
  anything reboots; several entries with one label resolve to the earliest in
  boot order. `--dry-run` shows the chosen entry. A Linux source needs root.
- `fleet boot box --entries` lists the firmware entries and flags any on a
  partition other than the first EFI system partition, which some firmware drops.
- Boots share an address, so give each boot's host entries a `hostKeyAlias`.
  Fleet then checks host keys strictly under that name, and a probe of one boot
  cannot log in to another. `fleet hostkey <host> --pin` records the key the
  address serves now; it refuses a key whose ssh banner is the wrong OS or that
  another boot's alias already holds. `fleet doctor` warns about shared addresses
  without distinct aliases.
- A boot that comes up on a new DHCP address: `fleet find box` sweeps the local
  subnet and reads the ARP table for the machine's `mac`. Where the local ARP table
  is unreadable (recent macOS), pass `--from <linux host on the LAN>`.

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
contacting a host. They go before the selector or directly after it
(`fleet exec web --cwd /srv ls`); once the remote command starts, fleet reads no more
flags. A fleet flag at the end of the command, or one given twice, is refused. Value
flags support `--flag=value`; integer timeouts reject fractional values. `exec` and
`spawn` accept `--` after the selector, and everything after it belongs to the remote
command, including flags such as `--json`. An unquoted `--cwd ~/x` that the local
shell expanded to this machine's home is sent as `~/x`. `fleet push` and `fleet pull`
are aliases of `fleet cp`.

`exec --script` passes the tokens after the selector to the script: `$1…` in shells,
`$args` or `param()` in PowerShell, and argv for Python, Node, Bun and the rest. A
Windows command wrapped in `powershell -Command "…"` or `wsl bash -c "…"` gets a note:
fleet already runs PowerShell there, and the outer session expands `$variables` in the
double quotes first.

`fleet edit` treats replacement text literally, including `$&`. Omitting `--new`
or passing `--new ""` deletes the match. A present `--new` without a value fails.
Use `--old=--flag` for option-looking text. Edit diffs omit unchanged context and
return a content-free summary when line alignment exceeds its work limit. Fleet never turns the two
characters `\n` into a newline. Pass multi-line text with `--old-file` or
`--new-file`, which read a local file or `-` for stdin. In a file that uses CRLF
or LF throughout, newlines in `--old` and `--new` are converted to match it.
`--edits <file|->` takes a JSON array of `{"old", "new", "all"}` objects and
applies them in order to one file with a single read and write. If any edit
fails, nothing is written. A miss reports the likely cause by line number
(line endings, whitespace, letter case, or the first diverging line) without
quoting file content. `--sudo` edits a root-owned file through passwordless
`sudo -n` on POSIX hosts.

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

`exec` blocks, streams nothing and returns the remote exit code. `spawn` launches
a job that outlives the SSH session and returns a job id, addressed as `host:id`.
The controller keeps no state. Each host keeps its jobs in a spool at
`~/.fleet/jobs/<id>/` (`cmd`, `cwd`, `pid`, `out`, `exit`), and every `jobs` verb
reads that spool through the same `exec`.

```sh
fleet spawn --cwd /srv/app --label train web "long-running-thing"  # -> host:id, detaches
fleet spawn --wsl win-box "python3 job.py > /tmp/job.log"   # Windows host: runs inside WSL
fleet jobs                              # list (starting ○ / running ● / exited ○ / dead ✗) across the fleet
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

`wait` exits with the job's own code on completion, `0` on a `--until` match,
`124` on timeout, and `1` for a dead runner or an unconfirmed launch.
`--label` prefixes a readable slug onto the job id.

A spool without a PID or valid exit record has status `starting`. After a
120-second startup grace, three consecutive successful no-PID observations end
the wait with outcome `launch-unconfirmed` and CLI exit code `1`. The grace uses
the spool age when available; otherwise it starts at the first observation. The
scheduler may still start the job. Inspect the existing job before submitting
another launch. A valid exit record takes precedence over a missing PID.
Inspection failures reset the observation count. Polling never writes to the spool.

Jobs run on every OS. Linux launches them with `setsid`. macOS has no `setsid`,
so it uses `nohup`. Neither needs privilege, and both survive a disconnect.
Windows launches a Scheduled Task with an interactive logon principal, so the job
runs in the logged-in console session and can use the GPU and OpenCL. Fleet
unregisters the task once the runner records its pid; the running instance
survives, and `taskkill /T` stops its tree. A Windows job needs a user logged on
at the console.

## Computer use (`fleet cu`)

`fleet shot` captures a remote desktop. `fleet cu` clicks, types and reads window
state on it by driving [cua-driver](https://github.com/trycua/cua) on the host.
cua-driver is a self-contained binary that runs a `serve` daemon inside the
interactive session and exposes computer-use tools. Like `fleet shot`, it needs a
logged-in desktop; nothing can drive a lock screen.

### Install it everywhere in one command

```sh
fleet cu <host> install         # one box
fleet cu @windows install       # a whole group, in parallel
fleet cu all install            # the entire fleet
```

Each selected host runs its OS's official current-release installer (`install.ps1`
on Windows, `install.sh` elsewhere). Re-run `install` to update. Windows registers
the autostart task and starts it with `autostart kick`; UAC elevation is required
once for RunLevel=Highest. Linux creates and enables a missing systemd user unit,
then rewrites a `fleet-session.conf` drop-in and a start script on every install.
The start script finds the live Wayland socket and Hyprland instance at each
daemon start, since both change with every login, and turns on cua-driver's
Wayland backend. Before the compositor is up it exits 1, and systemd retries.

On a multi-monitor Hyprland or sway layout, cua-driver refuses desktop-wide
calls, so fleet answers `get_screen_size` and `get_desktop_state --out FILE` for
the main monitor from the compositor and its own capture. A desktop capture while
a monitor is powered off is refused at once instead of waiting for a frame that
never comes; `fleet shot --wake` switches such monitors on for the capture.

Fleet reports a result for each host and returns a non-zero exit if a download,
installation, or daemon restart fails.

Cua-driver 0.24 supports `include_accessibility_tree:false` for screenshot-only
window previews and `max_dimension` for thumbnails. Inspect the installed schema
with `fleet cu <host> describe get_window_state`, then pass these options as JSON.

### Driving a desktop

Every verb takes the same kind of target: a pid, a process name (with or without
`.exe`), an app display name, or a window title.

```sh
fleet cu web open firefox https://bun.sh   # launch an app and print its new window
fleet cu web apps                       # pid + name table (optional name filter)
fleet cu web windows                    # every top-level window on the desktop
fleet cu web windows firefox            # one process's windows, blockers flagged
fleet cu web shot-window firefox --grid --out w.png
```

`open` takes an app, an app plus a URL or path, or a bare URL for the default
browser. It waits (`--wait MS`) for a new top-level window and prints the title to
pass to every later verb. MCP: `fleet_cu_open`.

### Input you can trust

`click`, `key`, `type` and `act` resolve the target, address it explicitly, and
report what the window's pixels did:

```sh
fleet cu web click firefox 166 447      # ● changed / ○ no_change / ? indeterminate
fleet cu web key firefox escape
fleet cu web type firefox "hello"
fleet cu web act firefox scroll '{"direction":"down"}'
```

cua-driver's own `effect` field returns `"unverifiable"` both for input that worked
and for input that did nothing. Fleet hashes the
window bitmap before and after the action instead, and takes a third capture when
they differ so a window that repaints on its own (a clock, a spinner, video) is
not reported as a change. A failed settling capture reports `indeterminate`.
Driver errors and missing requested images return failure. A title match selects
that window, including dialogs. `act` JSON must omit `pid` and `window_id`; Fleet
supplies them and validates `x,y`. Raw `click {JSON}` remains a driver passthrough.

A background click that reports `no_change` means the target dropped it; retry with
`--foreground`. No screenshot is needed to tell.

Shared flags: `--space window|screen`, `--button`, `--count`, `--foreground`,
`--settle MS`, and `--shot [--grid]` to pull the after-image.

Anything else passes straight through to cua-driver:

```sh
fleet cu web list-tools                 # authoritative tool list for the installed version
fleet cu web get_screen_size
fleet cu web click '{"pid":3848,"window_id":66756,"x":100,"y":200}'
```

- **Always send `window_id`.** Without it, cua-driver targets the process's
  frontmost window, which is the modal dialog whenever one is open. Window-local
  coordinates then anchor to the dialog's frame, and the click lands somewhere
  unrelated, often in another application. The verbs above always send it; a raw
  passthrough must send it itself.
- **One window's capture can hide a blocker.** A modal dialog over a window swallows
  all input while the window underneath looks normal.
  `shot-window` captures the process's owned popups too, composites them onto the
  result, and prints a `BLOCKED?` warning naming them. For anything it cannot see,
  verify with a full `fleet shot <host>`.
- **Coordinates are window-local pixels**, not screen coordinates. Add `--grid`
  (`--grid-step N`) to any capture for a labeled coordinate ruler; on
  `shot-window` the image also carries a caption strip stating the exact frame
  (pid, window_id, origin) the numbers are in. `--probe X,Y` draws a crosshair
  where a click would land without clicking, and a point that resolves outside the
  target window is refused rather than delivered to whatever is underneath it.
- **Empty accessibility trees.** `get_window_state` on a WPF, canvas or
  custom-drawn window returns `degraded: true, element_count: 0` and still ships its
  whole envelope, which can be megabytes. Fleet collapses that to the diagnostic and
  says that element addressing is unavailable there, so use pixels. `--full` restores the raw body, and
  `describe <tool> --brief --for <target>` probes the real window and drops the
  "prefer element_index" advice when that window has no tree to index.
- **JSON arguments travel on stdin**, not in argv, because Windows PowerShell 5.1
  strips the quotes around JSON field names in native-command arguments.
- **Refusals fail.** cua-driver's own CLI exits 0 even when it refuses. Fleet exits
  1 when a reply is a refusal, an `isError`, a failed delivery, or a lookup error such
  as `window_id_not_found`, so an agent's shell sees the failure without parsing it.
- An image comes back only when you pass `--out` (or use `shot-window`).
- Exposed to agents as `fleet_cu` (raw), `fleet_cu_act` (verified input),
  `fleet_cu_windows`, `fleet_cu_open`, `fleet_cu_screenshot_window` and `fleet_cu_describe`;
  `args: ["install"]` fans out over a selector there too.

### Android phones

A host with an `android` block is a phone reached over SSH into
[Termux](https://termux.dev). Termux's own adb client drives the phone's adbd on
`127.0.0.1`, so adb traffic never crosses the network: screenshots are encoded on
the phone and the before/after checks hash frames there.

```json
"phone": { "ssh": "phone", "os": "linux", "android": { "serial": "127.0.0.1:5555", "shotWidth": 400 } }
```

`shotWidth` (optional) sets the default screenshot width, which helps on a slow route.

One-time setup on the phone: install Termux with `sshd`, then
`pkg install android-tools libwebp nmap`. Turn on Developer options → Wireless
debugging, and run `fleet cu phone bootstrap`: Termux finds the wireless-debugging
port on localhost and runs `adb tcpip 5555`. Its key must be trusted there once
(`bootstrap PAIR-PORT PAIR-CODE` pairs it). Wireless debugging needs Wi-Fi and
switches off without it; with USB debugging also on, adbd keeps running and port
5555 keeps working on mobile data, which makes the phone reachable over Tailscale
anywhere. After a reboot, turn Wireless debugging on and run `bootstrap` again.

```sh
fleet cu phone doctor                          # every link from SSH to the input system
fleet cu phone elements [filter] [--role R]    # UI tree: role, label, id, actions, center
fleet cu phone tap settings --label Bluetooth  # TARGET is the package that must hold focus
fleet cu phone type any "hello" --label search # ASCII; the field is read back
fleet cu phone batch any '[{"action":"key","key":"back"},{"action":"key","key":"home"}]'
fleet cu phone wait --label "Wi-Fi" --timeout 8000
fleet cu phone flow '[{"action":"open","what":"com.android.settings"},{"action":"wait","label":"Wi-Fi"},{"action":"tap","label":"Wi-Fi"}]' --target com.android.settings
                                               # steps run in order, each reading the screen at its turn; the last screen prints
fleet cu phone tap settings --label Bluetooth --read Bluetooth   # --read FILTER prints the screen after the action
fleet cu phone open https://example.com --in com.android.chrome
fleet cu phone shot --width 400                # WebP encoded on the phone
fleet cu phone swipe2 any 500 1200 800 1200 -400 0   # two fingers, both moved by -400,0
fleet cu phone zoom any in                     # target view and finger spread guessed from the tree
fleet cu phone gesture any 500,1300,300,1100 760,1500,960,1700  # one stroke per finger, 1-5 fingers
fleet cu phone notifications [PACKAGE]         # the notification shade, newest first
fleet cu phone watch                           # live scrcpy window on this machine
fleet cu phone record start --out demo.mp4     # scrcpy recording here; record stop ends it
fleet cu phone revive                          # SSH down: reopen Termux through this machine's adb
fleet cu phone release                         # stop the UI helper now
```

The desktop contracts carry over:

- **Explicit target.** Every input names the package that must hold focus (a word
  in it matches) or `any`. Input is refused before delivery when another package
  holds focus, the screen is off, or the phone is locked; fleet never unlocks it.
- **Labels, not pixels.** `elements` reads the accessibility tree; a label resolves
  to one element or is refused with the candidates. A caption inside a tappable
  row reports the row it reaches. A label action reuses the tree the last
  `elements` read, and the phone first checks the element's rows still look the
  same, sending nothing if they do not.
- **Effect from pixels.** `changed` / `no_change` / `indeterminate` come from frame
  hashes taken on the phone with the status bar cut off (its clock and network meter
  change on their own), polled until two frames agree. Typing reads the focused
  field back.
- **Batches** run up to 50 steps in one round trip, re-check focus before every
  step, and stop at the first failure.
- **Multi-finger gestures.** adb's `input` sends one finger, so `swipe2`, `zoom`
  and `gesture` go through the UI helper below, which injects multi-pointer touch
  events. The fingers land together, move in straight lines, and lift together.
  `zoom in|out` without a point picks the largest image, map, web, or terminal view
  and keeps the fingers 8% inside it and the display; the output names its pick.
- **Watch and record** run scrcpy on this machine, so they need adb and scrcpy here
  and the phone's adbd reachable over the network.
- **A fast UI tree.** A 6 KB helper (`android/uiserver`, a dex run by adb's shell
  through `app_process`, nothing installed as an app) holds one UiAutomation
  connection and serves the tree in ~0.1 s, against ~2.5 s for `uiautomator dump`.
  It leaves other accessibility services running, answers only a token that only
  adb's shell can read, and exits after 2 idle minutes.

On a test phone over Wi-Fi, `elements` takes about 1 s and an input 2 to 3 s.
Over Tailscale's relay on mobile data (10 to 15 KB/s), replies are gzipped:
`elements` takes about 1.7 s, an input 2 s, and a screenshot 8 s at 400 px wide.

## Agent setup

Fleet is built for coding agents. Most setups need two things: the CLI on PATH,
and the skill that tells the agent when to use it. Steps 3 and 4 are optional.

**Prefer the CLI to the MCP server.** Any agent that can run shell commands can run
`fleet`, so one install serves every agent on the machine, including agents you
install later. The MCP server needs its own config entry in each client (Claude
Code, Codex, Cursor, the desktop app), each with its own file format and restart.
The CLI also has more commands: `top`, `ssh` and `jobs tail -f` need a TTY and have
no MCP tool.

Use MCP when the agent cannot run shell commands, as in a sandboxed or hosted
client, or when you want tool-level gating: `FLEET_MCP_READONLY=1` drops every
mutating tool.

### 1. Install the CLI and describe your machines

```sh
git clone https://github.com/safzanpirani/fleet ~/fleet
cd ~/fleet && bun install && bun link
cp fleet.config.example.json fleet.config.json
$EDITOR fleet.config.json          # your ssh aliases, OSes, services, groups
fleet ls                           # every host should answer
```

Each host key is an ssh alias, so fleet inherits whatever `ssh <alias>` does: keys,
jump hosts and Tailscale names. Make `fleet ls` pass before you set up an agent; the
steps below use the same config, and a host that fails here fails there too.

Run these before an agent uses it:

```sh
fleet doctor <host>                # explains an unreachable host (ssh -vv + health)
fleet exec all 'echo ok'           # checks fan-out and auth on every machine at once
```

### 2. Install the skill

An agent with the CLI on PATH still has to know it is there. The skill tells it when
to use fleet. Without the skill, agents write `ssh host "…"` by hand and hit the
quoting problems fleet avoids. Install it whether or not you register the MCP
server.

`skill/SKILL.md` is a ready-made [Agent Skill](https://code.claude.com/docs/en/skills)
covering the commands, selector syntax (`host`, `a,b`, `@group`, `all`), the
quoting rules, the detached-jobs workflow, and the MCP tool names.

Install it straight from this repo with [`skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add safzanpirani/fleet -g        # user-level, every agent
npx skills add safzanpirani/fleet           # …or scoped to the current project
```

It installs as `fleet`; `--list` shows what's in the repo, `-a claude-code`
targets one agent, and `npx skills update fleet` pulls later changes. To install it
by hand, copy the folder:

```sh
cp -R ~/fleet/skill ~/.claude/skills/fleet      # Claude Code
cp -R ~/fleet/skill ~/.factory/skills/fleet     # Factory Droid
```

[Factory Droid](https://factory.com) also discovers skills under
`~/.agents/skills/`, so a copy there serves Droid and other agents that read
that path.

**Install it wherever the `fleet` CLI is reachable.** The skill helps only an agent
that can run `fleet`. Put it in your global agent config and in any project whose
agent does remote work. If you run agents on your machines (a coding agent on the
GPU machine, a cloud session), install the skill and `fleet` there too. Without the
CLI, the skill teaches commands the agent cannot call.

Then edit the installed copy's frontmatter `description` to name your hosts and
groups. The agent matches requests against that line, so "run something on gpu-box"
triggers it more reliably than the generic wording shipped here.

### 3. Register the MCP server if you need it

Skip this if steps 1 and 2 cover your agent. For a client that cannot run shell
commands, or to use the read-only kill switch, fleet serves the same config,
selectors and exec over [MCP](https://modelcontextprotocol.io) on stdio. Register it
per client:

```sh
bun run src/mcp.ts            # or: bun run mcp   (FLEET_CONFIG honoured)
```

**Claude Code**
```sh
claude mcp add fleet -- bun run ~/fleet/src/mcp.ts
```
**Factory Droid**
```sh
droid mcp add fleet "bun run $HOME/fleet/src/mcp.ts"
```
Droid writes the entry to `~/.factory/mcp.json` ([docs](https://docs.factory.ai/harness/mcp)),
and `/mcp` in a Droid session shows the server and its tools. A project can share
it through `.factory/mcp.json` instead.

**Any client that reads an MCP config** (`.mcp.json`, `claude_desktop_config.json`,
`~/.factory/mcp.json`, Cursor, Windsurf, Zed, …):
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

Use an absolute path. The server resolves `fleet.config.json` from the repo root,
and MCP clients rarely launch from a predictable cwd. To point one client
at a different fleet, add `"env": { "FLEET_CONFIG": "/path/to/other.json" }`.

Restart the client and ask it to list tools; it should show 60 named `fleet_*`
(18 with `FLEET_MCP_READONLY=1`).

### 4. If the agent doesn't run on this machine

A cloud agent, a phone client, or a teammate's session can't spawn a local stdio
process. For those, run the [HTTP endpoint](#remote-mcp-endpoint-http) instead
and register `https://<your-fleet-host>/mcp` with the token as the API key. The
token can run commands on every machine in the config, so start read-only:

```sh
FLEET_MCP_READONLY=1 FLEET_MCP_TOKEN=<long-random> bun run serve
```

### 5. Optional: let the agent use a desktop

Everything above gives an agent a shell on your machines. If you also want it
clicking and typing in GUI apps, install [cua-driver](https://github.com/trycua/cua).
One command with a selector installs it everywhere:

```sh
fleet cu @windows install       # …or a single host, or `all`
```

Windows registers and starts an autostart task. Linux updates require an existing
`cua-driver.service` user unit. You get a result for each selected host.
See [Computer use](#computer-use-fleet-cu) for what the agent can then do
with it, and skip this entirely if your agents only need a shell.

### Give the agent room to work

- **Let it fan out.** `fleet exec @linux 'uptime'` is one call that runs in parallel;
  a loop over hosts costs a round trip per host.
- **Do not let it sleep-poll.** For long work, `fleet spawn` returns a job id at once,
  and `fleet jobs wait <id> --until '<regex>'` blocks until the output matches. The
  job keeps running if the SSH session drops. See [Detached jobs](#detached-jobs).

### Verify the whole path

```sh
fleet ls                                  # CLI → hosts
bun run scripts/smoke.ts                  # MCP stdio → tools → hosts
bun run scripts/smoke-http.ts             # HTTP transport + auth
FLEET_MCP_READONLY=1 bun run scripts/smoke-http.ts   # kill-switch drops mutating tools
```

Then ask the agent a question it can answer only by calling fleet, such as "how
much disk is free on every machine?", and check that the answer names your real
hosts.

### MCP tools

All prefixed `fleet_`, grouped by access:

| Group | Tools |
|---|---|
| **Read-only**: carry `readOnlyHint`, always registered | `ls` · `logs` · `svc` · `gpu` · `disk` · `status` · `jobs` · `job_log` · `boot` · `session` · `ps` · `dt` · `doctor` · `wait` · `job_wait` · `tools_status` · `cu_tools` · `cu_describe` |
| **Mutating**: dropped by the read-only kill switch | `exec` · `cp` · `restart` · `spawn` · `drop` · `job_kill` · `reboot` · `bios` · `switch` · `screenshot` · `cu` · `run` · `android_*` (state, elements, screenshot, act, batch, flow, wait, open, apps, bootstrap, release) · `kill` |
| **Not exposed** | `top` / `ssh` (need a live TTY) · job `tail -f` / `wait` (would block) |

- `screenshot` counts as mutating, because capturing runs commands on the host (on Windows it registers a one-shot scheduled task).
- `exec` accepts an optional `timeout` (seconds); a hung remote command returns exit **124** instead of blocking the server.
- Host, group and recipe names are written into the tool descriptions, so an agent sees valid selectors without a round trip.
- Smoke-test end-to-end: `bun run scripts/smoke.ts`.

`server.ts` (`buildServer`) defines the tools once for the stdio server (`mcp.ts`)
and the remote HTTP server (`http.ts`). Both servers and the CLI (`cli.ts`) call the
`core.ts` action layer, so the shell construction lives in one place.

### Computer-use controls and batches

`fleet cu` has named `click`, `right-click`, `double-click`, `drag`, `scroll`,
`hotkey`, `key`, and `type` commands. Use `act <target> <tool> <JSON>` for other
window input, or `<tool> <JSON>` for raw driver access. Drag endpoints and other
coordinates are checked against the selected window. `--space screen` translates
desktop coordinates; `--json` returns one structured result.

```sh
fleet cu win-box drag mspaint 100 80 300 200 --duration 500
fleet cu win-box scroll notepad down 2 --by page
fleet cu win-box batch notepad '[{"tool":"click","args":{"x":100,"y":80}},{"tool":"type_text","args":{"text":"hello"}}]' --shot --json
```

Address controls by accessibility instead of pixels when the window exposes them.
`elements` lists each control's token, role, label, value, and actions without taking a
screenshot. The input commands accept `--label TEXT [--role R] [--nth N]` or
`--element TOKEN` in place of coordinates, and an ambiguous label is refused with the
candidates listed. `verify` checks state with cua-driver's `verify_state`.

```sh
fleet cu win-box elements notepad save --role Button
fleet cu win-box elements "<window title>" --task "open the Fonts folder"   # hide rows the task does not need
fleet cu win-box click notepad --label Save --role Button
fleet cu win-box set charmap "hello" --label "Search for"
fleet cu win-box menu notepad File "Save As..."
fleet cu win-box verify notepad --label Saved
```

A big window can list hundreds of controls, and every row costs the agent
context. `--task TEXT` sends each row to TypeSafe's Jev relevance judge and hides
only the rows it is confident the task does not need: an Explorer window at
`C:\Windows` went from 295 rows to 18 with the Fonts folder kept. It runs only past
30 rows, needs `TYPESAFE_API_KEY`, and lists every row when the key is missing or
the call fails. Each use is a paid API call.

### Reading pixels with Cua Perception

For a window whose accessibility tree is empty (a canvas, a game, a remote desktop,
custom-drawn UI), cua-driver's optional `cua-perception` extension parses a capture
into text regions (OCR) and icon regions on the host's CPU. It needs cua-driver
0.29.1 or later. `perception install` downloads the signed release on the host
(about 420 MB), checks `SHA256SUMS`, refuses a catalog that the driver does not
report as publisher-verified, and runs the extension's self-test. The extension
bundles the OmniParser icon detector under AGPL-3.0; Fleet never installs it
implicitly.

```sh
fleet cu win-box perception install          # status | install [--version V] | remove
fleet cu win-box regions calc --kind text    # id, text, bounds, and center in capture pixels
fleet cu win-box click calc --region 7       # exact OCR text first, then substring
fleet cu win-box click calc --region-at 66,192 --kind icon
```

A region click captures the window, parses it, picks one region, and clicks its
center with that capture's `capture_id`, all inside one `cua-driver mcp` session:
a capture ID does not resolve from a separate CLI call. The driver consumes the
capture, so one parse authorizes one click, and a refused capture-bound click is
never retried as a plain coordinate click. An ambiguous or missing match lists the
candidates and sends nothing. Region IDs and OCR text change between parses of the
same window, so `--region-at X,Y` names a region from an earlier listing by a point
inside it; the smallest region containing that point is clicked. Linux and macOS
hosts need `python3`. MCP: `fleet_cu_regions`, and `fleet_cu_act` with
`region: {text | at, kind?, nth?}`.

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
For remote clients such as Poke, the server also speaks Streamable HTTP at
`POST /mcp`. Put it behind a Cloudflare tunnel on a hostname you control. The SSE
paths (`GET /sse`, `POST /messages`) answer `410`, since MCP 2026-07-28 deprecated
that transport.

```sh
FLEET_MCP_TOKEN=<long-random> bun run src/http.ts     # or: bun run serve
```

- **Auth is mandatory.** Every MCP request needs `Authorization: Bearer <FLEET_MCP_TOKEN>`
  (or `X-API-Key`); without it the answer is `401`. The token can run commands on
  every host, so keep it long, random and out of git. `GET /health` is the only
  unauthenticated route, and it returns only the host count and the read-only flag.
- **Kill switch.** `FLEET_MCP_READONLY=1` drops every mutating tool, including
  `screenshot` and `cu`, which execute on the host. The 18 read-only tools remain.
- **Binding.** The default is `127.0.0.1:8787` (`FLEET_MCP_HOST`, `FLEET_MCP_PORT`).
  Only the local cloudflared should reach it, and the token guards the public side.
- Register in an MCP client with URL `https://<your-fleet-host>/mcp` and the
  token as the API key. For Factory Droid:
  `droid mcp add fleet https://<your-fleet-host>/mcp --type http --header "Authorization: Bearer $FLEET_MCP_TOKEN"`. Smoke-test locally with `bun run scripts/smoke-http.ts`
  (and `FLEET_MCP_READONLY=1 bun run scripts/smoke-http.ts` for the kill-switch).

## Config (`fleet.config.json`)
Each host has an `ssh` alias, `os` (`linux|windows|mac`), optional `wsl` distro,
optional `winShell` (`pwsh|powershell`), optional `hostKeyAlias`, optional `sudo`
(`passwordFile`, a 0600 file whose first line is the password, or `passwordEnv`),
and a `services` map. `--sudo` sends that password only on ssh stdin. Configuring
`winShell` skips a shell-discovery round trip on every short-lived CLI process.
Top-level `routes` map logical names to ordered, same-OS host lists. Service
`type` controls how `restart`/`logs` work:

| type | restart | logs |
|---|---|---|
| `systemd` | `sudo systemctl restart` | `journalctl -u` |
| `systemd-user` | `systemctl --user restart` | `journalctl --user -u` |
| `winservice` / `nssm` | `Restart-Service` | `Get-Service … \| Format-List` |
| `schtask` | `schtasks /End` + `/Run` | `schtasks /Query /V` |

fleet validates the config at load. Unknown OSes, bad service types, groups or
machine boots that name missing hosts, and malformed recipes all fail with the
offending key named, so a misspelled group member cannot silently shrink a
`reboot @group` fan-out. Group members are also re-checked at
resolve time.

A source checkout also accepts `fleet.config.example.json` when its main config
is absent. Compiled binaries search beside the executable, then the user config
and deployed source directories. Missing-config errors list usable locations.
An explicit `FLEET_CONFIG` that does not exist fails without falling back.

### Proxies

A host with a `proxy` is reachable **only** through that proxy. Every transport
carries the same route: `exec`, `spawn`/`jobs`, `cp`, `edit`, `restart`,
`reboot`, `tools sync`, `deploy`, `ls`/`wait` probes, `doctor`, and interactive
`fleet ssh`.

```jsonc
{
  "proxies": {
    "vpn-exit": {
      "type": "socks5",              // socks5 | socks5h | http
      "host": "192.0.2.10",
      "port": 1080,
      "user": "optional",
      "passwordEnv": "VPN_PROXY_PW", // or "passwordFile": "~/.fleet/proxies/vpn.pw"
      "dns": "remote",               // remote (default): the proxy resolves the target
      "verify": { "url": "https://api.ipify.org", "expect": "198.51.100.7" }
    }
  },
  "defaultProxy": "vpn-exit",        // optional; covers hosts with no `proxy` of their own
  "hosts": {
    "box": { "ssh": "box", "os": "linux", "proxy": "vpn-exit" }
  }
}
```

`"proxy"` takes a `proxies` key or an inline URL
(`"socks5h://user:pass@host:1080"`). The inline form keeps the password in
`fleet.config.json`.

Resolution, first match wins: `--proxy NAME|URL` → `FLEET_NO_PROXY=1` →
`FLEET_PROXY` → `hosts.<h>.proxy` → `defaultProxy` → direct.

```sh
fleet proxy                  # configured proxies and what routes through each
fleet proxy check            # probe each endpoint; run its `verify` fetch through it
fleet proxy drop <sel>       # close ssh control masters after changing a route
fleet doctor <host>          # resolved proxy, the exact ProxyCommand, the verify result
fleet exec --no-proxy <host> 'echo $SSH_CLIENT'   # compare against the direct route
```

Fleet does not call `nc`, `ncat` or `socat`. It speaks SOCKS5 and HTTP CONNECT itself
in a hidden `fleet __proxy-connect <name> %h %p` that ssh runs as its `ProxyCommand`.
That adds no dependencies, makes remote DNS an explicit setting, and keeps
credentials out of the process table: only the proxy name reaches ssh's argv, and
fleet reads the secret from `passwordEnv` or `passwordFile` in-process. A failed connection names the leg that broke
(proxy unreachable, auth rejected, DNS, destination refused) instead of blaming
the host.

On macOS and Linux, fleet also passes `-o ProxyUseFdpass=yes` and runs
`__proxy-connect --fdpass`: it completes the proxy handshake, hands the connected
socket to ssh, and exits, so no fleet process stays behind for the life of the
connection. A Windows controller keeps the copying ProxyCommand, because Win32
OpenSSH has no `ProxyUseFdpass`.

Two things to know:

- Fleet's explicit `-o ProxyCommand=…` overrides any `ProxyCommand` in
  `~/.ssh/config` for that host. Delete hand-written blocks for hosts that now
  carry `"proxy"` in fleet config, or raw `ssh` and `fleet` will disagree.
- Changing a host's proxy does not re-route a live control master, which keeps
  the old path until `ControlPersist` expires. Run `fleet proxy drop <host>`
  (or `ssh -O exit <host>`) after a route change. Fleet mixes the route into the
  control-socket name, so a proxied and a direct host that share a `HostName` do
  not collide. A master created before the route change is still stale.

Daytona (`dt:`) hosts speak HTTP, not ssh; a proxy configured for one is ignored.

Override the config path with `FLEET_CONFIG=/path/to.json`. Keep a personal,
git-ignored `fleet.config.local.json` if you don't want hosts in git.

### Environment variables
| var | effect |
|---|---|
| `FLEET_CONFIG` | alternate config path |
| `FLEET_SOURCE_ROOT` | source checkout for deployment from a compiled binary |
| `FLEET_EXEC_TIMEOUT` | default wall-clock cap in seconds; per-call timeout wins. Unset/0 disables the SSH cap; Daytona retains its five-minute default |
| `FLEET_DONE_GRACE_MS` | after a remote script reports it finished, how long to wait for its output to drain before returning (default 1500). Stops a remote child that keeps stdout open from hanging the call |
| `FLEET_PROBE_TIMEOUT_MS` | reachability-probe cap (default 4000; a proxied host gets +2000 unless this is set) |
| `FLEET_PROXY` | default proxy (name or URL) for every host with no `proxy` of its own |
| `FLEET_NO_PROXY` | `1` routes every connection directly, which bypasses a wedged proxy. `--proxy` still wins |
| `FLEET_WIN_SHELL` | force `pwsh` or `powershell` on every Windows host (overrides per-host `winShell`) |
| `NO_COLOR` / `FORCE_COLOR` | output is uncoloured unless stdout is a terminal; `NO_COLOR` always disables colour, `FORCE_COLOR=1` forces it |
| `FLEET_WIN_SESSION` | `0` turns off the kept-open PowerShell session that makes repeat Windows execs take ~50-250 ms instead of ~0.6 s |
| `FLEET_WIN_SESSION_IDLE_S` | idle seconds before that session closes (default 600) |
| `TYPESAFE_API_KEY` | enables `fleet cu … elements --task` (paid call; fails open). `FLEET_JEV_CONFIG` may name a JSON file with `apiKey` instead |
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

`bun run scripts/cu-daily.ts <windows-host>` drives a live desktop through the
real CLI with everyday tasks (Calculator arithmetic, a new folder in Explorer, a
character from Character Map, the device name from Settings), checks each result
through the app's own state or the file system, and closes what it opened.
`--paid` adds the `elements --task` case, which calls the TypeSafe API.
