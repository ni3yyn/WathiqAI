/*
 * Wathiq UI orchestrator
 * 1) Mount reusable HTML fragments into their layout slots.
 * 2) Load classic scripts in original dependency order.
 * 3) Load Firebase/auth last; optional SDK imports run in the background.
 */
(async function startWathiq() {
  const root = document.getElementById('app-root');
  const componentFiles = {
    iconSprite: 'components/icon-sprite/icon-sprite.html',
    imageModal: 'components/image-modal/image-modal.html',
    appShell: 'components/app-shell/app-shell.html',
    header: 'components/header/header.html',
    auth: 'components/auth/auth.html',
    shelf: 'components/shelf/shelf.html',
    chatMain: 'components/chat-main/chat-main.html',
    chatPrompts: 'components/chat-prompts/chat-prompts.html',
    chatMessages: 'components/chat-messages/chat-messages.html',
    scrollFab: 'components/scroll-fab/scroll-fab.html',
    chatComposer: 'components/chat-composer/chat-composer.html'
  };

  // The UI and the agent API are intentionally served by the same Fastify
  // origin. Keep these paths relative so Firebase auth and SSE share the session.
  window.WATHIQ_AGENT = window.WATHIQ_AGENT || {
    chatEndpoint: '/api/chat',
    healthEndpoint: '/health'
  };

  async function getText(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, { cache: 'no-cache', signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to load ${path} (${response.status})`);
      return await response.text(); // Keep the deadline active while reading the body.
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Timed out loading ${path} after 10s`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function setSlot(selector, html) {
    const slot = document.querySelector(selector);
    if (!slot) throw new Error(`Missing component slot: ${selector}`);
    slot.innerHTML = html;
  }

  function loadScript(path, type = 'classic') {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => {
        script.remove();
        reject(new Error(`Timed out loading script ${path} after 10s`));
      }, 10000);
      // Bump this release marker so browsers don't keep old component JS after deployment.
      const versionedPath = `${path}${path.includes('?') ? '&' : '?'}v=6.5.1`;
      script.src = versionedPath;
      if (type === 'module') script.type = 'module';
      else script.async = false;
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error(`Failed to load script ${path}`)); };
      document.body.appendChild(script);
    });
  }

  try {
    // Bootstrap components must exist before code that captures their elements runs.
    const [icons, imageModal, appShell] = await Promise.all([
      getText(componentFiles.iconSprite),
      getText(componentFiles.imageModal),
      getText(componentFiles.appShell)
    ]);
    root.innerHTML = icons + imageModal + appShell;

    const primaryComponents = [
      ['#headerSlot', componentFiles.header],
      ['#authSlot', componentFiles.auth],
      ['#shelfSlot', componentFiles.shelf],
      ['#chatMainSlot', componentFiles.chatMain]
    ];
    const primaryHtml = await Promise.all(primaryComponents.map(([, path]) => getText(path)));
    primaryComponents.forEach(([selector], index) => setSlot(selector, primaryHtml[index]));

    const chatComponents = [
      ['#chatPromptsSlot', componentFiles.chatPrompts],
      ['#chatMessagesSlot', componentFiles.chatMessages],
      ['#scrollFabSlot', componentFiles.scrollFab],
      ['#chatComposerSlot', componentFiles.chatComposer]
    ];
    const chatHtml = await Promise.all(chatComponents.map(([, path]) => getText(path)));
    chatComponents.forEach(([selector], index) => setSlot(selector, chatHtml[index]));

    // Classic scripts deliberately retain shared global function behavior for legacy handlers.
    const scripts = [
      ['components/app-shell/app-shell.js', 'classic'],
      ['components/icon-sprite/icon-sprite.js', 'classic'],
      ['components/header/header.js', 'classic'],
      ['components/shelf/shelf.js', 'classic'],
      ['assets/js/modules/state.js', 'classic'],
      ['components/scroll-fab/scroll-fab.js', 'classic'],
      ['components/image-modal/image-modal.js', 'classic'],
      ['assets/js/modules/accordion.js', 'classic'],
      ['assets/js/modules/voice-input.js', 'classic'],
      ['assets/js/modules/engine-switch.js', 'classic'],
      ['assets/js/modules/text-formatting.js', 'classic'],
      ['components/chat-main/chat-main.js', 'classic'],
      ['assets/js/modules/reveal-animation.js', 'classic'],
      ['components/chat-messages/chat-messages.js', 'classic'],
      ['components/result-cards/result-cards.js', 'classic'],
      ['components/brand-review/brand-review.js', 'classic'],
      ['components/routine-cards/routine-cards.js', 'classic'],
      ['components/community-reviews/community-reviews.js', 'classic'],
      ['components/comparison-card/comparison-card.js', 'classic'],
      ['components/ingredient-check/ingredient-check.js', 'classic'],
      ['components/brand-reviews/brand-reviews.js', 'classic'],
      ['components/analysis-cards/analysis-cards.js', 'classic'],
      ['components/product-cards/product-cards.js', 'classic'],
      ['components/chat-prompts/chat-prompts.js', 'classic'],
      ['components/chat-composer/chat-interactions.js', 'classic'],
      ['components/chat-composer/chat-submit.js', 'classic'],
      ['components/chat-composer/chat-composer.js', 'classic'],
      ['components/auth/auth.js', 'module']
    ];

    for (const [path, type] of scripts) await loadScript(path, type);
    root.dataset.state = 'ready';
  } catch (error) {
    console.error('[Wathiq] Component initialization failed:', error);
    root.innerHTML = `
      <main class="initial-error" role="alert" dir="rtl">
        <h1>تعذّر تحميل واجهة وثيق</h1>
        <p>تأكد من تشغيل المشروع عبر خادم HTTP، وأن ملفات المكونات موجودة في المسارات الصحيحة.</p>
        <code dir="ltr"></code>
        <button type="button" id="retryAppBtn">إعادة المحاولة</button>
      </main>`;
    root.querySelector('code').textContent = error.message;
    root.querySelector('#retryAppBtn').addEventListener('click', () => window.location.reload());
  }
})();
