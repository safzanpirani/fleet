# Deploying the remote endpoint (`fleet.example.com`) on win-box

The HTTP MCP server (`src/http.ts`) runs on **win-box** as an nssm service `FleetMCP`
on `127.0.0.1:8787`, exposed publicly through win-box's existing Cloudflare tunnel at
`https://fleet.example.com`. win-box is the SSH origin for the whole fleet.

## Example Windows service setup

### 1. SSH origin: win-box → every fleet host
The service runs as **LocalSystem**, which resolves `.ssh` from the **system profile**,
not `C:\Users\ExampleUser` (setting `HOME`/`USERPROFILE` does *not* change this). So:
- win-box's key (`~/.ssh/id_ed25519.pub`) must be authorized on every host
  (`vps`/`web`/`worker` linux `authorized_keys`; `win-box` Windows
  `C:\ProgramData\ssh\administrators_authorized_keys`; `mac` `~/.ssh/authorized_keys`).
- win-box's `~/.ssh/config` needs every fleet alias resolvable (cloud boxes via public IP,
  home/mac via Tailscale IP; `StrictHostKeyChecking accept-new`).
- **Seed the system profile** so the LocalSystem service can use it:
  copy `C:\Users\ExampleUser\.ssh\{config,id_ed25519,id_ed25519.pub,known_hosts}` →
  `C:\Windows\System32\config\systemprofile\.ssh\`.

### 2. The service (nssm)
```
nssm install FleetMCP C:\Users\ExampleUser\.bun\bin\bun.exe "run C:\Users\ExampleUser\fleet\src\http.ts"
nssm set FleetMCP AppDirectory C:\Users\ExampleUser\fleet
nssm set FleetMCP AppEnvironmentExtra FLEET_MCP_TOKEN=<token> FLEET_MCP_HOST=127.0.0.1 FLEET_MCP_PORT=8787 FLEET_MCP_READONLY=0
nssm set FleetMCP AppStdout C:\Users\ExampleUser\fleet\mcp-http.log
nssm set FleetMCP AppStderr C:\Users\ExampleUser\fleet\mcp-http.log
nssm set FleetMCP Start SERVICE_AUTO_START
nssm set FleetMCP AppExit Default Restart
nssm start FleetMCP
```
The token lives **only** in the service env: `nssm get FleetMCP AppEnvironmentExtra`.

### 3. Cloudflare ingress + DNS
Add to `C:\Users\ExampleUser\.cloudflared\config.yml` **above** the `http_status:404` catch-all
(match the 2-space list indent of the other rules):
```yaml
  - hostname: fleet.example.com
    service: http://localhost:8787
```
Then `cloudflared tunnel ingress validate`, restart **both** supervisors (nssm `cloudflared`
service **and** the `Cloudflare Tunnel` scheduled task), and ensure the DNS route exists
(`cloudflared tunnel route dns <tunnel-id> fleet.example.com`).

## Redeploy after a code change
One command does the whole dance (build tarball → ship → extract → `bun install` →
restart the host's `fleet-mcp` service):
```sh
fleet deploy win-box                 # or any selector; --no-restart / --restart <svc>
```
`fleet deploy` builds with `COPYFILE_DISABLE=1` (no AppleDouble), installs into the host's
`deploy.dir` (default `~/fleet` | `%USERPROFILE%\fleet`), and restarts `deploy.service` →
the host's `fleet-mcp` service by default.

<details><summary>Manual equivalent (if you can't use <code>fleet deploy</code>)</summary>

```sh
tar czf /tmp/fleet-deploy.tgz --exclude node_modules --exclude .git src scripts package.json bun.lock fleet.config.json tsconfig.json README.md
fleet cp /tmp/fleet-deploy.tgz win-box:fleet-deploy.tgz
fleet exec win-box 'tar -xzf $HOME\fleet-deploy.tgz -C $HOME\fleet; Set-Location $HOME\fleet; & $HOME\.bun\bin\bun.exe install; Remove-Item $HOME\fleet\src\._*,$HOME\fleet\scripts\._* -Force -EA SilentlyContinue'
fleet restart win-box fleet-mcp     # = nssm restart FleetMCP
```
</details>

## Operate
- **Health:** `curl https://fleet.example.com/health`
- **Kill-switch (read-only):** set `FLEET_MCP_READONLY=1` in the nssm env (re-set the full
  `AppEnvironmentExtra`) and `fleet restart win-box fleet-mcp` — drops exec/cp/restart/run.
- **Logs:** `C:\Users\ExampleUser\fleet\mcp-http.log`.
- **Rotate token:** re-set `AppEnvironmentExtra` with a new `FLEET_MCP_TOKEN`, restart, update
  the client.

## Installation verification and recovery

The active `fleet` command must resolve to the installation being updated.
Fleet deployment installs an absolute-Bun launcher and fails if another executable
shadows it on PATH. Check `command -v fleet` on Unix or `(Get-Command fleet).Source`
on Windows, then run a harmless command through that launcher.

Deploy and tool sync share a lock per installation directory and use unique
archives. If a timeout or disconnect leaves the outcome unconfirmed, inspect the
remote process, files, and reported archive before removing the lock or retrying.
Source extraction overlays the installation and preserves runtime files.

A compiled controller needs a source checkout for deployment. Set
`FLEET_SOURCE_ROOT=/path/to/fleet` when its working directory is not that checkout.
HTTP MCP requires authentication and accepts bodies up to 16 MiB.
