import type { Host } from "./config.ts";

/** Lock a canonical installation directory across controller processes. A lost
 * connection leaves the lock visible; never steal a lock based on its age. */
export function installLockScript(h: Host, dir: string, token: string, release = false, archive?: string): { cmd: string; shell: "bash" | "powershell" } {
  if (!/^[a-z0-9-]+$/.test(token)) throw new Error("invalid installation token");
  if (archive && !/^[a-z0-9.-]+$/.test(archive)) throw new Error("invalid installation archive");
  if (h.os === "windows") {
    const setup = [
      `$ErrorActionPreference='Stop'`, `$dir="${dir}"`,
      `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
      `$lock=[System.IO.Path]::GetFullPath($dir).TrimEnd('\\') + '.fleet-install-lock'`,
    ];
    return { shell: "powershell", cmd: [...setup, ...(release ? [
      `if ([System.IO.File]::ReadAllText($lock).Trim() -ne '${token}') { throw "installation lock ownership changed: $lock" }`,
      ...(archive ? [`[System.IO.File]::Delete("$env:USERPROFILE\\${archive}")`] : []),
      `[System.IO.File]::Delete($lock)`,
    ] : [
      `try { $lockStream=[System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None) } catch { throw "installation locked: $lock; inspect the previous operation before removing its lock" }`,
      `try { $ownerBytes=[System.Text.Encoding]::UTF8.GetBytes('${token}'); $lockStream.Write($ownerBytes, 0, $ownerBytes.Length); $lockStream.Flush() } finally { $lockStream.Dispose() }`,
    ])].join("\n") };
  }
  return { shell: "bash", cmd: [
    "set -e", `dir="${dir}"`, `mkdir -p "$dir"`, `dir="$(cd "$dir" && pwd -P)"`, `lock="$dir.fleet-install-lock"`,
    ...(release ? [
      `[ "$(cat "$lock/owner")" = '${token}' ] || { echo "installation lock ownership changed: $lock" >&2; exit 1; }`,
      ...(archive ? [`rm -f "$HOME/${archive}"`] : []),
      `rm "$lock/owner"`, `rmdir "$lock"`,
    ] : [
      `mkdir "$lock" 2>/dev/null || { echo "installation locked: $lock; inspect the previous operation before removing its lock" >&2; exit 1; }`,
      `printf '%s\\n' '${token}' > "$lock/owner" || { rmdir "$lock"; exit 1; }`,
    ]),
  ].join("\n") };
}
