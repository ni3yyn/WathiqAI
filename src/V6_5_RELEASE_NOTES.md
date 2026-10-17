# Wathiq Agent v6.5.0 — Score explanation + personal match

## Problem
The Wathiq scoring backend (logic in `logic(1).js`) already returns `scoreBreakdown` and `personalMatch`, but the chat tool response removed those fields and the product analysis card displayed only total/safety/efficacy scores, claims, and ingredient lists. Users could see a number without seeing the backend-authored reasons.

## Changes

### Agent / tool contract
- `evaluate_product` includes the backend `scoreBreakdown` and `personalMatch` alongside the existing score fields.
- The fast-lane narration path can quote one relevant score factor directly from those fields, preferring `override`, `deduction`, and `warning` entries and otherwise a positive `good`/`info` entry.
- A `danger`/`warning` personal-match reason is surfaced only if the backend returned actual reason text.
- Fast-lane evidence includes the structured notes so any narration fallback has the same source data.
- Prompt rules explicitly prohibit the model from inventing score causes, hidden weights, or personal warnings.

### UI
- Analysis cards now have **“لماذا حصل المنتج على هذه الدرجة؟”**, showing up to four key factors with their backend note type and value.
- Remaining records, including calculation rows, are accessible under “عرض بقية تفاصيل الدرجة”.
- A separate **“ماذا تعني النتيجة لحالتك؟”** section shows the backend's personal-match status and messages. If the backend returned no messages, the UI says so rather than inventing a personalized claim.
- All backend note text/value content is escaped before rendering; no score is recalculated on the client.
- Added responsive styles and cache busting for the JS/CSS changes.

## Files changed
- `agent/tools/evaluateProduct.ts` is unchanged in its backend contract builder because it already extracts these fields into `assistantEvidence`; the consuming tool response in `agent/agent.ts` now exposes them.
- `agent/agent.ts`
- `agent/fastLane.ts`
- `agent/prompt.ts`
- `public/components/analysis-cards/analysis-cards.js`
- `public/components/analysis-cards/analysis-cards.css`
- `public/assets/js/orchestrator.js`
- `public/index.html`, `public/app.html`
- `server.ts`, `VERSION.txt`, `README.md`

## Validation
Local syntax checks, contract fixtures, renderer fixture checks, archive integrity, and asset-path/version checks are run at packaging time. A live test against the production Wathiq evaluation API still requires the user's runtime configuration and catalog.
