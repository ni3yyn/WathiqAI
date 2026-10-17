# Wathiq — Modular UI

This folder is a component-oriented refactor of the monolithic chat page. The Fastify server serves `app.html` at `/`; `assets/js/orchestrator.js` mounts reusable HTML fragments and then loads behavior modules in dependency order. Component assets are served from this same folder by the agent server.

## Run locally

Because component templates are fetched at runtime, do not open `index.html` directly with `file://`.

Run the agent server from the repository root so the API and modular UI share the same origin:

```text
npm run dev
```

Then open <http://localhost:3001/> (or the configured `PORT`). Do not use a static file server: chat, Firebase-authenticated API requests, and relative component fetches must be served from the same origin.

## Structure

```text
app.html                         Entry point / resource list
assets/
  css/                           Global, motion, responsive and engine styles
  js/
    orchestrator.js              Mounts templates and loads scripts in order
    tailwind-config.js           Original Tailwind theme tokens
    modules/                     Shared state and cross-component utilities
components/
  app-shell/                     Root layout and component slots
  icon-sprite/                   Reusable SVG symbol sprite
  header/                        Brand header and reset action
  auth/                          Authentication dialog + Firebase module
  shelf/                         Shelf dialog and shelf-specific styling
  image-modal/                   Product lightbox
  chat-main/                     Chat layout host and main sizing CSS
  chat-prompts/                  Prompt examples
  chat-messages/                 Message area and response renderer
  scroll-fab/                    Smart scroll-to-bottom control
  chat-composer/                 Text/photo/voice composer and submit flow
  result-cards/                  New result card types
  brand-review/                  Brand audit report
  routine-cards/                 Routine builder/result renderer
  community-reviews/              Community feedback rendering
  comparison-card/               Product comparison renderer
  ingredient-check/              INCI ingredient check renderer
  brand-reviews/                 Brand-level community summaries
  analysis-cards/                Product analysis card
  product-cards/                 Product grid/result cards and product styles
```

## How to redesign safely

- Change structure in the component's `.html` file.
- Change visual styling in that component's `.css` file; keep cross-cutting typography/reset rules in `assets/css/base.css`.
- Change component interactions in its `.js` file.
- Add new HTML fragments to `componentFiles` in `assets/js/orchestrator.js`, mount them into a named slot, then add its JS path to the ordered script list.
- The classic behavior scripts intentionally load sequentially because the original card renderers share global functions and state. The Firebase/auth script loads last as a module because it uses dynamic `import()` with top-level `await`.

## Notes

- This is a structural refactor, not a redesign. The original colors and layout intent were retained. Static UI is split into HTML/CSS/JS component folders. Data-driven cards still assemble conditional markup in their dedicated JS renderers because each response has a different shape; shared styles and card-specific style hooks are now separate CSS files.
- External dependencies (Tailwind CDN, Marked CDN, Google Fonts, Firebase CDN) still require internet access.
- The existing Firebase web config values are carried over from the provided file; review them before public deployment and make sure any sensitive server credentials are never placed in frontend code.


## Premium visual layer

`assets/css/premium-redesign.css` is loaded last by both entry points. It keeps the original sage/forest palette, improves the responsive chat layout and card surfaces, restores intentional borders and keyboard focus states, and owns the complete user-message bubble styling. User-message structure lives in `components/chat-messages/chat-messages.js`; its visual design stays in CSS.


## Product lookup UI and error-handling upgrade

The latest UI also includes larger responsive product selection cards, explicit selection/evaluation actions, support for candidate products without INCI data (via photo upload), and visible retry handling for failed or incomplete requests. See `UI_UPGRADE_NOTES.md` for the behavior contract and validation details.
