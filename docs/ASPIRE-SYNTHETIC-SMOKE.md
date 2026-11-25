# Local Aspire smoke (partial implementation)
The file-based AppHost pins Aspire hosting packages to 17.0.0 and uses a process-based Node resource. Its explicit-start resource runs a finite, disabled-policy fixture only; no network or provider credentials are needed by the script. No HTTP endpoint is added. The script is not an OTLP exporter.

Prerequisites to verify locally: stable Aspire 17 CLI, compatible .NET SDK, Node 26.13.1, package restore, and default dashboard authentication and loopback listeners. Run the headless script from repository root with `node tools/engineering-factory/aspire-smoke.mjs`. On a trusted local development machine, after confirming those prerequisites and local-only dashboard binding, run `aspire run` from repository root, then start the synthetic-shadow resource from the dashboard; it should print a single blocked/STOPPED result and exit. Stop the AppHost with Ctrl+C.

Do not expose the dashboard or OTLP listener, disable dashboard auth, provide GitHub tokens, or deploy this AppHost. The actual Windows restore/launch and dashboard verification are not yet demonstrated. Future acceptance requires real local OTLP reception and pinned dependency restore, coverage for executable components, and independent review. No blanket exemption is claimed.

Official reference: https://aspire.dev/get-started/add-aspire-existing-app/ and https://aspire.dev/app-host/console-apps/.
