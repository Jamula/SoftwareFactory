# Hosted GitHub Pages Dashboard (`SoftwareFactory Live Board`)

`buildStaticBoardPagesBundle` in `tools/engineering-factory/factory-board.mjs` (and CLI wrapper `scripts/build-factory-board-pages.mjs`) exports the **SoftwareFactory Live Board** as a zero-spend (`$0.00`), read-only static GitHub Pages bundle (`https://jamula.github.io/SoftwareFactory/`).

## Architecture & Security Invariants

1. **Zero secrets, zero external CDNs, zero infrastructure spend (`$0.00`):**
   - Emits `index.html`, `client.mjs`, `snapshot.json`, and `.nojekyll` into `dist/pages/`.
   - Embeds a strict `<meta http-equiv="Content-Security-Policy">` (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.github.com; img-src 'self' data:; object-src 'none'; base-uri 'self'`).
2. **Instant baked snapshot + live browser REST refresh:**
   - Hydrates immediately from `./snapshot.json` (which includes full GraphQL CI check rollups and Merge Queue positions when built in GitHub Actions with `GITHUB_TOKEN`).
   - Polls public read-only `https://api.github.com/repos/Jamula/SoftwareFactory/{milestones,issues,pulls}` directly in the browser (`10s`–`300s` interval selector, Pause/Resume, and Refresh Now) with automatic `x-ratelimit-remaining === "0"` / `x-ratelimit-reset` backoff.

## Local Build & Preview

```bash
node scripts/build-factory-board-pages.mjs dist/pages
```

## Enabling GitHub Pages Deployment (Owner Settings)

1. In **Repository Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
2. Once owner-approved under protected control-plane review, add `.github/workflows/deploy-pages.yml` running `node scripts/build-factory-board-pages.mjs dist/pages` (`permissions: { contents: read, pages: write, id-token: write }`) and uploading `dist/pages` via `actions/upload-pages-artifact` + `actions/deploy-pages`.
