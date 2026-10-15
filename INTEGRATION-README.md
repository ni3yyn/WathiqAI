# Wathiq AI + Premium UI integration

This archive combines the premium modular UI with the Wathiq Fastify agent and latency fixes.

## What changed

- The redesigned UI is installed in `public/`, which is what `src/server.ts` serves at `/`.
- Fastify now serves `/assets/*` and `/components/*` from `public/`; those files were previously missing from the agent server, leaving the app at `جارٍ تحميل مكونات وثيق…`.
- Chat uses the same-origin `POST /api/chat` endpoint. No separate API base URL or CORS hop is needed.
- Optional Firebase CDN initialization no longer blocks the UI/orchestrator from finishing startup; guest chat remains available if the CDN is slow or down.
- UI fragment and script requests have bounded 10-second timeouts and surface a readable load error rather than spinning forever.
- Includes the previously added direct-tool latency fixes.

## Applying to your existing repo

Merge `src/` and `public/` into the project root, preserving your existing package manifest, environment variables, deployment configuration and data files. Start the existing Fastify server as usual and open its `/` route. Do not open `public/index.html` using `file://` and do not serve `public/` from a separate static host unless you also configure the API origin explicitly.

## Quick checks

- `GET /` should return `public/index.html`.
- `GET /assets/js/orchestrator.js` should return JavaScript (not a 404 or the HTML shell).
- `GET /components/chat-main/chat-main.html` should return an HTML fragment.
- `GET /health` should return `{ "status": "alive", ... }`.
- Chat messages should POST to `/api/chat` on the same origin.

The uploaded source archive did not contain `package.json`, a lockfile, or `.env`; these were not fabricated here. Keep those from your working project.
