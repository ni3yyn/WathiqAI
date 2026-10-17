# Wathiq `get_product` search and disambiguation upgrade

## What changed

- Supports human-style partial descriptions instead of expecting catalog IDs.
- Strips common Arabic/Darija, French, and English conversational words before ranking.
- Detects a product category mentioned in the same phrase and uses it as a ranking/filtering signal.
- Ranks brand/name/category evidence separately and avoids auto-selecting a product from a weak brand-only match.
- Returns up to five candidate cards when identity is ambiguous, including ingredient availability so the UI can communicate whether evaluation is possible.
- Provides Arabic clarification wording that asks the user to choose a candidate or copy the name from the packaging, never to supply an internal ID.
- Deduplicates identical `productName` and `query` inputs. This fixes exact-name lookups that previously became duplicated strings in the combined search query.
- Persists ambiguous candidates in both request state and session state so follow-ups such as “الثاني” / “the second one” can resolve against the correct shortlist.
- Updates tool descriptions and agent instructions to explicitly forbid arbitrary candidate selection and invented IDs.

## Expected behavior

| User wording | Expected behavior |
| --- | --- |
| `وش رايك فالواقي تع فينوس؟` | Find Venus products in the sunscreen category; if more than one fits, show the candidate cards and ask which one. |
| `قيملي anua waterleaf` | Search Anua products using the partial/possibly mistaken name; show likely Anua candidates rather than inventing an exact match. |
| Exact catalog ID | Keep the O(1) exact-ID lookup. |
| Exact product name | Resolve directly, including when `productName` and `query` contain the same text. |
| Unknown/weak query | Ask for the brand or name printed on the package, not the catalog ID. |

## Candidate response contract

Each candidate retains the existing card fields (`id`, `brand`, `name`, `category`, `price`, `image`, `claims`, etc.) and adds:

- `ingredientsAvailable`: whether the catalog has an ingredient list.
- `canEvaluate`: currently the same availability flag, so the UI can mark candidates that cannot be evaluated from the catalog data.

When the user selects a candidate, the client should send the selected product's internal `id` back to the agent as the explicit target. If the client only supports text follow-ups, the session also keeps the shortlist so ordinal references can be resolved. This source package contains the agent/backend, not the frontend card component; tap-to-select behavior must be verified in the client app.

## Validation performed

- Ran the changed `getProduct.ts` through the available TypeScript compiler; no syntax or type diagnostics were reported for `getProduct.ts` itself. A complete project build is not possible from this source-only ZIP because it does not include `package.json`, installed dependencies, or the original runtime environment.
- Executed a Node harness against a synthetic catalog fixture. Verified that the Darija Venus sunscreen query returns two sunscreen candidates (rather than picking one), `Anua waterleaf` returns Anua candidates for clarification, exact ID still resolves, and exact-name lookup still resolves when the same query is passed twice.
- No live catalog/backend evaluation was run in this environment.
