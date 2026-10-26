/** Static help must work without configuration, SSH, or a dashboard. */
const usage: Record<string, string> = {
  ls: "ls [--json]                         list host reachability and services (alias: hosts)",
  config: "config [<host>] [--json]            effective settings and refused features, with their sources",
  dt: "dt [--json]                         list Daytona sandboxes",
  exec: "exec --argv [options] <sel> -- <program> <arg…>\n  fleet exec [--cwd DIR] [--timeout S] [--wsl] [--sudo] [--fresh] [--confirm-reboot] [--raw | --json] <sel> [--] <cmd…>\n  fleet exec --script <file|-> [--interp CMD] [--cwd DIR] [--timeout S] [--wsl] [--sudo] [--confirm-reboot] [--raw | --json] <sel> [--] [ARG…]",
  spawn: "spawn [--wsl] [--elevated] [--fresh] [--confirm-reboot] [--cwd DIR] [--label NAME] [--json] <sel> [--] <cmd…>",
  watch: "watch [-n SECONDS] [--diff] [--until REGEX [--timeout S]] [--wsl] <host> [--] <cmd…>",
  jobs: "jobs [list] [<sel>] [--json]\n  fleet jobs log <host:id> [--json]\n  fleet jobs tail <host:id> [-n N | --lines N] [-f | --follow] [--include REGEX] [--exclude REGEX] [--json]\n  fleet jobs wait <host:id> [--until REGEX] [--timeout S] [--json]\n  fleet jobs kill <host:id> [--json]\n  fleet jobs rm <host:id> [--json]\n  fleet jobs prune [<sel>] [--all] [--json]",
  cp: "cp [-r | --recursive] [--resume] [--json] <local…> <sel>:<remote>\n  fleet cp [-r | --recursive] [--resume] [--json] <sel>:<remote…> <local>",
  edit: "edit <sel>:<path> (--old TEXT|--old-file F [--new TEXT|--new-file F] [--all] [--escapes] | --edits F) [--dry-run] [--sudo] [--wsl] [--json]",
  diff: "diff [-U N] [--json] <A> <B>          unified diff of two files; each is <sel>:<path> or local",
  restart: "restart <sel> <service> [--json]\n  fleet restart <sel> --unit NAME --type TYPE [--json]",
  reboot: "reboot <sel> [--yes | -y] [--wait [--timeout S]]",
  bios: "bios <sel> [--yes | -y]",
  boot: "boot <machine> [--entries] [--json]",
  switch: "switch <machine> --to OS [--yes | -y] [--dry-run] [--no-wait] [--timeout S] [--json]",
  wait: "wait <host|machine> [--ssh | --port N | --http URL [--status N] | --boot OS]\n    [--timeout S] [--interval S] [--json]",
  gpu: "gpu [--json]                        read GPU stats from the dashboard",
  disk: "disk [<sel>] [--json]                read mounted-volume space from hosts",
  du: "du <sel>:<dir> [-n N] [--timeout S] [--json]   largest children of a remote directory",
  which: "which <cmd> [<sel>] [--version] [--json]   show where a program resolves on each host",
  status: "status [<host>] [--json]             read dashboard stats",
  ps: "ps <sel> [FILTER] [--sort cpu|mem] [-n N] [--json]   list processes the same way on every OS",
  ports: "ports <sel> [FILTER] [--udp] [--json]   list listening ports the same way on every OS",
  kill: "kill <sel> <PID[,PID…]|NAME> [--tree] [--force] [--all] [--system] [--grace S] [--dry-run] [--sudo] [--yes] [--json]",
  top: "top <host>                          live dashboard; Ctrl-C exits",
  logs: "logs <sel> <service> [-n N] [-f|--follow] [--raw | --json]\n  fleet logs <sel> --unit NAME --type TYPE [-n N] [-f|--follow] [--raw | --json]",
  svc: "svc <service> [<sel>] [--json]\n  fleet svc [<sel>] --unit NAME --type TYPE [--json]",
  webcam: "webcam <host|local> [--device DEVICE] [--out photo.png] [--json]\n  fleet webcam <host|local> --list [--json]\n  fleet webcam <host|local> --stream [--device DEVICE] [--fps N] [--width PX] [--for S] [--vo kitty|text] [--window|-W]",
  shot: "shot <host> [--output NAME|main|focused|N] [--region AREA] [--wake] [--out|-o FILE] [--grid] [--grid-step N] [--no-open]\n  fleet shot <host> --list [--json]",
  cu: "cu <host> <tool> [JSON] [--out FILE] [--grid] [--grid-step N] [--full] [--no-open]\n  fleet cu <sel> install | perception [status] | perception install [--version V] | perception remove\n  fleet cu <host> tools [FILTER] | describe <tool> [--brief] [--for TARGET] | apps [FILTER] [--all]\n  fleet cu <host> windows [TARGET] | shot-window <TARGET> [--out FILE] [--probe X,Y]\n  fleet cu <host> open <APP> [URL|ARG] | open <URL> [--wait MS] [--json]\n  fleet cu <host> elements <TARGET> [FILTER] [--role R] [--max N] [--task TEXT] [--json]\n  fleet cu <host> regions <TARGET> [FILTER] [--kind text|icon] [--min-confidence F] [--max N] [--out FILE] [--json]\n  fleet cu <host> verify <TARGET> <JSON> | verify <TARGET> --label L [--role R] [--value V] [--timeout MS]\n  fleet cu <host> click <TARGET> <X> <Y> [--space window|screen] [--button B] [--count N]\n  fleet cu <host> right-click|double-click <TARGET> <X> <Y>\n  fleet cu <host> click|right-click|double-click <TARGET> --label TEXT [--role R] [--nth N] | --element TOKEN\n  fleet cu <host> click|right-click|double-click <TARGET> --region TEXT | --region-at X,Y [--kind text|icon] [--nth N]\n  fleet cu <host> drag <TARGET> <FROM-X> <FROM-Y> <TO-X> <TO-Y> [--duration MS]\n  fleet cu <host> scroll <TARGET> <up|down|left|right> [AMOUNT] [--by line|page]\n  fleet cu <host> hotkey <TARGET> <MODIFIER> <KEY> [KEY\u2026]\n  fleet cu <host> key <TARGET> <KEY> | type <TARGET> <TEXT> | act <TARGET> <tool> [JSON]\n  fleet cu <host> set <TARGET> <VALUE> --label TEXT | --element TOKEN\n  fleet cu <host> menu <TARGET> <ITEM> [ITEM\u2026]\n  fleet cu <host> batch <TARGET> <JSON-array|-> [--json] | batch <TARGET> --file FILE\n    shared by named input/batch: [--foreground] [--space window|screen] [--settle MS] [--shot] [--grid] [--json]\n  fleet cu <host|phone> task <TARGET> <GOAL> --verify TEXT [--verify TEXT\u2026] [--input KEY=VALUE\u2026] [--secret-env KEY=ENVVAR\u2026]\n    [--constraint TEXT\u2026] [--allow delete|send|purchase|close\u2026] [--shortcut CHORD=DESCRIPTION\u2026] [--max-actions N]\n    [--min-confidence F] [--min-margin F] [--timeout S] [--dry-run] [--foreground] [--json]  |  task <TARGET> --file SUBTASK.json|-\n  fleet cu <host> record start|stop|status [--out DIR]\n  fleet cu <phone> doctor | state | release | bootstrap [PAIR-PORT PAIR-CODE] | apps [FILTER]\n  fleet cu <phone> notifications [PACKAGE] [--max N] | revive [--restart]\n  fleet cu <phone> watch [--view-only] | record start [--out FILE] [--limit S] [--bit-rate M] | record stop|status\n  fleet cu <phone> elements [FILTER] [--role R] [--all]\n  fleet cu <phone> shot [--out FILE] [--width N] [--grid] | open <PACKAGE|URL> [--in PACKAGE] [--wait MS]\n  fleet cu <phone> tap|long-press <TARGET> <X> <Y> | --label TEXT [--role R] [--nth N]\n  fleet cu <phone> swipe <TARGET> <X1> <Y1> <X2> <Y2> [--duration MS] | scroll <TARGET> <DIR> [N]\n  fleet cu <phone> swipe2 <TARGET> <X1> <Y1> <X2> <Y2> <DX> <DY> [--duration MS]\n  fleet cu <phone> zoom <TARGET> <in|out> [X Y | --label TEXT] [--scale F] | gesture <TARGET> <X1,Y1,X2,Y2>…\n  fleet cu <phone> key <TARGET> <KEY> | type <TARGET> <TEXT> [--label TEXT]\n  fleet cu <phone> batch <TARGET> <JSON-array|-> [--gap MS] | batch <TARGET> --file FILE\n  fleet cu <phone> wait --label TEXT [--role R] [--gone] | wait --focus PACKAGE [--timeout MS]\n  fleet cu <phone> flow <JSON-array|-> | flow --file FILE [--target PACKAGE] [--read FILTER | --no-read]\n    open and input verbs accept trailing --read FILTER (or '*') after their operands; --json includes the read",
  browse: "browse <host> [URL]                  verify configured CDP and list targets",
  run: "run <recipe>                        run configured steps; stop on failure",
  deploy: "deploy <sel> [--restart SERVICE | --no-restart] [--json]",
  tools: "tools list [--json]\n  fleet tools status [tool] [<sel>] [--json]\n  fleet tools sync <tool|--all> [<sel>] [--no-skill] [--max-parallel N] [--json]\n  fleet tools stamp [tool] [--json]",
  skills: "skills list [--json]\n  fleet skills status [set] [<sel>] [--json]\n  fleet skills sync <set|--all> [<sel>] [--force] [--dry-run] [--json]",
  doctor: "doctor <host> [--json]               diagnose SSH and health reachability",
  session: "session <sel> [--json]              logged in, locked or at the login screen; idle time; displays on or off",
  drop: "drop <sel>                          close shared ssh connections and Windows sessions; the next call logs in fresh",
  hostkey: "hostkey <host> [--pin] [--json]       compare or pin the host key under the host's hostKeyAlias",
  find: "find <machine|mac> [--from HOST] [--json]  find a machine's LAN address by MAC",
  proxy: "proxy [list] [--json]                list configured proxies and what routes through them\n  fleet proxy check [name…] [--json]\n  fleet proxy drop <sel>",
  completion: "completion [bash|zsh]               emit shell completion using config",
  ssh: "ssh <host>                          open an interactive SSH session",
  help: "help [command [subcommand]]         show help without loading config",
};

const detail: Record<string, string> = {
  ls: "A host whose config refuses some fleet commands lists them after disabled: (a disabled\n"
    + "array in --json). hosts.<h>.disable and the top-level disable refuse a feature;\n"
    + "hosts.<h>.enable re-allows one the top level refuses. Features: webcam, cu, shot,\n"
    + "browse, exec (also spawn, watch, ssh), files (cp, edit, diff), power (reboot, bios,\n"
    + "switch), kill, restart, deploy (also tools sync, skills sync). A refused command exits 1 before it\n"
    + "contacts any host; --json failures carry code FEATURE_DISABLED. This governs fleet's\n"
    + "own commands only, not what the host's ssh login can do: disable exec and files too\n"
    + "when an agent must not reach the host another way through fleet.",
  du: "The N largest immediate children of <dir> (default 15), largest first, with the total.\nSame output on Linux, macOS, and Windows: du -skx per child on Unix (never crosses into\nanother filesystem below a child, never follows a symlink), summed file lengths on Windows.\nA leading ~ is the remote home; a relative <dir> starts there. An entry marked partly\nunreadable had contents the host could not read; its size is what was readable, and the\ntotal shows as a lower bound (≥). --timeout (or FLEET_EXEC_TIMEOUT) caps each host; on\nexpiry the children measured so far still show, with how many were measured. Exit 1 when\nany host fails or stops early.",
  ps: "One table on Linux, macOS, and Windows: pid, parent, cpu (% of one core; sampled over\n0.5 s on Windows), memory, age, owner (not on Windows), and the command line. FILTER\nmatches a process name, or a pid when it is a number; the command line is never\nsearched. Without a FILTER the top 20 by cpu show; -n changes that. Rows marked job:ID\nwere started by a fleet job; rows marked protected are ones kill refuses.",
  ports: "One table on Linux, macOS, and Windows: port, address, pid, and process name, sorted by\nport. TCP listeners by default; --udp lists bound UDP sockets. FILTER matches a port number\nexactly, or a process name as a case-insensitive substring. Linux reads ss, macOS lsof,\nWindows Get-NetTCPConnection/Get-NetUDPEndpoint. Linux names another user's process only as\nroot; without it those rows show — for pid and name, and a name FILTER skips them.",
  which: "Linux and macOS use bash command -v; Windows uses Get-Command, so git finds git.exe,\nand .cmd, .bat and .ps1 resolve too. A host without it shows missing. <cmd> must be a\nplain program name (letters, digits, . _ + -). --version runs <cmd> --version with stdin\nclosed and prints its first line; a probe still running after 5 s is killed. Without\n<sel>, every reachable configured host is asked and unreachable ones are named on\nstderr. Exits 1 when a host fails or no host has the program.",
  kill: "Resolves the spec to exact pids first. A pid (or comma list) is taken as is; a name\nmatches exactly, then as a substring. A name matching several processes lists them and\nkills nothing unless --all. --tree adds every descendant, children first. Refused\nalways: fleet's own ssh session and pid 0/1 (0/4 on Windows); refused unless --system:\nsshd, launchd, systemd, svchost, explorer, and other core processes.\nEach pid's name is checked again right before its signal, so a reused pid is skipped\n(changed). The polite request comes first (SIGTERM; taskkill without /F on Windows),\nthen fleet waits --grace seconds (default 5). --force then kills survivors (SIGKILL;\nStop-Process -Force). Outcomes: exited, killed, running, denied, gone, changed.\nProcesses no fleet job started need confirmation: an interactive y/N, or --yes.\n--dry-run prints the plan and signals nothing. --sudo signals as root (POSIX).",
  webcam: "Requires ffmpeg on the target. local captures on this computer without SSH.\n--list prints device identifiers; --device selects one. The default is the host's\nwebcam.device setting (defaults.webcam.device for local), else the first listed camera.\nmacOS uses numeric AVFoundation indices; Windows uses DirectShow\ncamera names; Linux uses /dev/videoN. Photo output is PNG, fitted within 1280x720,\nbounded to 20 seconds.\n--stream (or stream/live) plays a live feed in the terminal: double-buffered Kitty\ngraphics in Kitty, Ghostty, and WezTerm, or true-color half-blocks elsewhere.\nSpace pauses, q/Esc/Backspace/Ctrl-C quit, --for S bounds the stream, and\n--window (-W) opens a local mpv or ffplay window. --fps accepts 1-60, --width\n16-1280, and --for 1-2147482 (integers). Duration also bounds stalled cameras\nand window playback. Camera permissions and exclusive access apply; Fleet\ndoes not stop applications using the camera or install software.",
  shot: "--output takes a connector name (DP-3), main (the X11/macOS primary, else the monitor at\n"
    + "0,0), focused, or a 1-based index; --list shows them with position, logical size and scale.\n"
    + "--region takes top-left, top-right, bottom-left, bottom-right, top, bottom, left, right,\n"
    + "center, or X,Y,W,H fractions of that monitor (main when --output is omitted). On Wayland a\n"
    + "powered-off monitor renders no frames, so a capture involving one is refused; --wake\n"
    + "switches it on for the capture and back off. On Windows the capture works with the monitors\n"
    + "asleep; --wake switches them on for the person in front of them (power-on broadcast and a\n"
    + "one-pixel mouse nudge) and leaves them on. Windows resolves --output inside the user's\n"
    + "session: main, an index, or DISPLAYn.\n"
    + "Without --output, --region or --grid-step, the host's shot settings apply\n"
    + "(hosts.<h>.settings.shot, then defaults.shot). shot.format picks webp or png for an\n"
    + "automatic file name; without it fleet writes webp when cwebp is installed.\n"
    + "fleet cu --grid uses shot.gridStep too.",
  session: "Linux reads logind, the compositor (a Hyprland session lock shows as LOCK in its monitor\n"
    + "list), locker processes and DPMS; Windows reads query user and LogonUI; macOS reads\n"
    + "IOConsoleUsers. Idle time is reported only where the desktop exposes it.",
  drop: "fleet reuses one ssh connection per host for a minute (sshPersist), and a Windows host's\n"
    + "PowerShell session for ten (winSessionIdleS). Either keeps the login's groups: after\n"
    + "usermod -aG, drop the host or pass --fresh to exec, --script or spawn.",
  config: "Shows, for one host or every host, each knob fleet uses and where its value came from:\n"
    + "env (the variable named beside it), host (hosts.<h>.settings), defaults (the top-level\n"
    + "defaults), or built-in. An environment variable beats hosts.<h>.settings, which beats\n"
    + "defaults. Fleet-wide knobs (routeGraceMs, parallel.*) come from defaults only. refused lists\n"
    + "the features fleet will not run on the host and whether hosts.<h>.disable or the top-level\n"
    + "disable refuses each. Reads the config only; nothing is contacted. A route lists its transports.",
  switch: "Prints each phase to stderr: probe (which boot is live), plan (the trigger), trigger,\n"
    + "reboot (the source boot stopped answering), wait. The trigger is machines.<m>.switch.<os>,\n"
    + "either one command or an object keyed by the source boot; without one, fleet looks up\n"
    + "machines.<m>.boots.<os>.firmware by label (bcdedit on Windows, efibootmgr on Linux),\n"
    + "sets a one-time boot and reboots. A failed lookup refuses before any reboot. Several\n"
    + "entries with one label resolve to the earliest in boot order. --dry-run shows the plan.\n"
    + "If the source never goes down, switch says so and stops. On a timeout it names the boot\n"
    + "that answers now. Default timeout 300 s. A Linux source needs root: passwordless sudo\n"
    + "or hosts.<h>.sudo.",
  boot: "--entries lists the UEFI entries as the live boot sees them, in boot-order position,\n"
    + "marks the entry each boot's firmware label resolves to, and warns about entries on a\n"
    + "partition other than the first EFI system partition (some firmware drops those).",
  hostkey: "Boots of one machine share an address, so only the host key tells them apart. With\n"
    + "hosts.<h>.hostKeyAlias set, fleet checks keys strictly under that name in\n"
    + "~/.ssh/known_hosts. --pin records the key the address serves now. It refuses when the\n"
    + "ssh banner's OS differs from the host's, or the key already belongs to another boot's\n"
    + "alias. fleet switch pins a target boot on arrival when every other boot of the same OS\n"
    + "already has a pinned key.",
  find: "Looks the MAC (machines.<m>.mac, or a literal MAC) up in the ARP table, sweeping the\n"
    + "local /22-or-smaller private subnets when it is missing. Recent macOS hides its ARP\n"
    + "table; use --from with a Linux host on the same LAN. Warns when a LAN host entry of\n"
    + "the machine points at a different address.",
  proxy: "A host with a `proxy` is reachable ONLY through it: exec, spawn, cp, edit, probe,\ndoctor and interactive ssh all carry the same ProxyCommand. Resolution order:\n--proxy NAME|URL, FLEET_NO_PROXY=1, FLEET_PROXY, hosts.<h>.proxy, defaultProxy, none.\n--proxy and --no-proxy go BEFORE the selector, like every other fleet flag.\ncheck probes each endpoint and, where `verify` is configured, fetches its URL THROUGH\nthe proxy and compares the observed exit IP with `expect`.\ndrop closes the ssh control master for the selected hosts. Changing a host's proxy does\nNOT re-route a live master; it keeps the old path until ControlPersist expires.\nCredentials are never printed, never placed in argv, and never written to a socket name.\nDaytona hosts speak HTTP, not ssh: a proxy configured for one is ignored.",
  reboot: "--yes is required without a terminal. --wait observes down, then SSH readiness.\n--timeout is a positive integer in seconds (default 300) and requires --wait.\nA deadline reports waiting-down or waiting-up and fails. A lost trigger reply has an\nunknown outcome; Fleet observes it without resending. Ordinary wait --ssh still tests\ncurrent readiness. Observation does not cancel a scheduled reboot.",
  restart: "--unit requires --type systemd|systemd-user|winservice|nssm|schtask. Literal names\nonly; wildcards are refused. Explicit units report every selected host, including\nincompatible backends. Configured aliases retain per-host mapping and skip rules.",
  logs: "Explicit units use --unit NAME --type systemd|systemd-user|winservice|nssm|schtask.\nWindows backends return service/task status. --raw preserves stdout and sends remote\nstderr separately. --json returns per-host action results and fails if any host fails.\n-f/--follow streams the last N lines, then new ones until Ctrl-C (journalctl -f). It\nneeds a selector that matches one host, refuses --json, and refuses Windows backends,\nwhich have no followable log.",
  svc: "Explicit units use --unit NAME --type systemd|systemd-user|winservice|nssm|schtask.\nThe optional selector defaults to all. Configured syntax remains svc <alias> [selector].",
  exec: "Fleet flags go before the selector or directly after it. Quote the remote command as\none argument. --argv preserves literal argument boundaries and requires -- before the\nprogram. It cannot combine with --script or --interp. Without --argv, Fleet joins the\ncommand tokens with spaces, unless a token after the program is empty or holds\nwhitespace: then every token goes as one quoted argument, so `bash -c \"a; b\"` works. You can put -- after the selector to pass all remaining tokens through as the command.\n--script passes tokens after the selector to the script: $1… in shells, $args or param() in\nPowerShell, argv elsewhere.\nQuoting: your local shell parses the command before Fleet sees it, so $vars, nested\nquotes and newlines can change there. Fleet delivers what it receives unchanged. For\nanything holding $, quotes or newlines, or credentials, send it as a script:\nfleet exec --script - --interp bash <host> <<'EOF' (--interp pwsh for PowerShell). Without --interp,\nFleet picks the interpreter from the file extension, else from a #! shebang line; untyped\nstdin requires --interp. For pwsh or powershell Fleet adds -NoProfile -NonInteractive -File\nitself; --interp may add options such as -ExecutionPolicy Bypass, never -Command or -File. --raw keeps stdout unchanged and sends remote diagnostics to stderr. On one host it exits\nwith the remote exit code; otherwise exec exits 0 when every host succeeded and 1 if not.\n--timeout is seconds; 0 disables the SSH cap. Without it, FLEET_EXEC_TIMEOUT, then the\nhost's execTimeoutS setting (fleet config shows it), caps each host. Daytona requires a positive timeout.\nEvery selected host runs at once unless defaults.parallel.exec caps the fan-out.\nA timeout returns the output that arrived so far, with \"timed out after Ns\" on stderr and\ntimedOut: true in --json. It does not prove the remote command stopped. Inspect its outcome before retrying non-idempotent work. Use spawn for long jobs.\n--sudo runs the command as root on POSIX hosts: as is when already root, passwordless\nsudo when it works, else the password from hosts.<h>.sudo (passwordFile or passwordEnv)\nsent over ssh stdin, never argv. With --wsl on a Windows host it runs as WSL root\n(wsl -u root); no password is needed. Commands that look like a reboot or power-off (reboot,\nshutdown /r, systemctl reboot, Restart-Computer, boot-<os> helpers) are refused unless\n--confirm-reboot is given; prefer fleet switch or fleet reboot.\n--fresh logs in again instead of reusing the shared connection or Windows session. Local\nstdin is never forwarded: a command that reads stdin (bash -s, python3 -, cat > f) with a\nfile or pipe on local stdin is refused; use --script - instead.",
  spawn: "Flags go before the selector or directly after it. Optional -- after the selector\nstarts the remote command. Save the returned host:id. Commands and output persist\nin the remote job spool; do not put credentials in the command. Reconnect with jobs\nlog/tail/wait. An unconfirmed launch includes the attempted id; inspect it before\nsubmitting again. Fleet never automatically retries a launch.\n--wsl (Windows hosts) runs the command in bash inside the host's WSL distro, so its\nredirects, pipes and paths are Linux ones instead of PowerShell's.\n--elevated (Windows) runs the job with the administrator token; storage and other CIM\ncmdlets fail with \"Access to a CIM resource was not available\" without it.",
  jobs: "Addressed verbs also accept <host> <id>. tail defaults to 40 lines. Filters apply inclusion, then\nexclusion, then the line limit remotely. Filters are case-sensitive (POSIX ERE / Windows .NET regex). Empty matches\nsucceed; invalid regex and read failures fail. Filtered output is capped at 65536 bytes\nand reports truncation. Filtered lines end in a newline. Filters cannot use --follow.\n--json cannot be combined with --follow. --follow ends when the job exits.\nrm removes one finished job's spool; prune removes every finished job on the selected hosts.\nOptions may precede or follow the job reference.\nwait --until uses case-sensitive POSIX ERE on POSIX hosts and .NET regex on Windows.\nThe dialects differ; Fleet never lowercases patterns or output.\nwait defaults to no overall deadline; use --timeout S for bounded automation.\nExit codes: 0 on match or successful exit, the job code on failure, 124 on timeout,\n1 on dead jobs or inspection errors. A regex match proves only that text appeared.\nA dead job has no verified runner and no exit record. Inspect its logs and artifacts.\nTimeout or Ctrl-C stops observation; it does not cancel or restart the remote job.\nResume observation by running the same wait command. prune removes finished spools;\n--all also removes dead spools. Save needed logs before pruning.",
  tools: "status uses each tool's configured hosts unless you supply a selector. It compares\nthe local content fingerprint with the last sync manifest. It does not verify the\nactive launcher or detect files edited after sync. Exit 1 means stale, missing, or\nunreachable targets; exit 0 requires every selected row to be current.\nsync defaults to the tool's configured hosts. --all requires a selector. Multi-tool\nsync runs defaults.parallel.toolSync tools at a time (two unless set); --max-parallel\noverrides it. status reads defaults.parallel.toolStatusHosts hosts at once (eight unless\nset). stamp updates skill version/date locally.",
  skills: "Ships whole agent skill directories named by the config's skills sets. A set takes\n"
    + "the directories under its root (default ~/.agents/skills) that hold a SKILL.md, keeps\n"
    + "those an include glob matches and drops those an exclude glob matches. A symlinked\n"
    + "skill directory ships as its real contents; node_modules, .git, .DS_Store and ._*\n"
    + "files never ship. A name a tools entry ships stays with fleet tools sync and is\n"
    + "excluded here; list shows it.\n"
    + "On a host the copy lives in ~/.agents/skills/<name>. ~/.claude/skills/<name> and\n"
    + "~/.openclaw/skills/<name> become relative symlinks to it when missing (copies on\n"
    + "Windows). An existing symlink there is left alone; an existing directory is updated\n"
    + "as another copy. ~/.fleet-tools/skills/manifest.json records each name's hash and set.\n"
    + "status compares tree hashes: current, stale (host matches the last sync; safe to\n"
    + "update), drifted (edited on the host since), unmanaged (present without a manifest\n"
    + "entry and different), missing, orphan (recorded but no longer selected), unreachable.\n"
    + "Exit 1 unless every row is current; orphans are listed but do not fail.\n"
    + "sync defaults to each set's hosts. It holds back drifted and unmanaged skills unless\n"
    + "--force, applies the rest, and swaps each skill in whole, writing the manifest last.\n"
    + "An identical unrecorded copy is recorded as is. sync never deletes a skill. --dry-run\n"
    + "shows the plan and writes nothing. Exit 1 when a skill was held or anything failed.\n"
    + "A host with deploy disabled refuses the whole sync before any skill is read or written.",
  cp: "push and pull are aliases of cp; the side with <sel>: decides the direction.\nUse one call for multiple files. Multiple sources require a directory destination.\nPush can fan out; pull requires exactly one host. Quote remote globs. A trailing /\nrequests a directory destination. Copy does not verify the active service or launcher.\nRemote-to-remote and recursive Daytona copies are unsupported.\n--resume copies with rsync --partial: rerun the same command after an interruption\nand it continues the partial file and skips finished ones. It needs rsync on both\nends, so Windows hosts and sandboxes refuse it. A single-host copy on a terminal\nshows a progress meter.",
  wait: "Defaults: SSH condition, 120-second timeout, 3-second interval. Choose one condition.\nExit 0 means ready; exit 1 means the deadline expired or the probe failed. HTTP status\ndefaults to 200. A listening port does not prove application-level success.",
  cu: "Prefer controls over pixels. elements lists a window's accessibility controls with a\ntoken each, no screenshot taken; click/type/set/key/scroll/act take --label TEXT\n(exact label first, then substring; --role and --nth break ties) or --element TOKEN in\nplace of x,y. An ambiguous label is refused with the candidates listed. menu invokes a\nmenu path through accessibility and never falls back to pixels. verify checks state with\ncua-driver verify_state: satisfied exits 0; unsatisfied and unknown exit 1. A reply that\nsays the input was not delivered (escalation delivery_failed) fails the action; retry\nwith --foreground. set and type addressed by --label read the control back when the\npixels are indeterminate or the driver refused: a value that changed and holds the text\ncounts as changed. Some apps ignore background accessibility input entirely.\n\nTARGET is a pid, a window_id (123 or w123, from `windows`), a process name\n(Playnite.DesktopApp[.exe]), an app name, or a window title \u2014 every subcommand accepts\nall five; a number that is a live pid stays a pid. click/key/type/act resolve the target, send an\nexplicit window_id, and report whether the window's pixels changed: changed,\nno_change, or indeterminate. cua-driver's own effect field says \"unverifiable\" for\nsuccessful and no-op input alike, so it is not a success signal. Omitting window_id makes\ncua-driver target the process's FRONTMOST window \u2014 the modal dialog when one is open \u2014 so\nwindow-local coordinates land somewhere unrelated; Fleet never omits it.\nCoordinates are window-local screenshot pixels by default; --space screen takes desktop\npixels. A point outside the target window is refused, not delivered elsewhere.\nshot-window composites owned popups and modal dialogs onto the capture and warns when the\nprocess owns a window above the captured one \u2014 a blocked window looks entirely normal on\nits own. --probe X,Y draws a crosshair where a click would land without clicking.\n--grid burns the coordinate frame (pid, window_id, origin) into the image.\nget_window_state output is collapsed when its accessibility walk found nothing; --full\nrestores the raw body. describe --brief trims the prose; --for TARGET states whether\nelement_index can resolve on that window at all.\nA title match selects that window, including dialogs. act JSON must omit pid/window_id/target and from_zoom;\nFleet supplies the target and validates x/y and both drag endpoints. Raw <tool> {JSON} is a driver passthrough\nwithout these checks. A failed settling capture reports indeterminate; driver errors\nand missing requested images return failure.\nBatch is an array of {tool,args?,space?,delayMs?}. It targets one fixed window, validates\nall coordinates first, and stops at the first driver failure without retrying.\nIt observes only before/after the sequence, not each action. completed confirms driver\nexit, not application effect. unconfirmed means inspect the desktop before more input.\nLimits: 100 actions, 256 KiB JSON, 10000 ms per delay, 60000 ms total delay.\n\ntask hands a bounded subtask to TypeSafe's Jev (a port of arc-cua's action layer). Each\nstep reads the window's controls, asks Jev for the next operation among the controls it\nexposes now (click, double or right click, entering one of your inputs, a key, a chord,\na scroll), sends it through the verified input above, and reads again. Jev never writes\ntext: it picks an --input key and fleet enters that literal value with set_value. A field\nno input fits ends as NEEDS_INPUT and names it. --secret-env KEY=ENVVAR reads a value\nfrom the environment; Jev sees a placeholder. Controls labelled like delete, send,\npurchase or close are refused unless --allow names the category. SUBTASK_COMPLETE needs\nevery --verify criterion judged satisfied; BLOCKED means three actions changed nothing;\nNEEDS_AGENT hands back with a reason. A target that moved or vanished before the input\nis re-read, never guessed. When the process shows a modal dialog over the window, the\ntask works in the dialog. Unlabelled controls are read-only off Windows. On a phone,\nTARGET is the focus gate, RIGHT_CLICK is a long press, ESCAPE is Back, typing goes only\ninto empty fields, and there are no chords. --file takes arc-cua's JSON (goal,\nverification, inputs, secret_inputs, constraints, allowed_risks, shortcuts,\nmax_actions). Progress prints to stderr. Exit 0 for SUBTASK_COMPLETE and --dry-run. Needs\nTYPESAFE_API_KEY or FLEET_JEV_CONFIG on this machine; each step is one Jev request.\n\nAndroid: a host with an \"android\" block is a phone reached over SSH into Termux, whose\nadb drives the phone's own adbd (127.0.0.1:5555 by default, after adb tcpip 5555).\nelements reads the UI tree with uiautomator, no screenshot. Coordinates are device\npixels. TARGET is the package that must hold focus (a word in it matches) or \"any\";\ninput is refused before delivery when another package holds focus, the screen is\noff, or the phone is locked. Effect comes from frame hashes taken on the phone with\nthe status bar cut off. type sends printable ASCII only and reads the focused field\nback. Keys that turn the screen off are refused. shot encodes WebP on the phone at\nhalf size; --grid captures full size so its labels are device pixels. A label action\nreuses the tree the last elements read when the screen still hashes the same, and\nthe phone sends nothing if it does not. After a reboot, turn on Wireless debugging\nand run bootstrap: Termux finds its port and switches adbd back to the fixed one.\nWhen SSH to Termux is down, revive uses this machine's adb over the network to open\nTermux (whose shell setup starts sshd) and returns to the app you were in; --restart\nforce-stops Termux first, ending its sessions.\nwatch opens a live scrcpy (5.0+) window of the phone on this machine; record writes an MP4 here\nwith scrcpy (the phone's own screenrecord is blocked on some ROMs). Both need adb and\nscrcpy on this machine and a phone adbd reachable over the network.\nswipe2 lands two fingers together at X1,Y1 and X2,Y2 and moves both by DX,DY (default\n200 ms). zoom in spreads two fingers apart on a diagonal, zoom out pinches them\ntogether; --scale is the far-to-near spacing ratio (default 2.5). With no point and no\nlabel, zoom guesses its target from the UI tree: the largest image, map, web, or\nterminal view, else the largest scrollable one. The fingers stay 8% inside the target\nand the display. gesture sends 1-5 fingers that land together, one straight stroke\neach. These three go through the helper below, since adb's input sends one finger.\nbatch runs up to 50 steps ({action: tap|long_press|swipe|swipe2|gesture|scroll|key|type|\nsleep, x, y, x2, y2, dx, dy, strokes, label, role, nth, key, text, direction, amount, ms}) in one round trip with one\nbefore/after check. Labels resolve against the screen before the batch; each later\nlabel step checks its element's rows still match, and every step re-checks focus. The\nfirst failure stops the batch. wait polls on the phone until a label appears (--gone:\ndisappears) or a package holds focus, confirmed with the same matcher as a label tap.\nflow runs up to 30 steps ({action: open|wait|expect|tap|long_press|type|scroll|key|sleep, what, in, label, role,\nnth, text, focus, gone, timeoutMs, key, direction, amount, ms}) one after another. Label inputs resolve against\nthe current screen and can reuse a tree after a frame check. expect reads the tree; wait polls its condition.\nopen sets the target for later input and verifies focus for a named package or a URL with in. A URL without in\nbinds the observed package, which may be Android's chooser. Use in to select the destination app.\n--target PACKAGE sets the initial focus gate. The default any allows any app until open sets a package.\nEach input checks focus before delivery; type checks again after its field tap. expect checks a label and optional\ntext. gone requires an absent label; gone with text is rejected pending a predicate decision. The first failure\nstops the flow and marks later steps not_run. A final read failure appears as readError and preserves the outcome.\nThe final screen read runs by default. Trailing --read FILTER narrows it; --no-read skips it. --json emits one value.\nLimits: sleep 0-10000 ms, long_press 1-10000 ms, wait timeoutMs 0-120000, scroll amount 1-10, nth a positive integer.\nTree reads go through a small helper fleet installs on first use (a dex run by adb's\nshell through app_process; nothing is installed as an app). It holds an accessibility\nconnection, answers in ~0.1 s, and exits after 2 idle minutes; release stops it now.",
  watch: "Reruns one command on one host every -n seconds (default 2, minimum 0.5, fractions\nallowed) through the normal exec path, like watch(1). On a terminal each run redraws the\nscreen under a header with the host, interval, command, time and exit code; --diff\nhighlights lines that changed since the previous run. Without a terminal each run prints\nafter a timestamp line, remote stderr going to stderr. --until REGEX exits 0 once stdout\nor stderr matches (a case-sensitive JavaScript regex matched here; ^ and $ anchor lines);\n--timeout S (whole seconds, needs --until) exits 1 when no run matched in time. Ctrl-C\nexits 0.",
  edit: "Omitting --new or passing --new \"\" deletes the matched text. A present --new\nwithout a value is an error. Use --old=--flag for option-looking literal text.\nFleet requires one match unless --all is set, checks for concurrent modification,\nand prints changed lines. --dry-run does not write.\n--old/--new are literal: \\n stays a backslash and an n. --escapes turns \\n, \\t and\n\\\\ in --old/--new into a newline, a tab and a backslash. For multi-line text,\nprefer --old-file or --new-file with a local file, or - for stdin. In a file that\nuses CRLF (or LF) throughout, newlines in --old/--new are converted to match it.\n--edits F|- takes a JSON array of {\"old\", \"new\", \"all\"} edits for one file. They\napply in order with one read and one write; if any edit fails, nothing is written.\nA miss names its cause where it can: line endings, whitespace, letter case, or the\nfirst line of --old that differs from the file.\n--sudo reads and writes as root on POSIX hosts: passwordless sudo, or the password\nconfigured in hosts.<h>.sudo.",
  diff: "Each side is <sel>:<path> on one host (Linux, macOS, Windows) or a local path. Both\nfiles are fetched, then diffed locally with N lines of context (default 3).\nExit 0 identical, 1 different, 2 error, like diff(1). Binary files (NUL bytes or\ninvalid UTF-8) and files over 4 MiB are refused before any diff.\n--json emits {identical, a, b, diff}; an error emits {ok:false, error} and exits 2.",
};

/** Sections of the `fleet help` overview. A command missing here lands under Other. */
const groups: [string, string[]][] = [
  ["Hosts and status", ["ls", "dt", "status", "gpu", "disk", "which", "ps", "ports", "top", "session", "doctor", "find", "hostkey", "config"]],
  ["Run commands and jobs", ["exec", "spawn", "watch", "jobs", "kill", "run", "ssh"]],
  ["Files and tools", ["cp", "edit", "du", "diff", "deploy", "tools", "skills"]],
  ["Services", ["restart", "logs", "svc"]],
  ["Power and boot", ["reboot", "bios", "boot", "switch", "wait"]],
  ["Desktop and devices", ["shot", "webcam", "cu", "browse"]],
  ["Connections", ["drop", "proxy"]],
  ["Shell", ["completion", "help"]],
];

export function overviewGroups(): [string, string[]][] {
  const listed = new Set(groups.flatMap(([, names]) => names));
  const out = groups.map(([title, names]) => [title, names.filter((name) => usage[name])] as [string, string[]]);
  const other = Object.keys(usage).filter((name) => !listed.has(name));
  return [...out, ...(other.length ? [["Other", other] as [string, string[]]] : [])].filter(([, names]) => names.length);
}

const sgr = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const heading = new Set(groups.map(([title]) => title).concat("Other"));
const shouted = /\b(ONLY|NOT|THROUGH|FRONTMOST|BEFORE)\b/g;
const flag = /(?<![\w-])(--?[A-Za-z][\w-]*)/g;

/** Colours the syntax of a usage line: command bold, flags cyan, placeholders yellow,
 *  brackets dim. A description after a two-space gap stays plain. */
function paintUsage(line: string): string {
  const lead = line.match(/^\s*/)![0];
  let body = line.slice(lead.length);
  let desc = "";
  // Syntax after a gap (`[--json]  |  task <TARGET>`) has brackets, flags or bars; prose has none.
  const gap = body.search(/\S\s{2,}[a-z]/);
  if (gap >= 0 && !/[<|[]|\s-/.test(body.slice(gap + 1))) { desc = body.slice(gap + 1); body = body.slice(0, gap + 1); }
  let cmd = "";
  const head = body.match(/^(fleet )([\w-]+(?: [a-z][\w-]*(?=\s|$))?)/);
  if (head) { cmd = sgr("2", head[1]!) + sgr("1", head[2]!); body = body.slice(head[0].length); }
  body = body.replace(/(<[^>]+>)|(--?[A-Za-z][\w-]*)|(\b[A-Z][A-Z0-9_-]*\b…?)|([\[\](){}|])/g,
    (m, ph, fl, caps, punct) => ph || caps ? sgr("33", m) : fl ? sgr("36", m) : punct ? sgr("2", m) : m);
  return lead + cmd + body + desc;
}

/** Help on a terminal: bold headings and labels, coloured syntax and flags. The text is
 *  unchanged, so piped help stays byte-identical to the plain form. */
function paintHelp(text: string, color: boolean): string {
  if (!color) return text;
  let inUsage = false;
  return text.split("\n").map((line) => {
    if (heading.has(line)) return sgr("1;4", line);
    if (line.startsWith("Usage: ")) { inUsage = true; return sgr("1", "Usage:") + " " + paintUsage(line.slice(7)); }
    if (/^ {2}fleet /.test(line)) return paintUsage(line);
    if (inUsage && /^ {4}\S/.test(line)) return paintUsage(line);
    if (line === "") inUsage = false;
    if (line.startsWith("fleet - ")) return sgr("1", "fleet") + " - " + line.slice(8);
    return line
      .replace(/^([A-Z][A-Za-z]*(?: [a-z]+)?(?: \([^)]*\))?:)(?=\s|$)/, (m) => sgr("1", m))
      .replace(flag, (m) => sgr("36", m))
      .replace(shouted, (m) => sgr("1", m));
  }).join("\n");
}

const aliases: Record<string, string> = { hosts: "ls", service: "svc", screenshot: "shot", computer: "cu", push: "cp", pull: "cp", job: "jobs" };
const subcommands: Record<string, string[]> = {
  proxy: ["list", "check", "drop"],
  jobs: ["list", "log", "tail", "wait", "kill", "rm", "prune"],
  tools: ["list", "status", "sync", "stamp"],
  skills: ["list", "status", "sync"],
};

/** `color` comes from the caller: help.ts never inspects the terminal itself. */
export function helpText(argv: string[], color = false): string | undefined {
  let [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") { command = "help"; }
  if (command === "help") { command = rest.shift(); }
  else {
    // Only consume a help-only command prefix. Never steal a payload's --help.
    const helpAt = rest.findIndex((arg) => arg === "--help" || arg === "-h");
    if (helpAt < 0 || helpAt !== rest.length - 1) return undefined;
    const prefix = rest.slice(0, helpAt);
    if (prefix.length && !(prefix.length === 1 && subcommands[command]?.includes(prefix[0]!))) return undefined;
    rest = prefix;
  }
  if (!command) return paintHelp("fleet - remote commands, detached jobs, transfers, and tool sync\n\n"
    + overviewGroups().map(([title, names]) => `${title}\n${names.map((name) => `  fleet ${usage[name]}`).join("\n")}`).join("\n\n")
    + "\n\nSelectors: host | logical route | @group | all | a,b,@group | dt:<sandbox>\n"
    + "Run fleet ls for configured hosts. Run fleet help <command> for defaults and recovery.\n"
    + "Help performs no configuration reads or network operations.\n", color);
  command = aliases[command] ?? command;
  if (!usage[command] || rest.length > 1 || (rest.length && !subcommands[command]?.includes(rest[0]!)))
    throw new Error(`unknown help topic: ${[command, ...rest].join(" ")}`);
  const jsonErrors = ["exec", "spawn", "jobs", "cp", "edit", "tools", "skills", "restart", "logs", "svc"].includes(command)
    ? "\n--json failures emit one {ok:false,error:{code,message},command} value and exit 1.\nExisting per-host result shapes and exit statuses remain unchanged. Failure messages\nomit input/config contents. Payload --json options do not enable Fleet JSON mode.\n" : "";
  return paintHelp(`Usage: fleet ${usage[command]}\n${detail[command] ? "\n" + detail[command] + "\n" : ""}${jsonErrors}`, color);
}
