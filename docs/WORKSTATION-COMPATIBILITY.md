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
| **Aspire CLI** | `Aspire.Cli 17.0.0` (scoped `--tool-path`) | `apphost.cs` (`Aspire.Hosting.AppHost@17.0.0`, `Aspire.Hosting.Dotnet@17.0.0`, `Aspire.Hosting.JavaScript@17.0.0`) |
| **Container daemon** | **None required** for the file-based Node and `.NET` shadow AppHost resources | `apphost.cs` (`AddNodeApp("synthetic-shadow", ...)` and `AddDotnetProject("maf-specialist-shadow", ...)` with `WithExplicitStart()`) |
| **Telemetry opt-out** | `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `ASPIRE_CLI_TELEMETRY_OPTOUT=true`, `ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true` | Local-only diagnostics; zero external telemetry |

### Headless verification (no Aspire daemon required)

Before exercising the local Aspire AppHost, export telemetry opt-outs first so zero CLI usage telemetry is emitted, then verify exact locked dependencies, deterministic smoke fixtures, and `98%` line / `95%` branch coverage from the repository root (`<repo-root>`):

```bash
set -euo pipefail
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export ASPIRE_CLI_TELEMETRY_OPTOUT=true
export ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true

node --version   # expected: v26.13.1
dotnet --version # expected: 10.0.404
npm ci --ignore-scripts
node tools/engineering-factory/run.mjs --smoke
node tools/engineering-factory/aspire-smoke.mjs
npm run test:coverage
rm -f coverage-evidence.json cobertura-coverage.xml
```

### Scoped `Aspire.Cli 17.0.0` installation

Install `Aspire.Cli` into a disposable user-local directory (`$HOME/.local/share/softwarefactory-aspire-tools`, or `Join-Path $HOME '.local\share\softwarefactory-aspire-tools'` on PowerShell) rather than mutating global tool state, keeping telemetry opt-outs exported in the shell before every `.NET` and Aspire command, then restore and build the file-based `apphost.cs` in `Release` configuration:

```bash
set -euo pipefail
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export ASPIRE_CLI_TELEMETRY_OPTOUT=true
export ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true

dotnet tool install Aspire.Cli --version 17.0.0 \
  --tool-path "$HOME/.local/share/softwarefactory-aspire-tools" \
  --source https://api.nuget.org/v3/index.json

dotnet restore apphost.cs --source https://api.nuget.org/v3/index.json
dotnet build apphost.cs --configuration Release --no-restore
```

## Scoped loopback HTTPS dev-cert setup by platform

SoftwareFactory enforces authenticated loopback TLS for the Aspire Dashboard, resource service, and local OTLP ingestion (`apphost.run.json`, plus per-run ephemeral dashboard persistence in the shell):

- `ASPIRE_ALLOW_UNSECURED_TRANSPORT=false` (`apphost.run.json`)
- `ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false` (`apphost.run.json`)
- `ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL=https://127.0.0.1:18890` (`apphost.run.json`)
- `ASPIRE_RESOURCE_SERVICE_ENDPOINT_URL=https://localhost:18891` (`apphost.run.json`)
- `ASPIRE_DASHBOARD_PERSISTENCE_MODE=Run` (exported per isolated run)

Node.js does not read OS certificate stores by default, so export the `.NET` HTTPS development certificate in PEM format to a private `0700` temporary directory and point `NODE_EXTRA_CA_CERTS` at that PEM file.

### Windows 11 (`pwsh` 7+)

On an interactive Windows 11 session, `dotnet dev-certs https --trust` triggers a modal Windows Security prompt to add the ASP.NET Core localhost certificate to `CurrentUser\Root`. To avoid mutating the Windows certificate store or blocking non-interactive shells, export telemetry opt-outs first, export a scoped PEM certificate, and set `ASPIRE_DCP_USE_DEVELOPER_CERTIFICATE=false` so DCP uses its ephemeral session certificate while Node and `curl.exe` validate the exported PEM directly:

```powershell
$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:ASPIRE_CLI_TELEMETRY_OPTOUT = 'true'
$env:ASPIRE_DASHBOARD_TELEMETRY_OPTOUT = 'true'

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
set -euo pipefail
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export ASPIRE_CLI_TELEMETRY_OPTOUT=true
export ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true

umask 077
tmp_parent="${TMPDIR:-/private/tmp}"
mkdir -p "$tmp_parent"
work_dir="$(mktemp -d "${tmp_parent%/}/sf-workstation.XXXXXXXX")"
cert_pem="$work_dir/aspire-dev.pem"

dotnet dev-certs https --export-path "$cert_pem" --format PEM >/dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$cert_pem"
export ASPIRE_ALLOW_UNSECURED_TRANSPORT=false
export ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false
export ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL="https://127.0.0.1:18890"
```

### Linux and WSL2 (`bash`)

On Linux distributions and WSL2, OpenSSL/NSS browser trust varies by distro. Ensure the parent runtime/cache directory exists first (for fresh accounts where `XDG_RUNTIME_DIR` is unset and `~/.cache` does not yet exist), export the PEM file with telemetry opt-outs active, and supply `NODE_EXTRA_CA_CERTS` (plus `curl --cacert "$cert_pem"` for CLI checks) for deterministic loopback TLS verification without root or `update-ca-certificates` changes:

```bash
set -euo pipefail
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export ASPIRE_CLI_TELEMETRY_OPTOUT=true
export ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true

umask 077
cache_parent="${XDG_RUNTIME_DIR:-$HOME/.cache}"
mkdir -p "$cache_parent"
work_dir="$(mktemp -d "${cache_parent%/}/sf-workstation.XXXXXXXX")"
cert_pem="$work_dir/aspire-dev.pem"

dotnet dev-certs https --export-path "$cert_pem" --format PEM >/dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$cert_pem"
export ASPIRE_ALLOW_UNSECURED_TRANSPORT=false
export ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false
export ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL="https://127.0.0.1:18890"
```

## Deterministic zero-private-data preflight (`workstation-preflight.mjs`)

Before starting `apphost.cs`, run `tools/engineering-factory/workstation-preflight.mjs` to verify local toolchain pins, telemetry opt-outs, scoped loopback HTTPS posture, and operational isolation without mutating OS trust stores or emitting personal data:

```bash
# macOS / Linux / WSL2 (run in a clean subshell without ambient PAT/API-key env vars)
(
  unset GITHUB_TOKEN GH_TOKEN COPILOT_GITHUB_TOKEN OPENAI_API_KEY ANTHROPIC_API_KEY
  PATH="$HOME/.local/share/softwarefactory-aspire-tools:$PATH" \
    node tools/engineering-factory/workstation-preflight.mjs
)

# Evaluate an explicit read-only JSON observation fixture offline
node tools/engineering-factory/workstation-preflight.mjs --observation <observation.json>
```

```powershell
# Windows 11 PowerShell 7+ (after exporting $certPem and telemetry/TLS env vars; clear ambient PATs if set)
Remove-Item Env:GITHUB_TOKEN, Env:GH_TOKEN, Env:COPILOT_GITHUB_TOKEN -ErrorAction SilentlyContinue
$toolDir = Join-Path $HOME '.local\share\softwarefactory-aspire-tools'
$env:PATH = "$toolDir$([IO.Path]::PathSeparator)$env:PATH"
node tools/engineering-factory/workstation-preflight.mjs
```

### Preflight evaluator invariants (`evaluateWorkstationCompatibilityPreflight(observation)`)

`evaluateWorkstationCompatibilityPreflight(observation)` in `tools/engineering-factory/workstation-preflight.mjs` is pure, deterministic, read-only, and fail-closed (`shadow: true`, `nonBlockingOptionalP2: true`, `operationalOrchestratorAllowed: false`, `liveDispatch: false`, `liveMerge: false`, `zeroPrivateData: true`):

- **Strict input shape**: Enforces `types.isProxy` rejection and plain-object own-enumerable-data-descriptor checks across `observation`, `observation.env`, `observation.pemCa`, and optional dense arrays (`observedIpAddresses`, `loopbackEndpoints`, `diagnosticNotes`).
- **Pinned toolchain & platforms**: Requires `platform` in `windows-11` (`win32`), `macos` (`darwin`), `linux`, or `wsl2` (`arch` in `x64` or `arm64`), `nodeVersion === "v26.13.1"`, `dotnetSdkVersion === "10.0.404"`, and `aspireCliVersion === "17.0.0"`.
- **Telemetry opt-outs**: Requires `DOTNET_CLI_TELEMETRY_OPTOUT === "1"`, `ASPIRE_CLI_TELEMETRY_OPTOUT === "true"`, and `ASPIRE_DASHBOARD_TELEMETRY_OPTOUT === "true"`, and blocks external OTLP exporter overrides (`TELEMETRY_OPTOUT_MISSING`).
- **Scoped loopback HTTPS without OS trust store edits**: Requires `ASPIRE_ALLOW_UNSECURED_TRANSPORT === "false"`, `ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS === "false"`, `osRootTrustStoreModified === false`, zero `NODE_TLS_REJECT_UNAUTHORIZED` or proxy interception overrides, and a readable non-symlink X.509 certificate PEM bundle in `NODE_EXTRA_CA_CERTS` outside OS/Keychain/NSS root stores (`OS_ROOT_TRUST_MODIFIED` / `INVALID_OR_UNREADABLE_PEM_CA`).
- **Operational host & spend prohibition**: Requires `operationalOrchestratorMode === false` (and rejects `authoritativeLeaseStore: true`, `hostedWorkerHost: true`, `replacesHostedRunnerValidation: true`, `--operational-orchestrator`, self-hosted runner flags, or `incrementalSpendUsdCents > 0`).
- **Zero private workstation data**: Rejects explicit workstation identity properties, ambient identity env vars (`USER`, `USERNAME`, `HOME`, `HOSTNAME`, `COMPUTERNAME`), secret tokens/private keys (`?t=...`, `DASHBOARD__API__SECONDARYAPIKEY`, PATs/API keys, `PRIVATE KEY` PEM blocks), MAC addresses, and any IP address beyond loopback `127.0.0.1` / `::1`. Local user directory prefixes in `NODE_EXTRA_CA_CERTS`, `ASPIRE_HOME`, `ASPIRE_DASHBOARD_DATA_DIRECTORY`, and `stripPrivateWorkstationIdentifiers(rawText)` are stripped (`<redacted-home>`, `<redacted-runtime-dir>`, `<redacted-temp>`) and raw filesystem paths are never included in diagnostic receipts.

## Single-command isolated AppHost start, verify, and stop

Use `aspire start --apphost apphost.cs --isolated` inside a subshell with an `EXIT` cleanup handler registered before startup so failure paths also attempt `aspire stop --apphost apphost.cs --non-interactive`. Remove `$work_dir` only after shutdown succeeds, retaining `$work_dir` (`ASPIRE_HOME` and private logs) for manual recovery if `aspire stop` fails:

```bash
(
  set -euo pipefail
  export DOTNET_CLI_TELEMETRY_OPTOUT=1
  export ASPIRE_CLI_TELEMETRY_OPTOUT=true
  export ASPIRE_DASHBOARD_TELEMETRY_OPTOUT=true
  export ASPIRE_ALLOW_UNSECURED_TRANSPORT=false
  export ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=false
  export ASPIRE_DASHBOARD_PERSISTENCE_MODE=Run
  export ASPIRE_DASHBOARD_DATA_DIRECTORY="$work_dir/dashboard-data"
  export ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL="https://127.0.0.1:18890"
  export ASPIRE_HOME="$work_dir/aspire-home"
  export PATH="$HOME/.local/share/softwarefactory-aspire-tools:$PATH"
  mkdir -p "$ASPIRE_DASHBOARD_DATA_DIRECTORY"

  apphost_started=0
  cleanup() {
    local exit_code=$?
    set +e
    local stop_ok=1
    if [ "$apphost_started" -eq 1 ]; then
      if ! aspire stop --apphost apphost.cs --non-interactive >/dev/null 2>&1; then
        stop_ok=0
        printf 'WARN: aspire stop failed; retaining work_dir for manual recovery\n' >&2
        if [ "$exit_code" -eq 0 ]; then
          exit_code=1
        fi
      fi
    fi
    if [ "$stop_ok" -eq 1 ]; then
      rm -rf -- "$work_dir"
    fi
    exit "$exit_code"
  }
  trap cleanup EXIT

  # 1. Start isolated AppHost over authenticated loopback HTTPS
  apphost_started=1
  aspire start --apphost apphost.cs --isolated --non-interactive --nologo >"$work_dir/startup.log" 2>&1

  # 2. Extract loopback origin without printing the login token and verify 302 login challenge
  origin="$(grep -Eom1 'https://(localhost|127\.0\.0\.1|\[::1\]):[0-9]+' "$work_dir/startup.log")"
  status_code="$(curl --silent --show-error --noproxy '*' --max-time 10 --cacert "$cert_pem" \
    --output /dev/null --write-out '%{http_code}' "$origin/resources")"
  test "$status_code" = 302

  # 3. Explicitly run the finite synthetic-shadow resource and verify clean OTel shutdown
  aspire resource synthetic-shadow start --apphost apphost.cs --non-interactive
  aspire wait synthetic-shadow --status down --timeout 20 --apphost apphost.cs
  aspire logs synthetic-shadow --apphost apphost.cs --non-interactive | \
    grep -E 'STOPPED|LOCAL_SDK_SHUTDOWN_COMPLETE'

  # 4. Optional telemetry archive export; EXIT trap handles deterministic stop and cleanup
  aspire export --apphost apphost.cs --output "$work_dir/telemetry-export.zip" --non-interactive
)
```

On PowerShell (Windows 11), register the equivalent `try { ... } finally { ... }` handler before `aspire start` so failed checks still stop the isolated AppHost and retain `$workDir` if shutdown fails:

```powershell
$ErrorActionPreference = 'Stop'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:ASPIRE_CLI_TELEMETRY_OPTOUT = 'true'
$env:ASPIRE_DASHBOARD_TELEMETRY_OPTOUT = 'true'
$env:ASPIRE_ALLOW_UNSECURED_TRANSPORT = 'false'
$env:ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS = 'false'
$env:ASPIRE_DASHBOARD_PERSISTENCE_MODE = 'Run'
$env:ASPIRE_DASHBOARD_DATA_DIRECTORY = Join-Path $workDir 'dashboard-data'
$env:ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL = 'https://127.0.0.1:18890'
$env:ASPIRE_HOME = Join-Path $workDir 'aspire-home'
$toolDir = Join-Path $HOME '.local\share\softwarefactory-aspire-tools'
$env:PATH = "$toolDir$([IO.Path]::PathSeparator)$env:PATH"
New-Item -ItemType Directory -Path $env:ASPIRE_DASHBOARD_DATA_DIRECTORY -Force | Out-Null

$appHostStarted = $false
$runSucceeded = $false
$stopSucceeded = $true
try {
  $appHostStarted = $true
  aspire start --apphost apphost.cs --isolated --non-interactive --nologo *> (Join-Path $workDir 'startup.log')
  if ($LASTEXITCODE -ne 0) { throw "aspire start failed ($LASTEXITCODE)" }

  $startupText = Get-Content -Raw (Join-Path $workDir 'startup.log')
  $originMatch = [regex]::Match($startupText, 'https://(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+')
  if (-not $originMatch.Success) { throw 'Loopback HTTPS dashboard origin was not reported' }
  $statusCode = & curl.exe --silent --show-error --noproxy '*' --max-time 10 --cacert $certPem `
    --output NUL --write-out '%{http_code}' "$($originMatch.Value)/resources"
  if ($LASTEXITCODE -ne 0 -or $statusCode -ne '302') { throw 'Dashboard did not require login over trusted TLS' }

  aspire resource synthetic-shadow start --apphost apphost.cs --non-interactive
  if ($LASTEXITCODE -ne 0) { throw "resource start failed ($LASTEXITCODE)" }

  aspire wait synthetic-shadow --status down --timeout 20 --apphost apphost.cs
  if ($LASTEXITCODE -ne 0) { throw "resource wait failed ($LASTEXITCODE)" }

  $logs = aspire logs synthetic-shadow --apphost apphost.cs --non-interactive
  if ($LASTEXITCODE -ne 0 -or -not ($logs -match 'STOPPED') -or -not ($logs -match 'LOCAL_SDK_SHUTDOWN_COMPLETE')) {
    throw 'Expected STOPPED and LOCAL_SDK_SHUTDOWN_COMPLETE markers were not observed'
  }

  aspire export --apphost apphost.cs --output (Join-Path $workDir 'telemetry-export.zip') --non-interactive
  if ($LASTEXITCODE -ne 0) { throw "aspire export failed ($LASTEXITCODE)" }
  $runSucceeded = $true
} finally {
  Remove-Item Env:NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue
  if ($appHostStarted) {
    aspire stop --apphost apphost.cs --non-interactive *> $null
    if ($LASTEXITCODE -ne 0) {
      $stopSucceeded = $false
      Write-Warning 'aspire stop failed; retaining workDir for manual recovery'
    }
  }
  if ($stopSucceeded) {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
if ($runSucceeded -and -not $stopSucceeded) {
  throw 'aspire stop failed; retained workDir for manual recovery'
}
```

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
2. Exact tool versions (`node --version`, `dotnet --version`, `aspire --version`) and sanitized preflight receipt (`node tools/engineering-factory/workstation-preflight.mjs` -> `WORKSTATION_COMPATIBILITY_VERIFIED`, `zeroPrivateData: true`).
3. Exit codes and redacted loopback check outcomes (`302 /login` verified, `STOPPED` + `LOCAL_SDK_SHUTDOWN_COMPLETE` observed, `aspire stop` exit `0`, zero lingering listeners).
4. **Never** attach raw `startup.log` files, exported `.zip` archives containing environment variables, login `?t=` tokens, certificates/private keys, or personal paths, and **never** close `#17` or `#15` from workstation evidence.
