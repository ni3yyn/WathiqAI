# Wathiq log diagnosis and fixes

## What the supplied log showed

1. **The catalog and server were healthy.** The 3,029-product catalog warmed successfully and the API server started. Asset requests and authenticated shelf requests returned normally.
2. **The routine was built successfully.** `build_routine` completed in 372 ms and Fast Lane dispatched it in 399 ms. Its card was emitted at about 456 ms. The following narration call failed with Google's `401 UNAUTHENTICATED / API key not valid`; Wathiq correctly fell back to the deterministic routine text, with the request completing in about 1.15 seconds. The tool result itself did not fail.
3. **The evaluation request fell out of Fast Lane.** The router classified the request as `evaluate_product/high`, but `resolveProductTarget` treated `DZ-SSE-PHAR-001` as part of a fuzzy name query. The log confirms this with `Strategy 5 (ambiguous): top candidates = DZ-SSE-PHAR-001`. Fast Lane returned `fallback-to-llm`, so evaluation was not executed.
4. **The model tried only 2 of 7 keys.** Attempt 1 produced no useful output and timed out at 8 seconds. Attempt 2 surfaced a 401 key error, but the SDK delivered it as an `error` stream event. The agent counted it against the generic empty-stream budget and stopped at `maxEmptyStreamAttempts=2`, despite five keys remaining. The 6-second non-streaming fallback then aborted, producing the 14.6-second request with no card or text.

The log therefore demonstrates that `GEMINI_API_KEYS` was split into seven entries; it does **not** prove that all seven are valid. At least one selected key was rejected by Google. A timeout on another selected key is not proof that the key is invalid.

## Changes in this package

- Explicit product IDs are extracted and looked up by ID before any fuzzy product-name parsing. A valid ID proceeds straight to the existing Wathiq evaluator. An unknown explicit ID receives a short clarification response rather than another LLM tool-selection call.
- A decisive `evaluate_product` request that cannot be resolved no longer falls through to the slow model path; it asks for a better identifier instead of guessing.
- Gemini 401/403 credential errors are detected whether the AI SDK throws them or yields them as a stream `error` part. A rejected key rotates to the next configured key without consuming the timeout-only empty-stream budget.
- Post-card narration now tries subsequent configured keys after a credential rejection, within the same first-token and total narration deadlines. It does not retry after any narration text has already been shown.
- API keys remain out of logs. The comma-separated `GEMINI_API_KEYS=key1,key2,...` format remains canonical.

## Validation performed

- TypeScript transpilation/syntax checks passed for the two changed source files.
- Focused smart-speed/key-failover suite: **35 passed, 0 failed**. Includes exact product ID resolution, unknown ID clarification, card-first behavior, and simulated 401 key failover in both narration and main model paths.
- Offline smoke suite: **400 passed, 0 failed**.
- No live API keys were used to test key validity, and a full production build was not run because the supplied package lacks its original dependency manifest. Real key validity and quota must still be confirmed in the local `.env` without sharing secrets.

## Safe `.env` check

Use actual Gemini API keys issued for the Gemini Developer API, not examples/placeholders or OAuth access tokens:

```dotenv
GEMINI_API_KEYS=actual_key_1,actual_key_2,actual_key_3
```

Do not paste the actual key values into chat or logs. The new failover will try other keys on a credential rejection, but it cannot make an invalid key valid. If every configured key is rejected, the card-first paths still retain their deterministic fallback; non-fast-lane model requests will eventually report that no model output was available.
