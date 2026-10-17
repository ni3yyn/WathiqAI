# Wathiq AI — Routine modification upgrade

This upgrade extends `modify_routine` to edit an existing routine in place. It intentionally does not call `build_routine` for edits.

## Supported operations

- `swap`: replace one step by number or category; may require a cheaper product, an exact product ID/name, or a specific brand.
- `remove`: remove one step by number/category (the last remaining step cannot be removed).
- `add`: add a category such as toner, sunscreen, mask, eye cream, cleanser, serum, or moisturizer, within the routine budget.
- `refit`: adapt the routine to a new budget.
- `replace_all`: replace every step's product while retaining its category/order, respecting budget and avoid ingredients. `cheaper: true` requires every replacement to be strictly cheaper. `exclude_categories` preserves user-exempted categories; `preferred_brand` enforces a requested brand without silently falling back to another one.
- `batch`: apply 2–10 swaps/adds/removals as a single atomic change. It supports a different named replacement or preferred brand for each edit. If any operation fails, the existing routine is not committed partially.

The parser handles common Arabic, French, and English requests for whole-routine edits and multiple categories. For exact named-product changes or semantic constraints such as “replace everything except sunscreen”, the fast lane deliberately defers to the LLM to fill structured arguments instead of guessing. If a user specifies a brand without an exact SKU, `preferred_brand` is used and enforced; it can be set globally for `replace_all` or per edit in `batch`. The agent prompt and tool schema explain the distinction between `replace_all` and `batch`.

## Budget and reporting behavior

For `replace_all`, available budget headroom is shared among requested replacements so an expensive first choice does not use all the headroom and leave later requested products untouched. Any product that cannot be replaced under the constraints is kept as-is and reported. Batch output includes product-level before/after details and the resulting total.

## Updated source files

- `agent/tools/modifyRoutine.ts`
- `agent/intents.ts`
- `agent/taxonomy.ts`
- `agent/agent.ts`
- `agent/fastLane.ts`
- `agent/prompt.ts`
- `agent/statuses.ts` (status source used by the latest agent/fast-lane files)
- `agent/tools/searchProducts.ts` and `agent/tools/evaluateProduct.ts` (matching tool versions used by the latest agent/tool integrations)

`agent/agent.ts` and `agent/fastLane.ts` retain the latest versions available in this conversation before the routine-edit upgrade, including the session-key fallback change.

## Validation performed

- TypeScript syntax parsing passed for all six changed TypeScript files.
- Parser smoke cases covered Arabic, French/English, whole-routine replacements, exceptions, cheaper multi-category edits, multiple adds/removes, and named replacement deferral.
- Mocked tool smoke cases covered whole-routine replacement under a fixed budget, two named product swaps in one batch, multiple additions, requested category preservation, and atomic rollback after a failed batch operation.
- TypeScript syntax parsing passed for all changed files. A dependency-aware build could not be completed because the supplied source archive does not contain the package manifest/dependency installation (for example `ai`, `zod`, `dotenv`, and Node typings). The diagnostic pass also found two pre-existing type-narrowing diagnostics in `agent/tools/evaluateBrand.ts`, outside this routine-edit change. No semantic diagnostics were reported in the changed files once dependency/environment errors were excluded; the production build has not been run.
