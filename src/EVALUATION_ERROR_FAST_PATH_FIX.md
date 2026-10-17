# Wathiq evaluation error fast-path fix

## Why the follow-up log showed the generic failure message

The new log differs from the earlier product-ID routing failure. In this run, the ID `DZ-SSE-PHAR-001` **was resolved correctly**, and the evaluation tool executed. It then returned a deterministic data-quality error: the product exists in the catalog, but its ingredient list is missing, so Wathiq cannot score its formula or verify its marketing claims.

The bug was in Fast Lane's result handling. The shared `run()` helper converted ordinary tool errors to `null`; the evaluation branch then required `oilGuardScore` to be numeric and broke out when it was not. That made a known result (“INCI is missing”) look like an unhandled Fast Lane failure, so the request fell through to the LLM. The LLM repeated the same evaluation, then synthesis/fallback failed because selected Gemini keys were rejected or stalled. The end user saw `تعذّر على وثيق إكمال الرد هذه المرة. حاول مجددًا بعد قليل.` after about 22.6 seconds.

## Fixes in this package

- The evaluation Fast Lane can preserve structured error results rather than discarding them as `null`.
- If the product has no INCI list, Wathiq responds directly in the user's language, says why no score was produced, and asks for a clear photo or the ingredient list.
- A minimal catalog product card is emitted so the user can see which product was identified.
- The result is marked `skipNarration`, so this data error does not trigger another Gemini call.
- If evaluation throws (e.g. backend timeout), Fast Lane returns a safe, localized error explanation rather than trying the same operation again through the LLM.
- Stale evaluation state from a previously evaluated product is cleared when the current product's evaluation fails, preventing the old score from being associated with the new product.
- Successful evaluations still use the existing Wathiq scoring backend and keep the card-first, optional narration path.

## Focused validation

- Runtime regression: missing-INCI result returns a direct response and emits a product card — passed.
- Runtime regression: no-INCI path calls the evaluator exactly once and sets `skipNarration` — passed.
- Runtime regression: stale prior score is cleared — passed.
- Runtime regression: thrown evaluator error returns a safe direct response and does not request narration — passed.
- TypeScript transpilation/syntax check of `agent/fastLane.ts` and `agent/agent.ts` — 0 syntax/transpile errors.

The previous 400-assertion offline suite passed against the preceding package; this final error-path patch was validated with the focused runtime regression above, not by rerunning the entire long suite. No real Gemini key or live API was used for this regression, and a full production build remains unverified because the supplied archive does not contain its original package manifest/dependencies.

## What this does not do

It does not invent ingredients, score a product with no known INCI, or make an invalid Gemini API key valid. To obtain a real evaluation for this product, add the correct ingredient list to the catalog or submit a clear image/text INCI list for processing. The important change is that missing source data is now reported immediately and honestly instead of causing a 20+ second model failure.
