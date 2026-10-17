# Wathiq Smart-Speed Evaluation Routing

## What changed

### 1. API-key order is shuffled once per incoming user message

`GEMINI_API_KEYS=key1,key2,key3` is the canonical configuration. The app splits the value on commas, trims surrounding whitespace/optional quotes, removes duplicates, and cryptographically shuffles the list once at the start of each incoming user message. The same request-local order is then reused by Fast Lane narration, the streaming attempts, and any non-streaming fallback; the pool is not reshuffled halfway through one turn.

When `GEMINI_API_KEYS` contains at least one valid key, it is authoritative: keys from legacy variables are not mixed into the pool. If it is absent or empty, the app retains backward compatibility with `GOOGLE_API_KEYS`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, and `GEMINI_API_KEY_1` through `_50`. Duplicate keys are removed. When there is more than one distinct configured key, the primary is prevented from matching the previous user turn's primary when possible. Key values are never logged. A one-key pool cannot rotate, and key shuffling does not itself guarantee rate-limit relief or make an invalid key valid.

### 2. Product evaluation goes to the existing evaluator first

The router treats a decisive `evaluate_product` intent as an execution decision, not a suggestion to the LLM. The agent passes the request to the existing Wathiq evaluator and uses its scores, claims assessment, and product record as the source of truth. This avoids having the model spend a round trip deciding whether to evaluate a product.

The action taxonomy centralizes common judgment/evaluation language across English, French, Arabic, Algerian Darija, and common Arabizi. It works with the existing intent router and product/category taxonomy rather than relying only on exact full-message regexes. Context-only questions can refer to the current product, while requests that clearly introduce a new category or target should not accidentally evaluate the previously discussed product.

### 3. The evaluation card streams before the LLM narration

When Fast Lane completes a tool call, its card is emitted immediately. If the card has an authoritative result and narration is enabled, the model receives a compact evidence snapshot **without tools** and writes only a short explanation. It cannot call the evaluator again, select a different product, or replace the returned scores.

If narration is slow, fails, or yields no first token before its deadline, the already-delivered card remains valid and the agent uses the deterministic Fast Lane response. A narration failure does not trigger another tool-selection/model round trip.

### 4. Latency controls

Defaults:

| Variable | Default | Minimum | Purpose |
| --- | ---: | ---: | --- |
| `FAST_LANE_LLM_NARRATION` | enabled | — | Set to `false` for deterministic text only (fastest path) |
| `FAST_LANE_NARRATION_FIRST_TOKEN_MS` | `2800` | `1000` | Deadline before falling back if narration produces no token |
| `FAST_LANE_NARRATION_TOTAL_MS` | `7500` | `3000` | Maximum narration window |

These limits govern narration after the evaluation card is sent. They do not shorten the underlying evaluator's own runtime.

### 5. Logging to inspect after deployment

With debug logging enabled, check:

- `INTENT_ROUTER` — whether the taxonomy selected the expected tool
- `FAST_LANE_DISPATCH` — time until the direct tool path is selected
- `FAST_NARRATION` — narrator fallback/timeout events
- `FAST LANE (...) firstCard=... firstText=... modelCalls=...` — overall timing

For a direct evaluation, the expected shape is: decisive `evaluate_product` intent → evaluator execution → product card event → optional tool-free narration. A card should not wait for narration.

## Validation performed

- Offline smoke suite: **400 passed, 0 failed**.
- Focused smart-speed/key-pool regressions: **35 passed, 0 failed**. These cover varied judgment phrasing in Arabic/Darija, English, and French; no context hijack after a category switch; the card arriving first; evaluator execution occurring once; rotation between consecutive messages; canonical-pool precedence over stale legacy variables; quoted comma-separated pool parsing; and bounded fallback for a stalled narrator.
- The tests used a synthetic catalog and test-only local shims; no API key or network call was required.
- A full repository type-check/build was **not** claimed: the supplied source package does not include a package manifest/dependencies needed for that command, and the available full `tsc` attempt encountered missing Node type declarations and unrelated pre-existing type errors. Runtime-import/transpilation smoke checks and focused regression checks passed.

## Deployment note

Provide at least two distinct valid keys in the supported environment variables for actual key rotation. Start with narration enabled. If the card-first path should be as fast as possible and a deterministic response is acceptable, set `FAST_LANE_LLM_NARRATION=false`.

## Log-driven hardening (2026-10-16)

- Exact catalog IDs are resolved before fuzzy name parsing in Fast Lane evaluation.
- If a decisive evaluation request cannot be resolved, ask for a clear identifier instead of spending time on an LLM tool-selection round.
- Gemini authentication failures yielded by the stream are now treated as key-specific and rotate through the remaining `GEMINI_API_KEYS` pool. They do not consume the generic empty-stream timeout retry budget.
- Fast Lane narration also advances to another key after a 401, while retaining its first-token and total latency bounds.
- See `LOG_DIAGNOSIS_AND_FIXES.md` for the causal log analysis and validation results.
