# Wathiq Agent v6.3 — image search recovery

**Release date:** 2026-10-17

## Main fix: image search was rejected before vision ran

The UI was sending attached photos as `{ base64, mimeType }`, while the backend image normalizer expected `{ data, mimeType }`. Valid photos were therefore rejected before the model received an image. The backend now accepts the exact current UI shape, along with older payload shapes.

## Image-search behavior

1. The user attaches a front-label photo, or a front photo plus the back INCI label.
2. The browser compresses the images and submits them through the existing chat endpoint. Photo-only messages are supported and a failed request can be retried with its images.
3. The backend validates the image, decodes inline base64 into image buffers, and passes the image with the correct MIME type to Gemini.
4. Gemini reads visible brand, product name, category, and any actually readable INCI. It is instructed not to infer ingredients from a name or brand.
5. Wathiq searches the catalog using the extracted name. A single high-confidence match can be evaluated; ambiguous matches are shown as cards for user selection.
6. If no suitable catalog item exists, the deterministic ingredient checker can evaluate the photographed INCI only when at least two ingredients are read with medium/high confidence. An absent confidence value now fails closed as low.

This is an OCR/vision-assisted catalog search, **not an all-catalog visual-similarity embedding search**. It does not compare a submitted photo against every product image.

## Additional changes

- Supports one or two attached images; the user can label each as front/identity or INCI/back, including when attaching just the back label alone.
- More predictable image MIME/size validation and direct data-URL decoding; remote image URLs remain HTTPS allow-listed and redirects are rejected.
- Uses `gemini-3.8-flash` as the default vision model and `gemini-3.5-flash-lite` as the fallback. Override them with `GEMINI_VISION_MODEL` and `GEMINI_VISION_FALLBACK_MODEL`.
- Candidate selection and no-INCI handling stay aligned with the upgraded UI cards.
- `/health` returns `version: "6.3"` so deployment can be checked without reading source files.

## Test results

- 8 image payload normalization cases: current `base64` payload, front/back roles, full data URL, legacy `data`, invalid base64, unsupported MIME, untrusted HTTP/HTTPS URLs.
- 5 vision parser checks: current model default, one/two image buffer payload, correct MIME types, and structured result shape.
- 3 scan-lane checks: ambiguous candidates are displayed rather than auto-evaluated; low/missing INCI-read confidence is not scored; medium-confidence INCI can use the deterministic checker.
- 5 product lookup checks: Darija Venus sunscreen, partial Anua Waterleaf, typo-tolerant Venus, exact ID, and exact name.
- All UI JavaScript files passed `node --check`; eight touched TypeScript files passed syntax transpilation checks.

The above are targeted tests using local fixtures/mocks. They do not prove that a live Gemini API key, production catalog, or browser deployment is working. The archive lacks the existing project's dependency manifest and environment secrets, so a full build and live integration test must be run in the existing project after merging.

## Small agent features worth considering next

1. **Barcode-assisted lookup:** scan a barcode and use it only when the catalog has a matching barcode record; otherwise fall back to the photo/name path.
2. **OCR correction step:** show the extracted brand/name/INCI for quick user correction before scoring, especially when text is blurry.
3. **Post-result action chips:** “compare with another product”, “verify this claim”, and “check an ingredient” using the selected product already in context.
4. **Privacy-safe scan telemetry:** log model, latency, confidence level, candidate count, and failure class—but never log raw photos, base64, or full INCI unless explicitly needed and protected.

These are suggestions only; they are not included in v6.3.
