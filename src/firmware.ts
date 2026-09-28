/**
 * UEFI one-time boot for dual-boot machines. `fleet switch` looks the target's
 * firmware entry up by its label at switch time, because an entry's id changes
 * whenever an entry is added, removed, or recreated. A hard-coded id goes stale
 * and the reboot then lands back in the source OS.
 *
 * Windows reads `bcdedit /enum firmware`; Linux reads `efibootmgr -v`. Parsing
 * happens here, on the controller, so the refusal logic has one tested home.
 */

export interface FirmwareEntry {
  id: string;           // bcdedit identifier ({…}) or efibootmgr boot number (0003)
  label: string;        // the entry's description
  path?: string;        // loader path on the EFI partition
  partition?: string;   // \Device\HarddiskVolumeN on Windows, the partition UUID on Linux
}
export interface FirmwareTable {
  os: "windows" | "linux";
  order: string[];      // firmware boot order, ids in the same form as entries
  entries: FirmwareEntry[];
}
/** An EFI system partition, in disk order. `device` is the Windows NT device path. */
export interface EfiPartition { uuid: string; device?: string; path?: string }

const ESP_TYPE = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b";

/** Parse `bcdedit /enum firmware`. Sections start with a title line over a
 *  dashed line; indented lines continue the previous key's value list. */
export function parseBcdeditFirmware(text: string): FirmwareTable {
  const lines = text.replace(/\r/g, "").split("\n");
  const sections: Record<string, string[]>[] = [];
  let cur: Record<string, string[]> | null = null;
  let lastKey = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^-{3,}\s*$/.test(lines[i + 1] ?? "") && line.trim()) {
      cur = {}; sections.push(cur); lastKey = ""; i++; continue;
    }
    if (!cur || !line.trim()) continue;
    const kv = /^(\S+)\s+(.*\S)\s*$/.exec(line);
    if (kv) { lastKey = kv[1]!.toLowerCase(); (cur[lastKey] ??= []).push(kv[2]!); continue; }
    const cont = /^\s+(\S.*?)\s*$/.exec(line);
    if (cont && lastKey) cur[lastKey]!.push(cont[1]!);
  }
  const order = sections.find((s) => s.identifier?.[0] === "{fwbootmgr}")?.displayorder ?? [];
  const entries = sections
    .filter((s) => s.identifier?.[0] && s.identifier[0] !== "{fwbootmgr}" && s.description?.[0])
    .map((s) => ({
      id: s.identifier![0]!,
      label: s.description![0]!,
      path: s.path?.[0],
      partition: s.device?.[0]?.replace(/^partition=/i, ""),
    }));
  return { os: "windows", order, entries };
}

/** Parse `efibootmgr -v`. Newer versions separate the label from the device
 *  path with a tab; older ones with spaces before the first device node. */
export function parseEfibootmgr(text: string): FirmwareTable {
  const lines = text.replace(/\r/g, "").split("\n");
  const order = (/^BootOrder:\s*(\S+)/m.exec(text)?.[1] ?? "").split(",").filter(Boolean).map((s) => s.toUpperCase());
  const entries: FirmwareEntry[] = [];
  for (const line of lines) {
    const m = /^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2]!;
    let label = rest, dp = "";
    const tab = rest.indexOf("\t");
    if (tab >= 0) { label = rest.slice(0, tab); dp = rest.slice(tab + 1); }
    else {
      const node = /\s+(?=(?:HD|PciRoot|VenHw|VenMedia|BBS|FvVol|FvFile|MAC|Acpi|File|Pci)\()/.exec(rest);
      if (node) { label = rest.slice(0, node.index); dp = rest.slice(node.index + node[0].length); }
    }
    const hd = /HD\(\d+,GPT,([0-9a-fA-F-]{36})/.exec(dp);
    const path = /File\(([^)]+)\)/.exec(dp)?.[1] ?? /(\\[^\t)]*?\.efi)/i.exec(dp)?.[1];
    entries.push({ id: m[1]!.toUpperCase(), label: label.trim(), path, partition: hd?.[1]?.toLowerCase() });
  }
  return { os: "linux", order, entries };
}

/** The one entry `label` names. Several entries can share a label (a second
 *  disk's Windows Boot Manager); the one earliest in firmware boot order wins,
 *  as it would in the firmware's own menu. Anything else refuses, because a
 *  reboot after a failed lookup lands back in the source OS. */
export function pickFirmwareEntry(table: FirmwareTable, label: string): { entry: FirmwareEntry; note?: string } {
  const want = label.trim().toLowerCase();
  const matches = table.entries.filter((e) => e.label.trim().toLowerCase() === want);
  if (!matches.length) {
    const have = [...new Set(table.entries.map((e) => e.label))].join(", ") || "none";
    throw new Error(`no firmware entry labelled '${label}' (have: ${have})`);
  }
  if (matches.length === 1) return { entry: matches[0]! };
  const rank = (e: FirmwareEntry) => {
    const i = table.order.findIndex((id) => id.toLowerCase() === e.id.toLowerCase());
    return i < 0 ? Infinity : i;
  };
  const sorted = [...matches].sort((a, b) => rank(a) - rank(b));
  if (rank(sorted[0]!) === Infinity || rank(sorted[0]!) === rank(sorted[1]!))
    throw new Error(`${matches.length} firmware entries are labelled '${label}' and boot order does not pick one: `
      + matches.map((e) => e.id).join(", "));
  return {
    entry: sorted[0]!,
    note: `${matches.length} entries are labelled '${label}'; using ${sorted[0]!.id}, the earliest in boot order`,
  };
}

/** Read-only command that prints the firmware table. */
export function firmwareListCommand(os: "windows" | "linux"): string {
  return os === "windows" ? "bcdedit /enum firmware" : "efibootmgr -v";
}

export function parseFirmwareTable(os: "windows" | "linux", text: string): FirmwareTable {
  return os === "windows" ? parseBcdeditFirmware(text) : parseEfibootmgr(text);
}

/** Set the one-time boot entry, confirm it took, then reboot after a short
 *  delay so the reply reaches the controller first. The Linux form must run as
 *  root. Nothing reboots when setting the entry fails. */
export function bootNextCommand(os: "windows" | "linux", entry: FirmwareEntry, target: string): string {
  const reason = `fleet: switching to ${target}`.replace(/[^A-Za-z0-9 :._-]/g, "");
  if (os === "windows") {
    if (!/^\{[A-Za-z0-9-]+\}$/.test(entry.id)) throw new Error(`unexpected bcdedit identifier '${entry.id}'`);
    return [
      `$out = bcdedit /set '{fwbootmgr}' bootsequence '${entry.id}' 2>&1`,
      `if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("fleet: bcdedit refused the one-time boot entry: $out"); exit 3 }`,
      `$check = (bcdedit /enum '{fwbootmgr}') -join [char]10`,
      `if ($check -notmatch 'bootsequence\\s+${entry.id.replace(/[{}]/g, "\\$&")}') { [Console]::Error.WriteLine('fleet: bootsequence did not take; not rebooting'); exit 3 }`,
      `Write-Output 'fleet: one-time boot set to ${entry.id}'`,
      `shutdown /r /t 5 /c '${reason}'`,
      `if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("fleet: shutdown /r failed (exit $LASTEXITCODE)"); exit $LASTEXITCODE }`,
      `Write-Output 'fleet: reboot scheduled in 5s'`,
    ].join("\n");
  }
  if (!/^[0-9A-F]{4}$/.test(entry.id)) throw new Error(`unexpected efibootmgr boot number '${entry.id}'`);
  return [
    `efibootmgr --bootnext ${entry.id} >/dev/null || { echo "fleet: efibootmgr --bootnext ${entry.id} failed; not rebooting" 1>&2; exit 3; }`,
    `efibootmgr | grep -qi '^BootNext: *${entry.id}' || { echo "fleet: BootNext did not take; not rebooting" 1>&2; exit 3; }`,
    `echo "fleet: one-time boot set to ${entry.id}"`,
    `if command -v systemd-run >/dev/null 2>&1; then systemd-run --quiet --on-active=3 systemctl reboot`,
    `else nohup sh -c 'sleep 3; reboot' >/dev/null 2>&1 & fi`,
    `echo "fleet: reboot scheduled in 3s"`,
  ].join("\n");
}

/** Read-only command listing EFI system partitions in disk order, one
 *  `ESP<TAB>uuid<TAB>device-or-path` line each. */
export function espListCommand(os: "windows" | "linux"): string {
  if (os === "linux")
    return `lsblk -rno PATH,PARTUUID,PARTTYPE | awk 'tolower($3) == "${ESP_TYPE}" { printf "ESP\\t%s\\t%s\\n", tolower($2), $1 }'`;
  return [
    `if (-not ('FleetFw.K32' -as [type])) {`,
    `  Add-Type -Namespace FleetFw -Name K32 -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint QueryDosDevice(string name, System.Text.StringBuilder target, int max);'`,
    `}`,
    `Get-Partition | Where-Object { $_.GptType -eq '{${ESP_TYPE}}' } | Sort-Object DiskNumber, PartitionNumber | ForEach-Object {`,
    `  $vol = $_.AccessPaths | Where-Object { $_ -like '\\\\?\\Volume{*' } | Select-Object -First 1`,
    `  $dev = ''`,
    `  if ($vol) { $sb = New-Object System.Text.StringBuilder 512; if ([FleetFw.K32]::QueryDosDevice($vol.Substring(4).TrimEnd('\\'), $sb, 512)) { $dev = $sb.ToString() } }`,
    `  "ESP\`t$($_.Guid.Trim('{}').ToLower())\`t$dev"`,
    `}`,
  ].join("\n");
}

export function parseEspList(os: "windows" | "linux", text: string): EfiPartition[] {
  return text.replace(/\r/g, "").split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f[0] === "ESP" && f[1])
    .map((f) => os === "windows" ? { uuid: f[1]!, device: f[2] || undefined } : { uuid: f[1]!, path: f[2] || undefined });
}

export interface EntryCheck extends FirmwareEntry {
  esp: number | null;   // index of its EFI partition in disk order, null when unknown or not an ESP
  warning?: string;
}

/** Tag each entry with the EFI partition it points at. Some firmware drops
 *  entries on any partition other than the first ESP after one boot, so those
 *  get a warning. */
export function checkEntries(table: FirmwareTable, esps: EfiPartition[]): EntryCheck[] {
  const key = (p: EfiPartition) => (table.os === "windows" ? p.device : p.uuid)?.toLowerCase();
  return table.entries.map((e) => {
    if (!e.partition) return { ...e, esp: null };
    const i = esps.findIndex((p) => key(p) === e.partition!.toLowerCase());
    if (i === 0) return { ...e, esp: 0 };
    if (i > 0) return { ...e, esp: i,
      warning: `points at EFI partition #${i + 1} (${esps[i]!.path ?? esps[i]!.device ?? esps[i]!.uuid}), not the first one; some firmware silently drops such entries` };
    return { ...e, esp: null, warning: esps.length ? "points at a partition that is not an EFI system partition fleet found" : undefined };
  });
}
