# Wathiq Agent v6.3.1 — image picker UI patch

## Fix
The v6.3 image-input existed but was visually represented by a small icon and relied on inline HTML event handlers. This patch makes the image action explicit and binds the file picker through JavaScript after the composer fragment mounts.

## Changes
- Added a labelled **إرفاق صورة** button and explicit supported file types (JPG, PNG, WebP).
- Removed inline `onclick` / `onchange` from the picker flow; events are attached after the dynamic composer is mounted.
- Selected images now show a visible preview section with thumbnail, filename, role selector, remove action, and attachment count.
- Added a fallback decoder using `Image` + object URL when `createImageBitmap` is missing or fails.
- Added a source-file size limit of 20 MB and user-facing format / size errors. Images are resized to max 1600 px and re-encoded to JPEG before chat submission.
- The “upload ingredient photo” action from a product card marks the next attachment as an INCI/back-label image.
- Added `v=6.3.1` cache busting for dynamic component scripts, the composer stylesheet, and the orchestrator script.
- `/health` now reports version `6.3.1`.

## Verification
Static JavaScript syntax checks and ZIP integrity checks are included in this patch workflow. A live browser test against production credentials/backend still needs to be run in the deployed environment.
