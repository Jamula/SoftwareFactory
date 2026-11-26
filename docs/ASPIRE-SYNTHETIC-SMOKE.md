# Local Aspire smoke (partial implementation)
The file-based AppHost pins Aspire hosting packages to 17.0.0 and uses a process-based Node resource. Its explicit-start resource runs a finite, disabled-policy fixture only; no network or provider credentials are needed by the script. No HTTP endpoint is added. The script is not an OTLP exporter.

Prerequisites to verify locally: stable Aspire 17 CLI, compatible .NET SDK, Node 26.13.1, package restore, and default dashboard authentication and loopback listeners. Run the headless script from repository root with `node tools/engineering-factory/aspire-smoke.mjs`. On a trusted local development machine, after confirming those prerequisites and local-only dashboard binding, run `aspire run` from repository root, then start the synthetic-shadow resource from the dashboard; it should print a single blocked/STOPPED result and exit. Stop the AppHost with Ctrl+C.

Do not expose the dashboard or OTLP listener, disable dashboard auth, provide GitHub tokens, or deploy this AppHost. The actual Windows restore/launch and dashboard verification are not yet demonstrated. Future acceptance requires real local OTLP reception and pinned dependency restore, coverage for executable components, and independent review. No blanket exemption is claimed.

Official reference: https://aspire.dev/get-started/add-aspire-existing-app/ and https://aspire.dev/app-host/console-apps/.

## Windows evidence checklist (run on an authorized local workstation)
From repository root in PowerShell, record the exact source revision and prerequisites:
```powershell
git rev-parse HEAD
dotnet --info
aspire --version
node --version
npm ci --ignore-scripts
npm run test:coverage
node tools/engineering-factory/aspire-smoke.mjs
```
Stop if restore, coverage (98% lines / 95% branches), or the headless smoke fails. Start `aspire run` only after verifying the configured dashboard and OTLP listeners are local-only and authentication is enabled. Start the explicit synthetic resource, capture its STOPPED result, stop the AppHost and verify its processes/listeners are gone. Record versions, redacted listener addresses, exit codes and exact commit. Never paste dashboard login tokens or personal data. Report trace, metric and correlated log reception separately; the existing runner does not export OTLP, so these checks remain outstanding until the exporter is implemented. Do not mark #17 accepted from this checklist alone.

## Build evidence

The Factory validation job restores and compiles the file-based AppHost with .NET SDK 10.0.404 and Aspire CLI 17.0.0. It installs Aspire into the runner's temporary tools directory and disables .NET and Aspire CLI usage telemetry. Review the candidate commit's `Restore and build the pinned Aspire AppHost` step for the result. The separate `Exercise the isolated Aspire AppHost` step runs on same-repository PRs and main pushes. It checks for a loopback HTTPS dashboard login, explicitly starts the synthetic resource, verifies its STOPPED result and exit, and stops the isolated AppHost. CLI output stays in a private temporary file so dashboard login tokens are not published. This is Linux runner evidence. The authenticated Windows launch and local OTLP evidence in the acceptance checklist still require a separate run.
