/** Static help must work without configuration, SSH, or a dashboard. */
const usage: Record<string, string> = {
  ls: "ls [--json]                         list host reachability and services (alias: hosts)",
  dt: "dt [--json]                         list Daytona sandboxes",
  exec: "exec [--cwd DIR] [--timeout S] [--wsl] [--raw | --json] <sel> [--] <cmd…>\n  fleet exec --script <file|-> [--interp CMD] [--cwd DIR] [--timeout S] [--wsl] [--raw | --json] <sel>",
  spawn: "spawn [--cwd DIR] [--label NAME] [--json] <sel> [--] <cmd…>",
  jobs: "jobs [list] [<sel>] [--json]\n  fleet jobs log <host:id> [--json]\n  fleet jobs tail <host:id> [-n N | --lines N] [-f | --follow] [--json]\n  fleet jobs wait <host:id> [--until REGEX] [--timeout S] [--json]\n  fleet jobs kill <host:id> [--json]\n  fleet jobs prune [<sel>] [--all] [--json]",
  cp: "cp [-r | --recursive] [--json] <local…> <sel>:<remote>\n  fleet cp [-r | --recursive] [--json] <sel>:<remote…> <local>",
  edit: "edit <sel>:<path> --old TEXT [--new TEXT] [--all] [--dry-run] [--wsl] [--json]",
  restart: "restart <sel> <service>",
  reboot: "reboot <sel> [--yes | -y]",
  bios: "bios <sel> [--yes | -y]",
  boot: "boot <machine> [--json]",
  switch: "switch <machine> --to OS [--yes | -y] [--no-wait] [--timeout S]",
  wait: "wait <host|machine> [--ssh | --port N | --http URL [--status N] | --boot OS]\n    [--timeout S] [--interval S] [--json]",
  gpu: "gpu [--json]                        read GPU stats from the dashboard",
  disk: "disk [<sel>] [--json]                read mounted-volume space from hosts",
  status: "status [<host>] [--json]             read dashboard stats",
  top: "top <host>                          live dashboard; Ctrl-C exits",
  logs: "logs <sel> <service> [-n N]          read configured service logs",
  svc: "svc <service> [<sel>] [--json]        check a service across hosts",
  shot: "shot <host> [--out FILE] [--grid] [--grid-step N] [--no-open]",
  cu: "cu <host> <tool> [JSON] [--out FILE] [--grid] [--grid-step N] [--full] [--no-open]\n  fleet cu <sel> install\n  fleet cu <host> tools [FILTER] | describe <tool> [--brief] [--for TARGET] | apps [FILTER]\n  fleet cu <host> windows [TARGET] | shot-window <TARGET> [--out FILE] [--probe X,Y]\n  fleet cu <host> click <TARGET> <X> <Y> [--space window|screen] [--button B] [--count N]\n  fleet cu <host> right-click|double-click <TARGET> <X> <Y>\n  fleet cu <host> drag <TARGET> <FROM-X> <FROM-Y> <TO-X> <TO-Y> [--duration MS]\n  fleet cu <host> scroll <TARGET> <up|down|left|right> [AMOUNT] [--by line|page]\n  fleet cu <host> hotkey <TARGET> <MODIFIER> <KEY> [KEY…]\n  fleet cu <host> key <TARGET> <KEY> | type <TARGET> <TEXT> | act <TARGET> <tool> [JSON]\n  fleet cu <host> batch <TARGET> <JSON-array|-> [--json] | batch <TARGET> --file FILE\n    shared by named input/batch: [--foreground] [--space window|screen] [--settle MS] [--shot] [--grid] [--json]\n  fleet cu <host> record start|stop|status [--out DIR]",
  browse: "browse <host> [URL]                  verify configured CDP and list targets",
  run: "run <recipe>                        run configured steps; stop on failure",
  deploy: "deploy <sel> [--restart SERVICE | --no-restart] [--json]",
  tools: "tools list [--json]\n  fleet tools status [tool] [<sel>] [--json]\n  fleet tools sync <tool|--all> [<sel>] [--no-skill] [--max-parallel N] [--json]\n  fleet tools stamp [tool] [--json]",
  doctor: "doctor <host> [--json]               diagnose SSH and health reachability",
  completion: "completion [bash|zsh]               emit shell completion using config",
  ssh: "ssh <host>                          open an interactive SSH session",
  help: "help [command [subcommand]]         show help without loading config",
};

const detail: Record<string, string> = {
  exec: "Put Fleet flags BEFORE the selector. Quote the remote command as one argument, or\nput -- after the selector to pass all remaining tokens through as the command.\nYour local shell expands unquoted variables before Fleet receives them. For multiline\ncode or credentials, use a protected script file or stdin with --script. Untyped stdin\nrequires --interp. --raw keeps stdout unchanged and sends remote diagnostics to stderr.\n--timeout is seconds; 0 disables the SSH cap. Daytona requires a positive timeout.\nA timeout does not prove the remote command stopped. Inspect its outcome before retrying non-idempotent work. Use spawn for long jobs.",
  spawn: "Put flags BEFORE the selector. Optional -- after the selector starts the remote\ncommand. Save the returned host:id. Commands and output persist\nin the remote job spool; do not put credentials in the command. Reconnect with jobs\nlog/tail/wait. An unconfirmed launch includes the attempted id; inspect it before\nsubmitting again. Fleet never automatically retries a launch.",
  jobs: "Addressed verbs also accept <host> <id>. tail defaults to 40 lines. --json cannot\nbe combined with --follow. Options may precede or follow the job reference.\nwait defaults to no overall deadline; use --timeout S for bounded automation.\nExit codes: 0 on match or successful exit, the job code on failure, 124 on timeout,\n1 on dead jobs or inspection errors. A regex match proves only that text appeared.\nA dead job has no verified runner and no exit record. Inspect its logs and artifacts.\nTimeout or Ctrl-C stops observation; it does not cancel or restart the remote job.\nResume observation by running the same wait command. prune removes finished spools;\n--all also removes dead spools. Save needed logs before pruning.",
  tools: "status uses each tool's configured hosts unless you supply a selector. It compares\nthe local content fingerprint with the last sync manifest. It does not verify the\nactive launcher or detect files edited after sync. Exit 1 means stale, missing, or\nunreachable targets; exit 0 requires every selected row to be current.\nsync defaults to the tool's configured hosts. --all requires a selector. Multi-tool\nsync defaults to two tools at a time. stamp updates skill version/date locally.",
  cp: "Use one call for multiple files. Multiple sources require a directory destination.\nPush can fan out; pull requires exactly one host. Quote remote globs. A trailing /\nrequests a directory destination. Copy does not verify the active service or launcher.\nRemote-to-remote and recursive Daytona copies are unsupported.",
  wait: "Defaults: SSH condition, 120-second timeout, 3-second interval. Choose one condition.\nExit 0 means ready; exit 1 means the deadline expired or the probe failed. HTTP status\ndefaults to 200. A listening port does not prove application-level success.",
  cu: "TARGET is a pid, a process name (Playnite.DesktopApp[.exe]), an app name, or a window\ntitle \u2014 every subcommand accepts all four. click/key/type/act resolve the target, send an\nexplicit window_id, and report whether the window's pixels actually changed: changed,\nno_change, or indeterminate. cua-driver's own effect field says \"unverifiable\" for\nsuccessful and no-op input alike, so it is not a success signal. Omitting window_id makes\ncua-driver target the process's FRONTMOST window \u2014 the modal dialog when one is open \u2014 so\nwindow-local coordinates land somewhere unrelated; Fleet never omits it.\nCoordinates are window-local screenshot pixels by default; --space screen takes desktop\npixels. A point outside the target window is refused, not delivered elsewhere.\nshot-window composites owned popups and modal dialogs onto the capture and warns when the\nprocess owns a window above the captured one \u2014 a blocked window looks entirely normal on\nits own. --probe X,Y draws a crosshair where a click would land without clicking.\n--grid burns the coordinate frame (pid, window_id, origin) into the image.\nget_window_state output is collapsed when its accessibility walk found nothing; --full\nrestores the raw body. describe --brief trims the prose; --for TARGET states whether\nelement_index can resolve on that window at all.\nA title match selects that window, including dialogs. act JSON must omit pid/window_id/target and from_zoom;\nFleet supplies the target and validates x/y and both drag endpoints. Raw <tool> {JSON} is a driver passthrough\nwithout these checks. A failed settling capture reports indeterminate; driver errors\nand missing requested images return failure.\nBatch is an array of {tool,args?,space?,delayMs?}. It targets one fixed window, validates\nall coordinates first, and stops at the first driver failure without retrying.\nIt observes only before/after the sequence, not each action. completed confirms driver\nexit, not application effect. unconfirmed means inspect the desktop before more input.\nLimits: 100 actions, 256 KiB JSON, 10000 ms per delay, 60000 ms total delay.",
  edit: "Omitting --new or passing --new \"\" deletes the matched text. A present --new\nwithout a value is an error. Use --old=--flag for option-looking literal text.\nFleet requires one match unless --all is set, checks for concurrent modification,\nand prints changed lines. --dry-run does not write.",
};

const aliases: Record<string, string> = { hosts: "ls", service: "svc", screenshot: "shot", computer: "cu" };
const subcommands: Record<string, string[]> = {
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
