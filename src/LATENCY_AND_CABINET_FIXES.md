# Wathiq Agent — latency and cabinet intent fixes

This patch is based on `wathiq_modify_routine_recovery_full.zip` and changes only four existing source files: `agent/agent.ts`, `agent/fastLane.ts`, `agent/intents.ts`, and `agent/prompt.ts`.

## What changed

- **Cabinet questions in Algerian Darija are recognized deterministically.** The intent parser now recognizes forms such as `وش كاين فخزانتي`, `وريهملي قع`, and related “show/list my cabinet” requests.
- **The cabinet-routine phrasing in the supplied trace takes the fast path.** `اوك اخدم روتين فكل منتجات خزانتي` is recognized as a cabinet-based routine request. When the request does not name skin or hair, the route infers the focus from products currently in use and then the saved profile instead of abandoning the fast path solely because a skin/hair keyword is absent.
- **Cabinet routines are honest about what they used.** A signed-out user is not told that a cabinet routine was built, and an empty/unusable cabinet does not silently become a generic catalog routine. The response explains what is missing. Successful routine results are explicitly marked as cabinet-based, and routine copy does not promise that every cabinet item was placed.
- **Common follow-ups avoid needless LLM round-trips.** “Show them all” after a cabinet card reuses the cabinet tool. Explicit “which sunscreen should I add?” questions use the structured sunscreen search directly and exclude already-owned active products where IDs are available. Explicitly named products in recent search results can be added to the cabinet directly when there is exactly one match; ambiguous matches remain on the clarification/model path.
- **Streaming failure waits are shorter by default.** First useful output now defaults to 8 seconds per attempt and the non-streaming fallback defaults to 6 seconds, instead of the prior 15 + 15 + 20 second wait chain. One alternate-key attempt is retained by default.
- **Completed tool results survive stalled synthesis.** If the model stalls after a tool has completed, the system surfaces the real card with a localized, factual message rather than retrying a duplicate tool call. Recovery is checked both after streaming and after the non-streaming fallback, covering the case where a tool completes but the fallback synthesis times out.
- **Prompt protocol updated.** The model instructions now explicitly describe cabinet-based routines, how to infer the routine type, and how to communicate products that could not be placed.

## Timeout configuration

Defaults changed in `agent/agent.ts`:

- `AGENT_FIRST_USEFUL_OUTPUT_TIMEOUT_MS` (legacy alias: `AGENT_FIRST_TOKEN_TIMEOUT_MS`): 8000 ms
- `AGENT_NON_STREAM_FALLBACK_TIMEOUT_MS`: 6000 ms
- `AGENT_POST_TOOL_TEXT_TIMEOUT_MS`: 6000 ms
- `AGENT_EMPTY_STREAM_ATTEMPTS`: 2

Explicit environment values still override these defaults. If your local `.env` defines the older timeout variables with larger values, lower them to the values above to receive the new latency budget.

## Validation performed

- TypeScript transpile/syntax checks passed for all four modified files.
- Targeted regex smoke checks passed for the exact cabinet-routine phrase, `وش كاين فخزانتي`, the list-command variant, and `وش من واقي شمس نزيد؟`.
- Compared against the supplied recovery ZIP: only the four intended source files differ, plus this documentation file.
- A full TypeScript build could not be run from this archive because it has no `package.json`/lockfile or installed project dependencies. The available type-check attempt therefore reports missing modules and existing project-wide type errors; those are not represented as a successful build.

## After applying

Restart the agent server so the modified TypeScript is loaded. In debug logs, the cabinet inventory and cabinet-routine cases should report a `FAST LANE` result and `modelCalls=0`; a completed tool with stalled prose should show a `TOOL_RECOVERY` entry instead of waiting through another model attempt.
