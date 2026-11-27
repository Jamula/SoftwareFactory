# Optional developer workstation compatibility (`M02.05 P2` / `#66`)

This reference documents optional local developer workstation setup, loopback HTTPS certificate scoping, isolated **Aspire 17 AppHost** startup/verification/shutdown, and **SoftwareFactory Live Board** (`factory-board`) Copilot CLI Extension Canvas preview across **Windows 11**, **macOS**, and **Linux / WSL2**.

## P2 non-blocking status and operational boundaries

- **Strictly optional and non-blocking (`M02.05 P2`, [#66](https://github.com/Jamula/SoftwareFactory/issues/66))**: Developer workstation testing does **not** gate `M01` (Autonomous SoftwareFactory), `M02` (Fast SoftwareFactory), or `M03`–`M05` (`FamilyTree`, `Spellbook`, `FamilyHub` adoptions).
- **Sole mandatory validation environment**: Standard **GitHub-hosted Linux (`ubuntu-latest`) and Windows (`windows-latest`) runners** are the only authoritative CI, coverage (`>=98%` line / `>=95%` branch), security (`CodeQL`), and Aspire runtime acceptance environments ([#4](https://github.com/Jamula/SoftwareFactory/issues/4), [#15](https://github.com/Jamula/SoftwareFactory/issues/15), [#17](https://github.com/Jamula/SoftwareFactory/issues/17)). Workstation runs never substitute for exact-head GitHub-hosted check evidence.
- **Zero operational dependency on developer machines**: A personal laptop, desktop workstation, open IDE/chat session, or self-hosted workstation runner **never** hosts outer orchestration (`github/gh-aw`), durable work-queue claims (`tools.work-queue` git-ref CAS), inner specialist workflows, coding workers (`copilot-swe-agent[bot]` / Cloud Automations), or authoritative leases.
- **`$0` incremental spend and zero private data**: No dedicated workstation purchase, paid cloud sandbox, remote OpenTelemetry collector, or credential storage is authorized. Never record usernames, machine hostnames, local home-directory paths, dashboard login URLs (`?t=...`), `DASHBOARD__API__SECONDARYAPIKEY` values, or raw CLI transcripts in repository files, issues, or pull requests.

## Pinned workstation prerequisites

Align local toolchains with the repository's immutable hosted runner pins so behavior matches CI without lockfile or SDK drift:

| Requirement | Pinned version / contract | Source of truth |
| --- | --- | --- |
| **Node.js** | `26.13.1` (`npm ci --ignore-scripts`) | `.github/workflows/validate.yml`, `.github/workflows/windows-aspire.yml` |
| **.NET SDK** | `10.0.404` (`rollForward: "disable"`) | `global.json` |
| **Aspire CLI** | `Aspire.Cli 17.0.0` (scoped `--tool-path`) | `apphost.cs` (`Aspire.Hosting.AppHost@17.0.0`, `Aspire.Hosting.JavaScript@17.0.0`) |
| **Container daemon** | **None required** for the file-based Node synthetic shadow AppHost | `apphost.cs` (`AddNodeApp("synthetic-shadow", ...)` with `WithExplicitStart()`) |
| **Telemetry opt-out** | `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `ASPIRE_CLI_TELEMETRY_OPTOUT=true`, `ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true` | Local-only diagnostics; zero external telemetry |

### Headless verification (no Aspire daemon required)

Before exercising the local Aspire AppHost, verify exact locked dependencies, deterministic smoke fixtures, and `98%` line / `95%` branch coverage from the repository root (`<repo-root>`):

```bash
node --version   # expected: v26.13.1
dotnet --version # expected: 10.0.404
npm ci --ignore-scripts
node tools/engineering-factory/run.mjs --smoke
node tools/engineering-factory/aspire-smoke.mjs
npm run test:coverage
rm -f coverage-evidence.json cobertura-coverage.xml
```

### Scoped `Aspire.Cli 17.0.0` installation

Install `Aspire.Cli` into a disposable local directory rather than mutating global tool state, then restore and build the file-based `apphost.cs` in `Release` configuration:

```bash
DOTNET_CLI_TELEMETRY_OPTOUT=1 ASPIRE_CLI_TELEMETRY_OPTOUT=true \
  dotnet tool install Aspire.Cli --version 17.0.0 \
  --tool-path "<temp-root>/sf-aspire-tools" \
  --source https://api.nuget.org/v3/index.json

dotnet restore apphost.cs --source https://api.nuget.org/v3/index.json
dotnet build apphost.cs --configuration Release --no-restore
```

## Scoped loopback HTTPS dev-cert setup by platform

SoftwareFactory enforces authenticated loopback TLS for both the Aspire Dashboard and local OTLP ingestion (`apphost.run.json`):

- `ASPIRE_ALLOW_UNSECURED_TRANSPORT=false`
- `ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false`
- `ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL=https://127.0.0.1:18890`
- `ASPIRE_DASHBOARD_PERSISTENCE_MODE=Run`

Node.js does not read OS certificate stores by default, so export the `.NET` HTTPS development certificate in PEM format to a private `0700` temporary directory and point `NODE_EXTRA_CA_CERTS` at that PEM file.

### Windows 11 (`pwsh` 7+)

On an interactive Windows 11 session, `dotnet dev-certs https --trust` triggers a modal Windows Security prompt to add the ASP.NET Core localhost certificate to `CurrentUser\Root`. To avoid mutating the Windows certificate store or blocking non-interactive shells, export a scoped PEM certificate and set `ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE=false` so DCP uses its ephemeral session certificate while Node and `curl.exe` validate the exported PEM directly:

```powershell
$ErrorActionPreference = 'Stop'
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("sf-workstation-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $workDir | Out-Null
$certPem = Join-Path $workDir 'aspire-dev.pem'

dotnet dev-certs https --export-path $certPem --format PEM | Out-Null
$env:NODE_EXTRA_CA_CERTS = $certPem
$env:ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE = 'false'
$env:ASPIRE_ALLOW_UNSECURED_TRANSPORT = 'false'
$env:ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS = 'false'
$env:ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL = 'https://127.0.0.1:18890'
```

### macOS (`zsh` / `bash`)

On macOS, `dotnet dev-certs https --trust` prompts for login Keychain authorization (which helps Safari/Chrome trust `https://localhost:<port>`), while Node.js OTLP exporters still require `NODE_EXTRA_CA_CERTS`:

```bash
umask 077
work_dir="$(mktemp -d "${TMPDIR:-/var/folders}/sf-workstation.XXXXXXXX")"
cert_pem="$work_dir/aspire-dev.pem"

dotnet dev-certs https --export-path "$cert_pem" --format PEM >/dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$cert_pem"
export ASPIRE_ALLOW_UNSECURED_TRANSPORT=false
export ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false
export ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL="https://127.0.0.1:18890"
```

### Linux and WSL2 (`bash`)

On Linux distributions and WSL2, OpenSSL/NSS browser trust varies by distro. Exporting the PEM file and supplying `NODE_EXTRA_CA_CERTS` (plus `curl --cacert "$cert_pem"` for CLI checks) provides deterministic loopback TLS verification without root or `update-ca-certificates` changes:

```bash
umask 077
work_dir="$(mktemp -d "${XDG_RUNTIME_DIR:-$HOME/.cache}/sf-workstation.XXXXXXXX")"
cert_pem="$work_dir/aspire-dev.pem"

dotnet dev-certs https --export-path "$cert_pem" --format PEM >/dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$cert_pem"
export ASPIRE_ALLOW_UNSECURED_TRANSPORT=false
export ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false
export ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL="https://127.0.0.1:18890"
```

## Single-command isolated AppHost start, verify, and stop

Use `aspire start --apphost apphost.cs --isolated` so dynamic loopback ports and an isolated dashboard session prevent collisions with other local Aspire projects. Redirect CLI startup output to a private `0600` file so the one-time dashboard login token (`?t=...`) is never printed to shared logs:

```bash
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export ASPIRE_CLI_TELEMETRY_OPTOUT=true
export ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true
export ASPIRE_ALLOW_UNSECURED_TRANSPORT=false
export ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false
export ASPIRE_DASHBOARD_PERSISTENCE_MODE=Run
export ASPIRE_DASHBOARD_DATA_DIRECTORY="$work_dir/dashboard-data"
export ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL="https://127.0.0.1:18890"
export ASPIRE_HOME="$work_dir/aspire-home"
export PATH="<temp-root>/sf-aspire-tools:$PATH"
mkdir -p "$ASPIRE_DASHBOARD_DATA_DIRECTORY"

# 1. Start isolated AppHost over authenticated loopback HTTPS
aspire start --apphost apphost.cs --isolated --non-interactive --nologo >"$work_dir/startup.log" 2>&1

# 2. Extract loopback origin without printing the login token
origin="$(grep -Eom1 'https://(localhost|127\.0\.0\.1|\[::1\]):[0-9]+' "$work_dir/startup.log")"
curl --silent --show-error --noproxy '*' --max-time 10 --cacert "$cert_pem" \
  --output /dev/null --write-out '%{http_code}\n' "$origin/resources"
# Expected HTTP status: 302 (redirects unauthenticated requests to /login)

# 3. Explicitly run the finite synthetic-shadow resource and verify clean OTel shutdown
aspire resource synthetic-shadow start --apphost apphost.cs --non-interactive
aspire wait synthetic-shadow --status down --timeout 20 --apphost apphost.cs
aspire logs synthetic-shadow --apphost apphost.cs --non-interactive | \
  grep -E 'STOPPED|LOCAL_SDK_SHUTDOWN_COMPLETE'

# 4. Optional telemetry archive export, followed by deterministic stop and cleanup
aspire export --apphost apphost.cs --output "$work_dir/telemetry-export.zip" --non-interactive
aspire stop --apphost apphost.cs --non-interactive
rm -rf -- "$work_dir"
```

On PowerShell (Windows 11), invoke the identical `aspire start --apphost apphost.cs --isolated --non-interactive --nologo`, `aspire resource synthetic-shadow start --apphost apphost.cs --non-interactive`, `aspire wait synthetic-shadow --status down --timeout 20 --apphost apphost.cs`, `aspire logs synthetic-shadow --apphost apphost.cs --non-interactive`, and `aspire stop --apphost apphost.cs --non-interactive` sequence inside a `try { ... } finally { ... }` block that removes `$workDir` and clears `NODE_EXTRA_CA_CERTS` on exit.

## `factory-board` Copilot CLI Extension Canvas preview

SoftwareFactory includes a read-only, loopback-bound **Live Board Canvas** (`.github/extensions/factory-board/extension.mjs` + `tools/engineering-factory/factory-board.mjs`) for inspecting `M01`–`M05` milestones, issues, active PR check rollups, and merge-queue status without creating a competing backlog or mutating GitHub state:

1. **Inside GitHub Copilot CLI / GitHub Copilot App**:
   - Copilot automatically discovers `.github/extensions/factory-board/extension.mjs` as `project:factory-board`.
   - Prompt Copilot to *"Open the SoftwareFactory Live Board canvas"* or invoke `open_canvas({ canvasId: "factory-board", instanceId: "board-1" })` (optional `repo: "Jamula/SoftwareFactory"`, `intervalSeconds: 10..300`).
2. **Standalone local loopback browser preview**:
   - Launch `startLoopbackBoardServer()` directly with Node.js `26.13.1` from `<repo-root>`:
     ```bash
     node -e '
     import("./.github/extensions/factory-board/board-ui.mjs").then(async ({ startLoopbackBoardServer }) => {
       const srv = await startLoopbackBoardServer();
       process.stderr.write("Factory Board listening at " + srv.url + "\n");
     });
     '
     ```
   - Open the printed `http://127.0.0.1:<port>` URL locally and press `Ctrl+C` when finished.
   - **Security invariants**: Enforces exact `127.0.0.1:<port>` `Host` authority, per-instance cryptographic `X-Factory-Board-Token` capability headers on `POST` refresh/interval controls, read-only `gh api graphql` / bounded `GET` fallback, and optional local-only OpenTelemetry `"reconcile"` observations (`local-otel-sdk.mjs`) with remote export disabled.

## Workstation troubleshooting matrix

| Symptom / sanitized category | Root cause on workstations | Safe resolution (no TLS or gate bypass) |
| --- | --- | --- |
| **`tls-or-certificate`** — non-interactive certificate trust hang or `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | Windows `dotnet dev-certs https --trust` blocks waiting for an interactive `CurrentUser\Root` modal dialog in headless shells; Node.js ignores OS trust stores unless `NODE_EXTRA_CA_CERTS` is set. | Never set `NODE_TLS_REJECT_UNAUTHORIZED=0` or `ASPIRE_ALLOW_UNSECURED_TRANSPORT=true`. Export PEM via `dotnet dev-certs https --export-path <pem> --format PEM`, set `NODE_EXTRA_CA_CERTS=<pem>`, and set `ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE=false` on Windows non-interactive shells. |
| **Loopback port collisions** (`18888`, `18890`, `18891` `EADDRINUSE`) | Another Aspire AppHost, local OTLP collector, or IDE debug session already holds the static profile ports in `apphost.run.json`. | Always pass `--isolated` (`aspire start --apphost apphost.cs --isolated`) for dynamic dashboard/resource-service port assignment, or stop the conflicting local listener before overriding `ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL`. |
| **Stale DCP / orphaned AppHost processes** (`file-access` / `sharing violation`) | An interrupted `aspire run` left `dcp`, `dcpctrl`, or `apphost` child processes holding sockets or temporary dashboard persistence files. | Run `aspire stop --apphost apphost.cs --non-interactive` first. Verify no lingering repo-scoped `apphost` / `dcp` processes remain (`ps` / `lsof` on macOS/Linux or `Get-Process` on Windows) before removing `$work_dir`. |
| **Container / WSL2 IPv6 `[::1]` vs IPv4 `127.0.0.1` mismatch** (`ECONNREFUSED ::1:18890`) | Dual-stack `localhost` resolves to `::1` first inside WSL2 or devcontainers while the OTLP or board listener is bound to `127.0.0.1` (or corporate proxy env vars intercept loopback). | Pin explicit IPv4 loopback (`https://127.0.0.1:18890` for OTLP; `127.0.0.1` for `factory-board`) and pass `--noproxy '*'` (or `NO_PROXY=localhost,127.0.0.1,::1`) on local loopback checks. |
| **`authentication`** (`401` / missing `302 /login` redirect) | Browser/API request omitted the current run's login token or reused a stale URL from a stopped `--isolated` session. | Read the fresh login URL locally from the private `$work_dir/startup.log` file (never echo it to public output); keep `ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false`. |
| **`.NET SDK` or `Node.js` version mismatch** (`global.json` / `TOOLCHAIN_OR_OS_DRIFT`) | Workstation `PATH` resolves a newer/older `.NET` SDK (`rollForward` is disabled in `global.json`) or a non-`26.13.1` Node binary. | Install exact `.NET SDK 10.0.404` and `Node.js 26.13.1` (`nvm` / `fnm` / `dotnet-install`) rather than editing `global.json` or lockfiles. |

## Optional evidence reporting rules (`#66`)

If the repository owner explicitly requests an optional workstation compatibility check under `#66`, record **only** sanitized metadata:

1. Tested exact `git rev-parse HEAD` commit SHA and OS family/version (for example `Windows 11 24H2 x64`, `macOS 15 arm64`, `Ubuntu 24.04 WSL2 x64`).
2. Exact tool versions (`node --version`, `dotnet --version`, `aspire --version`).
3. Exit codes and redacted loopback check outcomes (`302 /login` verified, `STOPPED` + `LOCAL_SDK_SHUTDOWN_COMPLETE` observed, `aspire stop` exit `0`, zero lingering listeners).
4. **Never** attach raw `startup.log` files, exported `.zip` archives containing environment variables, login `?t=` tokens, certificates/private keys, or personal paths, and **never** close `#17` or `#15` from workstation evidence.
