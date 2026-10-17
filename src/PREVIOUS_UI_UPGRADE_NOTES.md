# Wathiq UI upgrade notes

## Scope

This archive upgrades the modular public UI. This file documents the previously delivered UI-only stage. v6.3 combines that UI with backend image-search fixes; the root `README.md` is the installation guide for this overlay.

## What changed

### Product lookup and selection
- Product results now show a clear Arabic selection header and count.
- Compact horizontal tiles were replaced with larger responsive cards: three columns on wide desktops, two on mid-size screens, and one column on small mobile screens.
- Cards support long Arabic/Latin names, optional price/size/claims, missing-image fallbacks, and an accessible image-view button.
- Product actions use delegated click handling and data attributes, not inline JavaScript handlers.
- The product's internal catalog ID remains in the actual request, but the visible user message reads naturally (for example, `قيّم Venus SPF50 من Venus`).

### Missing INCI data
- If a product explicitly arrives with `canEvaluate: false` or `ingredientsAvailable: false`, its card does not trigger catalogue evaluation.
- The card offers `رفع صورة المكونات` and prepares a prompt so the user can attach the product's INCI photo through the existing composer.
- If older API responses omit these flags, the UI preserves the previous selection behavior rather than treating the flags as false.

### Errors and retry
- SSE `error` events now escape the JSON parsing handler instead of being swallowed as parse errors.
- A stream ending without a `finish` event is treated as an incomplete response; incomplete assistant output is removed and a readable error is shown.
- Network errors, authentication/permission failures, rate limits, oversized uploads, client errors, and server failures receive Arabic user-facing messages.
- A visible retry action resends the same request; if an image was attached, its payload is retained for the retry.

### General layout and accessibility
- Wider desktop conversation canvas and assistant response area.
- Increased message/product-card spacing and readable text sizes.
- Explicit button labels, keyboard focus states, reduced-motion support, responsive cards, and clearer error styling.
- Browser title updated to `وثيق — محلل المكونات والادعاءات`.

## Backend contract

When available, the product result object may include:

```js
{
  id: "catalog-product-id",
  name: "Product name",
  brand: "Brand name",
  canEvaluate: true,
  ingredientsAvailable: true
}
```

The `canEvaluate` and `ingredientsAvailable` flags should be booleans. The UI only blocks evaluation when either is explicitly `false`.

## Validation performed

- `node --check` passed for every JavaScript file in the UI bundle.
- Static links referenced by both `index.html` and `app.html` resolve to files in the bundle.
- A rendering/behavior harness verified result-card count, the selection instruction, exact-ID evaluation, natural visible text, the missing-INCI upload path, rejection of executable image URL schemes, escaped product text, price-range formatting, and the absence of inline click handlers.
- A live API-backed browser test was not run because this UI-only archive does not include the backend runtime/configuration. Complete the manual smoke test below after installing the UI in the running Wathiq project.

## Manual integration smoke test

1. Search for a product name that returns multiple candidates, then select a card. Confirm the selected ID is the one sent for evaluation and the visible user bubble does not show the internal ID.
2. Return a candidate with `ingredientsAvailable: false` or `canEvaluate: false`. Confirm the card offers image upload and does not run catalogue evaluation.
3. Trigger network loss or a server error. Confirm a readable error appears, the loading state ends, and `إعادة المحاولة` resends the request.
4. Repeat at desktop, tablet, and narrow mobile widths; confirm no horizontal page overflow and that product cards use three/two/one columns respectively.
