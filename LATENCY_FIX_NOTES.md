# WathiqAI direct-tool latency fixes

## What was causing the delay

1. **The thinking/status text was only a router hint.** The streaming handler showed the status associated with the first predicted tool before a tool call had actually started. When the fast lane declined the request, the user saw a correct-looking search status while the app still proceeded through the model path.
2. **Structured search could fall back to the model unnecessarily.** The direct fast lane had no deterministic `search_products` dispatch case. Additionally, English requests phrased as “I want …” were not recognized by the direct-search intent rule.
3. **Catalog timeouts did not cover the response body.** The old helper cleared its timeout as soon as `fetch()` received response headers. A slow/stalled JSON body could therefore make a tool appear to hang indefinitely.
4. **The first catalog load could wait on repeated long requests.** The network timeout/retry settings were reduced, a brief failure cooldown was added, and the server now starts a non-blocking catalog warm-up so normal requests can use the cached catalog.

## Changes

- Added a deterministic `search_products` path to the fast lane for high-confidence structured product searches. It extracts category, country/demonym, budget, skin/hair concern, active ingredient, claims, exclusions, brand, and sort preference before invoking the tool.
- Added English/French search phrasings including `I want`, `want`, `need`, `je veux`, and `j'aimerais` to the intent router. Added country-demonym extraction such as `Algerian` → `Algeria`.
- Deduplicated multiple intent signals for the same tool before confidence arbitration, preventing duplicate search hints from making the router look ambiguous.
- The initial stream status is now neutral. A tool-specific status is emitted when a direct tool is actually about to execute, or when the model emits a real tool-call event.
- Added timing diagnostics for router duration, safety preflight, fast-lane dispatch, first model event, catalog load/cache, evaluation API, and direct tool execution. Logs intentionally do not dump full tool arguments.
- Applied the catalog/evaluation request timeout to the entire response body read, not only the headers.
- Reduced default catalog fetch wait and retry delay, introduced a short cooldown after total catalog failure, and added a non-blocking startup warm-up.
- Added a regression test for an Algerian sunscreen search with oily-skin and budget constraints.

## Useful log signatures

- `INTENT_ROUTER`: how long routing took and which tool was predicted.
- `SAFETY_GATE`: time spent in the preflight safety check.
- `FAST_LANE_DISPATCH ... result=search_products`: direct path won; no model round-trip should follow.
- `[FAST][TOOL_START]` / `[FAST][TOOL_DONE]`: time inside the actual tool execution.
- `[WATHIQ][CATALOG]`: network/cached catalog latency, attempt count, and failure.
- `LLM PATH ... firstModelEvent=... firstText=...`: latency when a request had to fall back to the model.

## Environment variables

- `WATHIQ_CATALOG_TIMEOUT_MS` (default `4000`): max wait for catalog headers **and body**.
- `WATHIQ_CATALOG_RETRIES` (default `1`, range `0–2`): retries after a failed catalog fetch.
- `WATHIQ_CATALOG_RETRY_BASE_MS` (default `250`): exponential retry base delay.
- `WATHIQ_CATALOG_FAILURE_COOLDOWN_MS` (default `10000`): short cooldown after all catalog attempts fail.
- `WATHIQ_EVALUATE_TIMEOUT_MS` (default `15000`): evaluation API max wait for headers and body.
- `AGENT_DEBUG=false`: disables debug-oriented timing logs (network warnings/errors remain visible).

## Validation performed

- TypeScript transpile/syntax check: **66 `.ts` files, zero syntax/transpile errors**.
- Mocked end-to-end router → fast lane search check: **passed** for “I want an Algerian skin serum for oily skin and brightening claims under 3000 DZD”; it invoked `search_products` once with `category=skin_serum`, `country=Algeria`, `skin_type=oily`, `max_price=3000`, and `marketing_claims=["تفتيح البشرة"]`.
- Slow-response-body timeout check: **passed**; a simulated response that delivered headers but stalled while reading its body aborted at the configured 1000 ms test timeout.
- The supplied archive did not include `package.json`, lockfile, or installed dependencies, so a full dependency-backed application build was not available in this environment.

## 2026-10-15 — Empty LLM stream / tool selection

The LLM remains responsible for choosing tools when the fast lane cannot resolve a request confidently. No additional Darija-specific hard-coded routing was added for this failure.

The supplied logs showed `tool=none confidence=low`, followed by `fallback-to-llm`; that means the LLM tool-calling path was already active. It emitted a stream event but no text and no tool call, then reached the first-useful-output timeout. The SDK can finish its async stream normally after an abort, so the previous code incorrectly logged the attempt as completed and skipped key failover.

Changes in `src/agent/agent.ts`:
- The first-useful-output timeout defaults to 5 seconds (override with `AGENT_FIRST_TOKEN_TIMEOUT_MS`).
- The timer applies even when only one API key is configured, preventing an unbounded silent stream.
- A stream with no text and no tool call is treated as a failed attempt, whether the timeout ended it normally or by throwing.
- One alternate-key retry is allowed by default (`AGENT_EMPTY_STREAM_ATTEMPTS=2` includes the first attempt).
- A retry status is emitted to the client, and exhausted empty attempts return a visible Arabic fallback instead of a blank turn.
- The metric is named `firstStreamEvent` to avoid implying that a visible token or tool call was produced.

Validation: TypeScript transpilation of `src/agent/agent.ts` completed with zero syntax diagnostics. A full application build/runtime test was not possible from this archive because it omits `package.json`, the lockfile, and installed project dependencies.

