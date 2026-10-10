# Wathiq agent upgrade — what changed

Drop the `src/` and `scripts/` folders over your project (same layout as your imports).
`npx tsx scripts/smoke.ts` runs 172 offline checks (no keys, no network).

## Speed
| Change | Where |
|---|---|
| **Fast lane**: high-confidence, fully-resolvable requests run the tool directly, stream the card, and answer from an ar/fr/en template — 0 model calls. Anything uncertain (compound, ambiguous name, tool error, relaxed filters, safety trigger) falls back to the untouched LLM path. Kill switch: `FAST_LANE=false` | `agent/fastLane.ts`, `agent/cards.ts`, `agent.ts` |
| **Shared evaluation cache** (45 min, in-flight de-dup, never caches malformed replies); every tool benefits with no call-site changes | `wathiq/backendClient.ts` |
| **Precomputed search index** — no per-query Arabic normalization of the whole catalog | `tools/searchIndex.ts`, `searchProducts.ts` |
| Brand category-focus now runs **in parallel** with the brand aggregate | `evaluateBrand.ts` |
| Client disconnect aborts generation (stops burning tokens) | `server.ts`, `agent.ts` |
| First-token timeout (multi-key only, `AGENT_FIRST_TOKEN_TIMEOUT_MS`, default 9000) so a hung key fails over | `agent.ts` |
| Shorter tool descriptions (rules live once, in prompt.ts) | `agent.ts` |
| Timing logs: `[TIMING] FAST LANE|LLM PATH total/firstCard/firstText` | `agent.ts` |

## New capabilities
- `product_contains` – full-INCI "does it have X?" (fixes the 15-ingredient truncation bug)
- `find_alternatives` – substitutes ranked by shared actives, then price
- `check_compatibility` – deterministic interaction rules + AM/PM split + sunscreen/pregnancy notes
- `modify_routine` – swap / remove / add / refit without rebuilding
- Deterministic search follow-ups: "المزيد", "فقط الجزائرية", "تحت 2000", "بدون كحول", "الأرخص"
- `get_product` now returns country, size, target types, ingredient count

## Bugs fixed
1. Safety triggers were skipped for tool-style queries (pregnancy + "recommend a retinol serum"). Triggers now always run; vector lookup is still skipped.
2. Staging queue / learned taxonomy used three different paths → single `src/paths.ts`.
3. Learned dialect words needed a restart and soothing/cleansing keys were never merged → hot reload via mtime.
4. `\bروتين\b` never matched Arabic (JS `\b`), so "روتين" alone missed the routine intent.
5. Compare summary said "المنتجان" for 3–4 products.

## Client changes needed
- New card types: `ingredient_presence` ({presence}) and `compatibility` ({compatibility}).
- `product_results` may carry `reference` (find_alternatives) and per-product `sharedActives`, `priceDiffPct`.
- Responses now include `lane: "fast" | "llm"` (ignore if unused).

## Please review / do
- **Interaction rules** (`ingredientKnowledge.ts` → INTERACTION_RULES, PREGNANCY_NOTE) are safety statements; have someone qualified review them.
- Move your existing `learned_taxonomy.json` to `src/agent/` (the worker also merges the legacy location once).
- Fast-lane templates use the backend's `finalVerdict` text as-is.

---

# v3 — goal-directed intelligence (on top of the upgrade above)

| Pillar | What it does | Where |
|---|---|---|
| **Negation guard** | Finds negation anchors (Darija/Arabic, FR, EN) per clause and removes negated spans before category detection. "روتين… ما رانيش حاب واقي شمس" → routine, **sunscreen excluded**. Verbal negations govern 4 tokens ahead (looking back only when the negation ends the clause); "بدون / sans / without" govern 2 and stop at "و/and". Negated intents ("ما نبغيش روتين") are dropped. `build_routine` got `exclude_categories`, enforced even if the model forgets it, and the reply says what was left out. | `negation.ts`, `agent.ts` router, `tools/buildRoutine.ts` |
| **Active mission** | Goal memory (routine/search + concern + budget + exclusions) created by goal-bearing turns, kept through detours, inherited by searches (budget), closed by "شكراً", expires after 8 turns. On a side question the model gets: answer first, then ONE bridging sentence back to the mission. | `goals.ts`, `agent.ts` |
| **Graceful corrections** | "لا، قصدي الغسول تاعهم مش السيروم" → router flags CORRECTION, the fast lane pivots instantly (same brand, new category): evaluates the one matching product, or shows the brand's products in that category, with ONE short "عذراً". No defending, no clarifying question. Prompt §7 enforces "latest statement wins" on the LLM path. | `corrections.ts`, `fastLane.ts`, `prompt.ts` |
| **Proactive guidance** | One concrete, tool-backed next step per fast-lane answer (evaluation → alternatives, comparison → winner×routine compatibility / cheaper winner, routine edit → compatibility, alternatives → compare with original, contains-hit → alternatives). A bare "نعم / yes / oui" on the next turn **executes it with no model call**. `PROACTIVE=false` disables. Prompt §10 covers the LLM path. | `fastLane.ts`, `prompt.ts` |
| **Opt-in long-term memory** | Durable facts only (skin/hair type, allergies, avoided ingredients, budget ceiling, country, language). Needs `LONGTERM_MEMORY=true` **and** `{ userId, rememberMe: true }` on the request. userId is sha256-hashed (salted), file mode 0600, 180-day TTL, lists capped, unchanged facts not rewritten. Returning users get one welcome-back line; what they say now always overrides what was saved. Erase via `POST /api/memory/forget {userId}` or by saying "انسَ كل شيء / forget me / oublie-moi". | `longterm.ts`, `server.ts`, `agent.ts` |

## New env vars
`LONGTERM_MEMORY` (default off), `LONGTERM_FILE` (default `data/longterm.jsonl`), `LONGTERM_SALT` (**set your own**), `LONGTERM_TTL_DAYS`, `PROACTIVE`.

## Client changes (v3)
- Send `userId` (stable per user) and `rememberMe: true` only after the user consents; offer a "forget me" button that calls `/api/memory/forget`.
- `build_routine` results may include `skippedByRequest` (steps left out on request) — show it if you like.

## Notes
- Mission, offers and corrections are deterministic first; anything ambiguous still falls through to the LLM path with the matching hint.
- The v3 proposal's "Smart Router" was implemented as the negation/correction layer inside the existing router rather than a second router file, so there is still one source of truth for intents.
- Review the welcome-back wording and the proactive-offer phrasing with whoever owns your brand voice.
