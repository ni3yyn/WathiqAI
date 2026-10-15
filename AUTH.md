# Firebase auth for the agent — how it works & how to run it

## Switch it on (agent server env)
```
AUTH_MODE=optional            # off (default) | optional (guests allowed) | required
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_WEB_API_KEY=...      # optional: enables the revoked/disabled-account check
# optional tuning
AUTH_ALLOW_ANONYMOUS=false    USER_CACHE_FRESH_MS=60000   USER_CACHE_STALE_MS=900000
USER_CACHE_MAX=500            FIRESTORE_TIMEOUT_MS=8000   RATE_CHAT_PER_MIN=20
OVERLAY_FILE=data/user_overlay.json   OVERLAY_SALT=<your own secret>
```
`npm i jose` (new dependency). Behind a reverse proxy set Fastify `trustProxy: true` so the per-IP guest rate limit sees real IPs.
No service-account key is needed: the agent verifies ID tokens against Google's public keys and reads Firestore **with the user's own token**, so your security rules decide what it can see.

## What the frontend (index.html) must send — nothing else changes
```js
const token = await firebase.auth().currentUser.getIdToken();       // auto-refreshes; call it per request
fetch('/api/chat', { method:'POST',
  headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + token },
  body: JSON.stringify({ message, sessionId, stream:true }) });
```
Do NOT send userId / rememberMe — the server ignores them (the uid comes from the token).
After the user edits their profile or saves a product, send `refreshUserData: true` with the next chat message (or `POST /api/auth/refresh`). On sign-out call `POST /api/auth/logout`.

## Endpoints
| | |
|---|---|
| `GET /api/me` | who am I + counts (name, gender, language, shelfCount…) |
| `GET /api/me/shelf` | the app shelf as the agent sees it (+ the agent's private annotations) |
| `PATCH /api/me/shelf/:id` | `{status, verdict, note, reason}` — agent-side annotation only |
| `DELETE /api/me/shelf/:id` | hide from the assistant only |
| `POST /api/auth/refresh` · `POST /api/auth/logout` | force reload · purge RAM cache |
| `DELETE /api/me/agent-data` | erase everything the agent stored for this user |
Errors: `401 {error: missing_token|expired|invalid_signature|wrong_audience|wrong_issuer|malformed|revoked}` (+`WWW-Authenticate`), `403 anonymous_not_allowed`, `429 rate_limited` (+`Retry-After`), `503 auth_unavailable`. On `expired`, refresh the token and retry once.
The old `userId`-based `/api/cabinet*` endpoints return `410` when auth is on.

## Security properties (all tested in `scripts/auth.test.ts`)
- uid only from the verified token; client `userId` / `authenticated` / `rememberMe` are dropped or overwritten.
- Sessions are namespaced `u:<uid>:<sessionId>` — one user can never reach another's conversation.
- A bad token is rejected, never silently downgraded to guest. `alg:none`, wrong audience/issuer, expired and foreign-signature tokens are refused.
- The agent never writes to your Firestore. Its own notes live in `data/user_overlay.json` (hashed key, 0600).
- RAM cache: compact (no push tokens, no raw analysis blobs), LRU 500, entries die with the token's expiry, single-flight loads, stale-while-revalidate, falls back to stale data if Firestore is down.
- Logs never contain tokens; user ids are never logged.
