# Wathiq agent upgrade — what changed

Drop the `src/` and `scripts/` folders over your project (same layout as your imports).
`npx tsx scripts/smoke.ts` runs 400 offline checks (no keys, no network).

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

---

# v4 — clinical intelligence & Algerian market adaptation

| Pillar | What it does | Where |
|---|---|---|
| **Layering matrix** | `check_compatibility` extended: vitamin C × copper peptides (avoid together), niacinamide × AHA (honest *soft* caution — fine for most people, separate only for sensitive/beginner skin), plus a **sandwich/buffering tip** whenever strong actives are involved. Works on the user's own cabinet: actives are read from their words, so products not in the catalog ("ذا أورديناري") are fine. | `ingredientKnowledge.ts`, `tools/checkCompatibility.ts` |
| **Algerian smart-dupe engine** | New `find_actives_dupe`: reference fingerprint (built-in table of well-known imports, caller-supplied actives, or the catalog product's own INCI) → local candidates ranked by shared actives, filtered cheaper than the user's quoted price, savings computed from it, country filter with honest relaxation, avoid-list as a hard filter. Reports `missingActives`; **never claims concentrations**. | `tools/findActivesDupe.ts`, `references.ts` |
| **Bioclimatic awareness** | City/region detection (ar/fr/en/Darija, ~50 places) → Saharan arid / coastal humid / highland / temperate Tell, with season (calendar or "في الصيف"). Injects a `[Context: Climate=…]` line (e.g. humectant-only hyaluronic in dry air → damp skin + sealing cream; no heavy occlusives on the humid coast; heat storage in summer). Stored in the profile (and in opt-in memory). | `climate.ts`, `agent.ts` |
| **Induction schedules** | New `generate_usage_schedule` for retinoids, AHA, BHA, benzoyl peroxide, azelaic acid, vitamin C: Week 1 → 4+ ramp by concentration and sensitivity (sensitive skin forces the gentle ramp), example nights, sandwich method, rules, stop-signs, pregnancy note for retinoids. Evaluating a product that contains a potent active **offers the calendar** (and a bare "نعم" delivers it). | `tools/generateUsageSchedule.ts`, `fastLane.ts` |
| **Shelf-label scan** | Chat accepts `images` (data URLs, `{data,mimeType,role}`, or allow-listed https). Vision OCR → catalog match → OilGuard verdict; if the product isn't in the catalog the INCI read from the photo is scored directly; unreadable photo → asks for the back label. Buy-verdict bands (≥80 excellent … <50 not recommended), allergen warnings, `label_scan` card. SSRF-guarded (only data: URLs or `SCAN_ALLOWED_HOSTS`, default `res.cloudinary.com`), size-capped; `bodyLimit` raised to 14 MB. | `scanLane.ts`, `tools/scanShelfLabel.ts`, `server.ts` |

## Important fix found while testing
The router gave a plain "evaluate X" a weight of 75, so confidence was never "high" and **the evaluation fast lane (the biggest speed win of the first upgrade) could not fire**. Weight is now 88 (still demoted to the LLM path when a competitor is within 20 points) and "حلل" is recognised as an evaluation verb. Regression tests added.

## Client changes (v4)
- Send `images: [{ data, mimeType, role: 'front' | 'inci' }]` (or data URLs) with the message to use scanning.
- New card types: `usage_schedule` ({schedule}), `label_scan` ({brand, name, category, quantity, ingredientCount, recognized}). Dupes arrive as `product_results` with `reference` and per-product `sharedActives`, `missingActives`, `matchRatio`, `priceSavingPct`.
- New env: `SCAN_ALLOWED_HOSTS` (comma-separated image hosts for https images).

## Please review
- `references.ts` fingerprints are **approximate** summaries of public formulas; extend/correct them for the imports your users actually ask about.
- The induction ramps and interaction wording are general skincare guidance — have a qualified person review before shipping.
- The scan lane makes ONE vision model call (the existing contribution parser); everything after it is deterministic.

---

# v5 — a friend who knows skincare

`npx tsx scripts/smoke.ts` (400 checks) · `npx tsx scripts/evals.ts` (29-case golden router set; add real anonymized cases to `scripts/evals/golden.jsonl`)

## Darija voice (no voice/audio)
- `voice.ts` detects language + register (Darija in Arabic script **and Arabizi**, MSA, FR, EN; sticky across short messages) and mood. Distressed users get calm, emoji-free replies with safety first.
- `darija.ts` is a **phrase table meant to be edited by a native speaker**; templates without an explicit `dz` string go through it (anything not in the table just stays MSA). The LLM path gets a `[Voice: …]` context line.
- ⚠️ Review the Darija wording — I'm not a native speaker and this is the part most worth polishing.

## Prices (your `{min, max, currency}` shape)
Ranges stay ranges. A saving is claimed against the **max** of the range (provable), budget math still uses the min. Products without a price are flagged `priceKnown:false`, counted (`unpricedCount`), never guessed; dupes with no price are returned separately as "same actives, no price on file".

## My cabinet (storage + REST for the frontend)
- Store: `data/cabinet.json` (atomic writes, 0600, userId hashed). **The userId is a bearer secret → use a long random UUID.**
- `GET /api/cabinet?userId=` · `POST /api/cabinet/items` · `PATCH /api/cabinet/items/:id` · `DELETE /api/cabinet/items/:id?userId=` · `DELETE /api/cabinet?userId=`
- Chat: add / list / "finished" / "didn't suit me" / remove (`manage_cabinet`). Duplicate-actives warnings, gap analysis (cleanser/moisturizer/sunscreen), value in use, "build around what I own" (`build_routine use_cabinet`), compatibility over the cabinet, owned products excluded from alternatives/dupes, near-copies of what **didn't suit you** skipped. Scan lane offers to add the product.

## Reaction triage & life stages
`triage_reaction`: red flags first (urgent care), irritation vs suspected allergy vs purge, likely culprits ranked from what the user actually uses (potency × recency × layering overload), stop-and-repair plan, back-off tied to the induction schedule, when to see a doctor. Never diagnoses, never sells. Pregnancy/breastfeeding auto-excludes retinoids + hydroquinone from every tool (session-only, never persisted); teen mode forces gentle ramps.

## Practical outputs (logic only — frontend later)
- Routine versions + undo/restore/compare (`routine_versions`; `GET /api/routine/versions`, `POST /api/routine/restore`).
- Shareable routine card + WhatsApp text (`POST /api/share/routine`), shopping list with owned items removed and honest unknown prices (`POST /api/share/shopping-list`), gift mode (gentle, fragrance-free, no potent actives).
- `quickReplies` on responses: tap-to-answer chips (skin type, budget, city, category, yes/no on offers, routine actions).

## Transparency & learning (on the existing embeddings)
- **"Why this?"** `explain_pick`: reasons from real data + caveats (brand claims ≠ proof, missing price/INCI) + a confidence level.
- **Bug fixed:** the nightly worker embedded learned facts with Google's model but retrieval queries with Cohere — different vector spaces, so learned facts could never match; learned entries also lacked `priority`, which made the retrieval sort unstable. Now: same Cohere model (`search_document`), `priority: 30`.
- **Learning policy** (`learning.ts`): LLM judge → embed → merge near-duplicates (+support, one vote per session) → auto-learn only if confident and risk-free; medical/safety/unsure → **human review queue**; 3 independent sessions promote low-risk facts. Retrieval labels them "COMMUNITY — reported by users" and ranks them below curated facts.
- Feedback: `POST /api/feedback {sessionId, messageId, rating, reason?, correction?}` (no message text stored; corrections are only *staged*). Responses now carry `messageId`.
- Contribute-to-catalog: scan lane offers to submit unknown products → moderated queue → approved ones go live in the catalog immediately (`communitySubmitted`).
- Admin (needs `ADMIN_TOKEN`, header `x-admin-token`): `GET /api/admin/review-queue`, `POST /api/admin/review/:id`, `GET /api/admin/contributions`, `POST /api/admin/contributions/:id`, `GET /api/admin/feedback-stats`.

## New response fields / card types for the frontend
`quickReplies[]`, `messageId`; cards: `cabinet`, `reaction_triage`, `routine_diff`, `share`, `shopping_list`, `gift_set`, `pick_explanation`. Request: `userId` (cabinet/long-term), `images`, `rememberMe`.

## New env
`ADMIN_TOKEN`, `CABINET_FILE`, `CABINET_SALT` (**set your own**), `FEEDBACK_FILE`, `CONTRIBUTIONS_FILE`, `APPROVED_CONTRIBUTIONS_FILE`, `REVIEW_QUEUE_FILE`, `GEMINI_JUDGE_MODEL`.

## Deliberately not built
Check-ins/pings, voice, selfie analysis (as agreed). The real Gemini judge and Cohere document embedder in `autonomous_worker.ts` are untested against live APIs (everything else in the pipeline is tested with injected fakes) — run the worker once manually and look at the review queue before trusting it.

---

# Auth integration (Firebase) — see AUTH.md
- `src/auth/*`: token verification (no service account), Firestore REST reader using the user's own token, compact RAM `UserContext` cache (LRU/SWR/single-flight/token-bound), agent-side overlay, Fastify plugin (identity, session scoping, rate limits, `/api/me/*`).
- The agent now knows the app profile (name, gender, language, skin/scalp type, goals, conditions, allergies), the shelf (`savedProducts`, with stored OilGuard scores) and routine sizes. The shelf replaces my JSON "cabinet" for signed-in users — every cabinet feature (duplicates, gaps, didn't-suit, compatibility, routine-from-shelf, shopping list, triage) runs on it.
- Evaluations send the app's RAW ids to `evaluate.js`, so agent scores equal in-app scores; products already on the shelf are answered from their stored analysis with no backend call.
- Tests: `npx tsx scripts/auth.test.ts` (84 checks) + `scripts/smoke.ts` (400) both pass.

### LLM tool-choice / empty-stream reliability (2026-10-15)
- Kept the LLM as the tool selector whenever deterministic routing is low-confidence; no new Darija-specific hard-coded tool routing was added.
- Corrected stream handling so a timed-out stream that ends normally is not mistaken for success.
- Bounded first useful output wait to 5 seconds by default, including single-key configurations, with one alternate-key retry by default.
- Added a visible retry state and a short Arabic fallback after bounded attempts; renamed `firstModelEvent` to `firstStreamEvent` for more accurate diagnostics.
- Configure with `AGENT_FIRST_TOKEN_TIMEOUT_MS` and `AGENT_EMPTY_STREAM_ATTEMPTS` if the deployment needs different bounds.

