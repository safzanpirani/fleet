/** Static help must work without configuration, SSH, or a dashboard. */
const usage: Record<string, string> = {
  ls: "ls [--json]                         list host reachability and services (alias: hosts)",
  dt: "dt [--json]                         list Daytona sandboxes",
  exec: "exec [--cwd DIR] [--timeout S] [--wsl] [--sudo] [--fresh] [--confirm-reboot] [--raw | --json] <sel> [--] <cmd…>\n  fleet exec --script <file|-> [--interp CMD] [--cwd DIR] [--timeout S] [--wsl] [--sudo] [--confirm-reboot] [--raw | --json] <sel>",
  spawn: "spawn [--wsl] [--elevated] [--fresh] [--confirm-reboot] [--cwd DIR] [--label NAME] [--json] <sel> [--] <cmd…>",
  jobs: "jobs [list] [<sel>] [--json]\n  fleet jobs log <host:id> [--json]\n  fleet jobs tail <host:id> [-n N | --lines N] [-f | --follow] [--json]\n  fleet jobs wait <host:id> [--until REGEX] [--timeout S] [--json]\n  fleet jobs kill <host:id> [--json]\n  fleet jobs prune [<sel>] [--all] [--json]",
  cp: "cp [-r | --recursive] [--resume] [--json] <local…> <sel>:<remote>\n  fleet cp [-r | --recursive] [--resume] [--json] <sel>:<remote…> <local>",
  edit: "edit <sel>:<path> --old TEXT|--old-file F [--new TEXT|--new-file F] [--all] [--dry-run] [--sudo] [--wsl] [--json]",
  restart: "restart <sel> <service>",
  reboot: "reboot <sel> [--yes | -y]",
  bios: "bios <sel> [--yes | -y]",
  boot: "boot <machine> [--entries] [--json]",
  switch: "switch <machine> --to OS [--yes | -y] [--dry-run] [--no-wait] [--timeout S] [--json]",
  wait: "wait <host|machine> [--ssh | --port N | --http URL [--status N] | --boot OS]\n    [--timeout S] [--interval S] [--json]",
  gpu: "gpu [--json]                        read GPU stats from the dashboard",
  disk: "disk [<sel>] [--json]                read mounted-volume space from hosts",
  status: "status [<host>] [--json]             read dashboard stats",
  top: "top <host>                          live dashboard; Ctrl-C exits",
  logs: "logs <sel> <service> [-n N]          read configured service logs",
  svc: "svc <service> [<sel>] [--json]        check a service across hosts",
  shot: "shot <host> [--output NAME|main|focused|N] [--region AREA] [--wake] [--out FILE] [--grid] [--grid-step N] [--no-open]\n  fleet shot <host> --list [--json]",
  cu: "cu <host> <tool> [JSON] [--out FILE] [--grid] [--grid-step N] [--full] [--no-open]\n  fleet cu <sel> install\n  fleet cu <host> tools [FILTER] | describe <tool> [--brief] [--for TARGET] | apps [FILTER] [--all]\n  fleet cu <host> windows [TARGET] | shot-window <TARGET> [--out FILE] [--probe X,Y]\n  fleet cu <host> open <APP> [URL|ARG] | open <URL> [--wait MS] [--json]\n  fleet cu <host> elements <TARGET> [FILTER] [--role R] [--max N] [--task TEXT] [--json]\n  fleet cu <host> verify <TARGET> <JSON> | verify <TARGET> --label L [--role R] [--value V] [--timeout MS]\n  fleet cu <host> click <TARGET> <X> <Y> [--space window|screen] [--button B] [--count N]\n  fleet cu <host> right-click|double-click <TARGET> <X> <Y>\n  fleet cu <host> click|right-click|double-click <TARGET> --label TEXT [--role R] [--nth N] | --element TOKEN\n  fleet cu <host> drag <TARGET> <FROM-X> <FROM-Y> <TO-X> <TO-Y> [--duration MS]\n  fleet cu <host> scroll <TARGET> <up|down|left|right> [AMOUNT] [--by line|page]\n  fleet cu <host> hotkey <TARGET> <MODIFIER> <KEY> [KEY\u2026]\n  fleet cu <host> key <TARGET> <KEY> | type <TARGET> <TEXT> | act <TARGET> <tool> [JSON]\n  fleet cu <host> set <TARGET> <VALUE> --label TEXT | --element TOKEN\n  fleet cu <host> menu <TARGET> <ITEM> [ITEM\u2026]\n  fleet cu <host> batch <TARGET> <JSON-array|-> [--json] | batch <TARGET> --file FILE\n    shared by named input/batch: [--foreground] [--space window|screen] [--settle MS] [--shot] [--grid] [--json]\n  fleet cu <host> record start|stop|status [--out DIR]\n  fleet cu <phone> doctor | state | release | bootstrap [PAIR-PORT PAIR-CODE] | apps [FILTER]\n  fleet cu <phone> notifications [PACKAGE] [--max N] | revive [--restart]\n  fleet cu <phone> watch [--view-only] | record start [--out FILE] [--limit S] [--bit-rate M] | record stop|status\n  fleet cu <phone> elements [FILTER] [--role R] [--all]\n  fleet cu <phone> shot [--out FILE] [--width N] [--grid] | open <PACKAGE|URL> [--in PACKAGE] [--wait MS]\n  fleet cu <phone> tap|long-press <TARGET> <X> <Y> | --label TEXT [--role R] [--nth N]\n  fleet cu <phone> swipe <TARGET> <X1> <Y1> <X2> <Y2> [--duration MS] | scroll <TARGET> <DIR> [N]\n  fleet cu <phone> swipe2 <TARGET> <X1> <Y1> <X2> <Y2> <DX> <DY> [--duration MS]\n  fleet cu <phone> zoom <TARGET> <in|out> [X Y | --label TEXT] [--scale F] | gesture <TARGET> <X1,Y1,X2,Y2>…\n  fleet cu <phone> key <TARGET> <KEY> | type <TARGET> <TEXT> [--label TEXT]\n  fleet cu <phone> batch <TARGET> <JSON-array|-> [--gap MS] | batch <TARGET> --file FILE\n  fleet cu <phone> wait --label TEXT [--role R] [--gone] | wait --focus PACKAGE [--timeout MS]",
  browse: "browse <host> [URL]                  verify configured CDP and list targets",
  run: "run <recipe>                        run configured steps; stop on failure",
  deploy: "deploy <sel> [--restart SERVICE | --no-restart] [--json]",
  tools: "tools list [--json]\n  fleet tools status [tool] [<sel>] [--json]\n  fleet tools sync <tool|--all> [<sel>] [--no-skill] [--max-parallel N] [--json]\n  fleet tools stamp [tool] [--json]",
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
  shot: "--output takes a connector name (DP-3), main (the X11/macOS primary, else the monitor at\n"
    + "0,0), focused, or a 1-based index; --list shows them with position, logical size and scale.\n"
    + "--region takes top-left, top-right, bottom-left, bottom-right, top, bottom, left, right,\n"
    + "center, or X,Y,W,H fractions of that monitor (main when --output is omitted). On Wayland a\n"
    + "powered-off monitor renders no frames, so a capture involving one is refused; --wake\n"
    + "switches it on for the capture and back off. Windows resolves --output inside the user's\n"
    + "session: main, an index, or DISPLAYn.",
  session: "Linux reads logind, the compositor (a Hyprland session lock shows as LOCK in its monitor\n"
    + "list), locker processes and DPMS; Windows reads query user and LogonUI; macOS reads\n"
    + "IOConsoleUsers. Idle time is reported only where the desktop exposes it.",
  drop: "fleet reuses one ssh connection per host for a minute, and a Windows host's PowerShell\n"
    + "session for ten. Either keeps the login's groups: after usermod -aG, drop the host or pass\n"
    + "--fresh to exec, --script or spawn.",
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
  exec: "Put Fleet flags BEFORE the selector. Quote the remote command as one argument, or\nput -- after the selector to pass all remaining tokens through as the command.\nYour local shell expands unquoted variables before Fleet receives them. For multiline\ncode or credentials, use a protected script file or stdin with --script. Untyped stdin\nrequires --interp. --raw keeps stdout unchanged and sends remote diagnostics to stderr.\n--timeout is seconds; 0 disables the SSH cap. Daytona requires a positive timeout.\nA timeout does not prove the remote command stopped. Inspect its outcome before retrying non-idempotent work. Use spawn for long jobs.\n--sudo runs the command as root on POSIX hosts: as is when already root, passwordless\nsudo when it works, else the password from hosts.<h>.sudo (passwordFile or passwordEnv)\nsent over ssh stdin, never argv. Commands that look like a reboot or power-off (reboot,\nshutdown /r, systemctl reboot, Restart-Computer, boot-<os> helpers) are refused unless\n--confirm-reboot is given; prefer fleet switch or fleet reboot.\n--fresh logs in again instead of reusing the shared connection or Windows session. Local\nstdin is never forwarded: a command that reads stdin (bash -s, python3 -, cat > f) with a\nfile or pipe on local stdin is refused; use --script - instead.",
  spawn: "Put flags BEFORE the selector. Optional -- after the selector starts the remote\ncommand. Save the returned host:id. Commands and output persist\nin the remote job spool; do not put credentials in the command. Reconnect with jobs\nlog/tail/wait. An unconfirmed launch includes the attempted id; inspect it before\nsubmitting again. Fleet never automatically retries a launch.\n--wsl (Windows hosts) runs the command in bash inside the host's WSL distro, so its\nredirects, pipes and paths are Linux ones instead of PowerShell's.\n--elevated (Windows) runs the job with the administrator token; storage and other CIM\ncmdlets fail with \"Access to a CIM resource was not available\" without it.",
  jobs: "Addressed verbs also accept <host> <id>. tail defaults to 40 lines. --json cannot\nbe combined with --follow. Options may precede or follow the job reference.\nwait defaults to no overall deadline; use --timeout S for bounded automation.\nExit codes: 0 on match or successful exit, the job code on failure, 124 on timeout,\n1 on dead jobs or inspection errors. A regex match proves only that text appeared.\nA dead job has no verified runner and no exit record. Inspect its logs and artifacts.\nTimeout or Ctrl-C stops observation; it does not cancel or restart the remote job.\nResume observation by running the same wait command. prune removes finished spools;\n--all also removes dead spools. Save needed logs before pruning.",
  tools: "status uses each tool's configured hosts unless you supply a selector. It compares\nthe local content fingerprint with the last sync manifest. It does not verify the\nactive launcher or detect files edited after sync. Exit 1 means stale, missing, or\nunreachable targets; exit 0 requires every selected row to be current.\nsync defaults to the tool's configured hosts. --all requires a selector. Multi-tool\nsync defaults to two tools at a time. stamp updates skill version/date locally.",
  cp: "Use one call for multiple files. Multiple sources require a directory destination.\nPush can fan out; pull requires exactly one host. Quote remote globs. A trailing /\nrequests a directory destination. Copy does not verify the active service or launcher.\nRemote-to-remote and recursive Daytona copies are unsupported.\n--resume copies with rsync --partial: rerun the same command after an interruption\nand it continues the partial file and skips finished ones. It needs rsync on both\nends, so Windows hosts and sandboxes refuse it. A single-host copy on a terminal\nshows a progress meter.",
  wait: "Defaults: SSH condition, 120-second timeout, 3-second interval. Choose one condition.\nExit 0 means ready; exit 1 means the deadline expired or the probe failed. HTTP status\ndefaults to 200. A listening port does not prove application-level success.",
  cu: "Prefer controls over pixels. elements lists a window's accessibility controls with a\ntoken each, no screenshot taken; click/type/set/key/scroll/act take --label TEXT\n(exact label first, then substring; --role and --nth break ties) or --element TOKEN in\nplace of x,y. An ambiguous label is refused with the candidates listed. menu invokes a\nmenu path through accessibility and never falls back to pixels. verify checks state with\ncua-driver verify_state: satisfied exits 0; unsatisfied and unknown exit 1. A reply that\nsays the input was not delivered (escalation delivery_failed) fails the action; retry\nwith --foreground. set and type addressed by --label read the control back when the\npixels are indeterminate or the driver refused: a value that changed and holds the text\ncounts as changed. Some apps ignore background accessibility input entirely.\n\nTARGET is a pid, a window_id (123 or w123, from `windows`), a process name\n(Playnite.DesktopApp[.exe]), an app name, or a window title \u2014 every subcommand accepts\nall five; a number that is a live pid stays a pid. click/key/type/act resolve the target, send an\nexplicit window_id, and report whether the window's pixels actually changed: changed,\nno_change, or indeterminate. cua-driver's own effect field says \"unverifiable\" for\nsuccessful and no-op input alike, so it is not a success signal. Omitting window_id makes\ncua-driver target the process's FRONTMOST window \u2014 the modal dialog when one is open \u2014 so\nwindow-local coordinates land somewhere unrelated; Fleet never omits it.\nCoordinates are window-local screenshot pixels by default; --space screen takes desktop\npixels. A point outside the target window is refused, not delivered elsewhere.\nshot-window composites owned popups and modal dialogs onto the capture and warns when the\nprocess owns a window above the captured one \u2014 a blocked window looks entirely normal on\nits own. --probe X,Y draws a crosshair where a click would land without clicking.\n--grid burns the coordinate frame (pid, window_id, origin) into the image.\nget_window_state output is collapsed when its accessibility walk found nothing; --full\nrestores the raw body. describe --brief trims the prose; --for TARGET states whether\nelement_index can resolve on that window at all.\nA title match selects that window, including dialogs. act JSON must omit pid/window_id/target and from_zoom;\nFleet supplies the target and validates x/y and both drag endpoints. Raw <tool> {JSON} is a driver passthrough\nwithout these checks. A failed settling capture reports indeterminate; driver errors\nand missing requested images return failure.\nBatch is an array of {tool,args?,space?,delayMs?}. It targets one fixed window, validates\nall coordinates first, and stops at the first driver failure without retrying.\nIt observes only before/after the sequence, not each action. completed confirms driver\nexit, not application effect. unconfirmed means inspect the desktop before more input.\nLimits: 100 actions, 256 KiB JSON, 10000 ms per delay, 60000 ms total delay.\n\nAndroid: a host with an \"android\" block is a phone reached over SSH into Termux, whose\nadb drives the phone's own adbd (127.0.0.1:5555 by default, after adb tcpip 5555).\nelements reads the UI tree with uiautomator, no screenshot. Coordinates are device\npixels. TARGET is the package that must hold focus (a word in it matches) or \"any\";\ninput is refused before delivery when another package holds focus, the screen is\noff, or the phone is locked. Effect comes from frame hashes taken on the phone with\nthe status bar cut off. type sends printable ASCII only and reads the focused field\nback. Keys that turn the screen off are refused. shot encodes WebP on the phone at\nhalf size; --grid captures full size so its labels are device pixels. A label action\nreuses the tree the last elements read when the screen still hashes the same, and\nthe phone sends nothing if it does not. After a reboot, turn on Wireless debugging\nand run bootstrap: Termux finds its port and switches adbd back to the fixed one.\nWhen SSH to Termux is down, revive uses this machine's adb over the network to open\nTermux (whose shell setup starts sshd) and returns to the app you were in; --restart\nforce-stops Termux first, ending its sessions.\nwatch opens a live scrcpy window of the phone on this machine; record writes an MP4 here\nwith scrcpy (the phone's own screenrecord is blocked on some ROMs). Both need adb and\nscrcpy on this machine and a phone adbd reachable over the network.\nswipe2 lands two fingers together at X1,Y1 and X2,Y2 and moves both by DX,DY (default\n200 ms). zoom in spreads two fingers apart on a diagonal, zoom out pinches them\ntogether; --scale is the far-to-near spacing ratio (default 2.5). With no point and no\nlabel, zoom guesses its target from the UI tree: the largest image, map, web, or\nterminal view, else the largest scrollable one. The fingers stay 8% inside the target\nand the display. gesture sends 1-5 fingers that land together, one straight stroke\neach. These three go through the helper below, since adb's input sends one finger.\nbatch runs up to 50 steps ({action: tap|long_press|swipe|swipe2|gesture|scroll|key|type|\nsleep, x, y, x2, y2, dx, dy, strokes, label, role, nth, key, text, direction, amount, ms}) in one round trip with one\nbefore/after check. Labels resolve against the screen before the batch; each later\nlabel step checks its element's rows still match, and every step re-checks focus. The\nfirst failure stops the batch. wait polls on the phone until a label appears (--gone:\ndisappears) or a package holds focus, confirmed with the same matcher as a label tap.\nTree reads go through a small helper fleet installs on first use (a dex run by adb's\nshell through app_process; nothing is installed as an app). It holds an accessibility\nconnection, answers in ~0.1 s, and exits after 2 idle minutes; release stops it now.",
  edit: "Omitting --new or passing --new \"\" deletes the matched text. A present --new\nwithout a value is an error. Use --old=--flag for option-looking literal text.\nFleet requires one match unless --all is set, checks for concurrent modification,\nand prints changed lines. --dry-run does not write.\nFleet never unescapes \\n in --old/--new. For multi-line text, pass --old-file or\n--new-file with a local file, or - for stdin. --sudo reads and writes as root on\nPOSIX hosts: passwordless sudo, or the password configured in hosts.<h>.sudo.",
};

const aliases: Record<string, string> = { hosts: "ls", service: "svc", screenshot: "shot", computer: "cu" };
const subcommands: Record<string, string[]> = {
  proxy: ["list", "check", "drop"],
  jobs: ["list", "log", "tail", "wait", "kill", "prune"],
  tools: ["list", "status", "sync", "stamp"],
};

export function helpText(argv: string[]): string | undefined {
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
  if (!command) return "fleet - remote commands, detached jobs, transfers, and tool sync\n\n"
    + Object.values(usage).map((line) => `  fleet ${line}`).join("\n")
    + "\n\nSelectors: host | logical route | @group | all | a,b,@group | dt:<sandbox>\n"
    + "Run fleet ls for configured hosts. Run fleet help <command> for defaults and recovery.\n"
    + "Help performs no configuration reads or network operations.\n";
  command = aliases[command] ?? command;
  if (!usage[command] || rest.length > 1 || (rest.length && !subcommands[command]?.includes(rest[0]!)))
    throw new Error(`unknown help topic: ${[command, ...rest].join(" ")}`);
  return `Usage: fleet ${usage[command]}\n${detail[command] ? "\n" + detail[command] + "\n" : ""}`;
}
