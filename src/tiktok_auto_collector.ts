import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import dotenv from 'dotenv';
import { processTikTokComments, atomicWriteJSON, atomicReadJSON, dedupeComments } from './tiktok_processor';
dotenv.config();

export const USER_DATA_DIR = path.join(process.cwd(), '.tiktok_profile');

export interface RawComment {
    cid: string;
    author: string;
    text: string;
    likes: number;
    timestamp: number;
}

export interface LaunchOptions {
    headless?: boolean;
}

// ─── TAB LABEL CONFIGURATION ──────────────────────────────────────────────────
// TikTok's video page has two tabs next to each other: "Commentaires"
// (Comments) and "Tu pourrais aimer" (You might like / For You) — a
// recommendation feed, not comments. Which one is selected by default can
// vary (account, locale, A/B test), so instead of hardcoding one data-e2e id
// we match on the visible tab text — and it's exposed via .env so it can be
// fixed without touching code if TikTok changes the wording or you see it in
// a different language.
function parseLabelList(envVal: string | undefined, fallback: string[]): string[] {
    if (!envVal) return fallback;
    return envVal.split(',').map(s => s.trim()).filter(Boolean);
}

function labelsToRegex(labels: string[]): RegExp {
    const escaped = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(escaped.join('|'), 'i');
}

const COMMENT_TAB_LABELS = parseLabelList(process.env.TIKTOK_COMMENT_TAB_LABELS, ['Commentaires', 'Comments', 'تعليقات']);
const RECOMMEND_TAB_LABELS = parseLabelList(process.env.TIKTOK_RECOMMEND_TAB_LABELS, ['Tu pourrais aimer', 'You may like', 'You might like', 'For You', 'قد يعجبك']);
const COMMENT_TAB_REGEX = labelsToRegex(COMMENT_TAB_LABELS);
const RECOMMEND_TAB_REGEX = labelsToRegex(RECOMMEND_TAB_LABELS);

// How many scroll iterations between "are we actually still on the Comments
// tab?" checks during a video's comment harvest.
const TAB_WATCHDOG_INTERVAL = parseInt(process.env.TIKTOK_TAB_WATCHDOG_INTERVAL || '', 10) || 2;

// Set to "false" to disable the in-page MutationObserver that auto-dismisses
// overlays the instant they appear (see launchTikTokContext below).
const AUTO_DISMISS_MODALS = process.env.TIKTOK_AUTO_DISMISS_MODALS !== 'false';

// ─── 1. BROWSER LIFECYCLE (REUSABLE ACROSS A BATCH RUN) ──────────────────────
// When the OS window is minimized (or just loses focus), Chrome normally
// "backgrounds" the tab: it throttles JS timers, pauses video buffering, and
// tells the page (via the Page Visibility API) that it's hidden — which makes
// TikTok itself slow or stop its own comment/video lazy-loading. The launch
// args below tell Chromium not to do any of that, and the init script below
// makes sure the page's own JS always *believes* it's focused and visible,
// regardless of what the actual OS window is doing. Together this lets the
// harvester keep working correctly while minimized or in the background.
export async function launchTikTokContext(opts: LaunchOptions = {}): Promise<BrowserContext> {
    const headless = opts.headless ?? (process.env.TIKTOK_HEADLESS === 'true');
    console.log(`[BROWSER] 🚀 Launching persistent context (profile: ${USER_DATA_DIR}, headless: ${headless})...`);

    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1440,900',
            // Stop Chrome from throttling/backgrounding a minimized or
            // unfocused window — keeps timers, scrolling and video/comment
            // buffering running at full speed regardless of window state.
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling'
        ],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'fr-FR',
    });

    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        (window as any).chrome = { runtime: {} };

        // Make the page's own JS believe it is always visible and focused,
        // even while the real OS window is minimized or in the background.
        // Without this, TikTok's Page Visibility listeners pause video
        // playback and slow down its own comment-list fetching.
        Object.defineProperty(document, 'hidden', { get: () => false });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
        document.hasFocus = () => true;

        const swallow = (e: Event) => { e.stopImmediatePropagation(); };
        document.addEventListener('visibilitychange', swallow, true);
        window.addEventListener('blur', swallow, true);
        document.addEventListener('blur', swallow, true);
        window.addEventListener('pagehide', swallow, true);
    });

    if (AUTO_DISMISS_MODALS) {
        // Runs continuously inside every page, independent of our Node-side
        // scroll loop — so a login wall, cookie banner, "continue as guest"
        // prompt, or any other overlay that pops up *between* our checks
        // (mid-scroll, mid-wait) gets closed the instant it's added to the
        // DOM, instead of sitting there blocking clicks/scrolls until the
        // next time our own polling happens to run.
        await context.addInitScript(() => {
            const CLOSE_BUTTON_SELECTORS = [
                '[data-e2e="modal-close-inner-button"]',
                '[data-e2e="close-icon"]',
                'button[aria-label="Fermer"]',
                'button[aria-label="Close"]',
            ];
            const CLOSE_BUTTON_TEXT = /^(continuer en tant qu.invit[ée]|refuser|plus tard|not now|skip|accept all|tout accepter)$/i;
            const OVERLAY_SELECTOR = 'div[role="dialog"], [data-e2e="login-modal"], .tiktok-modal__modal-container, [class*="DivMask"], [class*="Overlay"], [class*="Backdrop"]';

            function tryDismiss(root: ParentNode): boolean {
                for (const sel of CLOSE_BUTTON_SELECTORS) {
                    const btn = root.querySelector ? root.querySelector<HTMLElement>(sel) : null;
                    if (btn) { btn.click(); return true; }
                }
                const buttons = root.querySelectorAll ? Array.from(root.querySelectorAll<HTMLElement>('button')) : [];
                const textBtn = buttons.find(b => CLOSE_BUTTON_TEXT.test((b.textContent || '').trim()));
                if (textBtn) { textBtn.click(); return true; }

                const overlay = (root as Element).matches?.(OVERLAY_SELECTOR)
                    ? (root as Element)
                    : (root.querySelector ? root.querySelector(OVERLAY_SELECTOR) : null);
                if (overlay) {
                    overlay.remove();
                    document.body.style.overflow = 'auto';
                    document.documentElement.style.overflow = 'auto';
                    return true;
                }
                return false;
            }

            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    m.addedNodes.forEach((node) => {
                        if (node.nodeType !== 1) return;
                        tryDismiss(node as Element);
                    });
                }
            });

            const start = () => observer.observe(document.body, { childList: true, subtree: true });
            if (document.body) start();
            else document.addEventListener('DOMContentLoaded', start);
        });
    }

    return context;
}

export async function closeTikTokContext(context: BrowserContext): Promise<void> {
    try {
        await context.close();
        console.log(`[BROWSER] 🧹 Context closed, memory released.`);
    } catch (e: any) {
        console.warn(`[BROWSER] Warning while closing context: ${e.message}`);
    }
}

// ─── 2. JITTERED DELAY HELPER (POLITE RATE LIMITING) ─────────────────────────
export function randomDelay(minMs: number, maxMs: number, label?: string): Promise<void> {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    if (label) console.log(`${label} (${(ms / 1000).toFixed(1)}s)...`);
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 3. CLICK DEBUGGER WITH ELEMENT TELEMETRY ────────────────────────────────
async function debugClick(page: Page, selector: string, description: string): Promise<boolean> {
    try {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
            const tag = await el.evaluate(e => e.tagName.toLowerCase());
            const text = await el.evaluate(e => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 35));
            const dataE2e = await el.evaluate(e => e.getAttribute('data-e2e') || 'none');
            const href = await el.evaluate(e => (e as any).href || 'none');

            console.log(`[DEBUG CLICK] 👉 ${description}`);
            console.log(`              ↳ <${tag} data-e2e="${dataE2e}" href="${href}"> "${text}"`);

            await el.click({ timeout: 2500, force: true });
            await page.waitForTimeout(1000);
            return true;
        }
    } catch (e: any) { /* element not interactable — fall through */ }
    return false;
}

// ─── 4. MODAL DESTROYER (CLOSES OR NUKES OVERLAYS DIRECTLY FROM DOM) ─────────
async function nukeModals(page: Page): Promise<void> {
    const closeButtons = [
        '[data-e2e="modal-close-inner-button"]',
        '[data-e2e="close-icon"]',
        'button[aria-label="Fermer"]',
        'button[aria-label="Close"]',
        'button:has-text("Continuer en tant qu\'invité")',
        'button:has-text("Refuser")',
        'button:has-text("Plus tard")'
    ];

    for (const sel of closeButtons) {
        const clicked = await debugClick(page, sel, 'Closing overlay modal');
        if (clicked) return;
    }

    await page.evaluate(() => {
        const overlays = document.querySelectorAll(
            'div[role="dialog"], [data-e2e="login-modal"], .tiktok-modal__modal-container, [class*="DivMask"], [class*="Overlay"], [class*="Backdrop"]'
        );
        if (overlays.length > 0) {
            overlays.forEach(el => el.remove());
            document.body.style.overflow = 'auto';
            document.documentElement.style.overflow = 'auto';
        }
    }).catch(() => {});
}

// ─── 5. SEARCH ENGINE FALLBACK ───────────────────────────────────────────────
async function findVideosViaSearchEngine(page: Page, query: string, maxVideos: number): Promise<string[]> {
    console.log(`[FALLBACK] 🌐 Searching Bing for: "${query}"...`);
    const searchUrl = `https://www.bing.com/search?q=site:tiktok.com+${encodeURIComponent(query)}`;

    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2000);

        const links = await page.$$eval('a[href*="tiktok.com/@"]', (anchors) => {
            const set = new Set<string>();
            for (const a of anchors) {
                const href = (a as HTMLAnchorElement).href;
                if (/tiktok\.com\/@[^/]+\/video\/\d+/.test(href)) {
                    set.add(href.split('?')[0]);
                }
            }
            return Array.from(set);
        });

        return links.slice(0, maxVideos);
    } catch (e: any) {
        return [];
    }
}

// ─── 6. NATURAL HUMAN SEARCH (AVOIDS BOT GATES) ───────────────────────────────
export async function searchTikTokVideos(page: Page, searchQuery: string, maxVideos = 6): Promise<string[]> {
    console.log(`[DISCOVERY] 🔍 Searching TikTok VIDEOS for: "${searchQuery}"...`);
    const discoveredUrls = new Set<string>();

    try {
        console.log(`[DISCOVERY] 🌐 Loading TikTok homepage and establishing session tokens...`);
        await page.goto('https://www.tiktok.com/explore', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {
            console.log(`[DISCOVERY] Network idle timeout passed, continuing...`);
        });

        await page.waitForTimeout(3000);
        await nukeModals(page);

        console.log(`[DISCOVERY] ⌨️ Locating search bar and typing query like a human...`);
        const searchInput = await page.$('input[type="search"], input[name="q"], [data-e2e="search-user-input"]');

        if (searchInput && await searchInput.isVisible()) {
            await searchInput.click();
            await page.waitForTimeout(500);
            await searchInput.fill('');
            await searchInput.type(searchQuery, { delay: 70 });
            await page.waitForTimeout(800);
            await page.keyboard.press('Enter');
            console.log(`[DISCOVERY] 🚀 Pressed Enter, waiting for search results to render...`);
            await page.waitForTimeout(5000);
        } else {
            console.log(`[DISCOVERY] Search bar not interactable, navigating via URL...`);
            await page.goto(`https://www.tiktok.com/search/video?q=${encodeURIComponent(searchQuery)}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
            await page.waitForTimeout(4000);
        }

        await nukeModals(page);

        try {
            const videoTab = await page.$('div[role="tab"]:has-text("Vidéos"), div[role="tab"]:has-text("Videos")');
            if (videoTab && await videoTab.isVisible()) {
                await videoTab.click();
                await page.waitForTimeout(2000);
            }
        } catch (e) { /* tab not present, ignore */ }

        const hasError = await page.$('text="Une erreur est survenue"') ||
                         await page.$('text="Something went wrong"') ||
                         await page.$('button:has-text("Réessayer")');

        if (hasError) {
            console.log(`[DISCOVERY] ⚠️ Direct search was blocked by anti-bot. Using search engine fallback...`);
            return await findVideosViaSearchEngine(page, searchQuery, maxVideos);
        }

        const extractLinks = async () => {
            const domLinks = await page.$$eval('a[href*="/video/"]', (anchors) => {
                const urls: string[] = [];
                for (const a of anchors) {
                    const href = (a as HTMLAnchorElement).href;
                    if (/tiktok\.com\/@[^/]+\/video\/\d+/.test(href)) {
                        urls.push(href.split('?')[0]);
                    }
                }
                return urls;
            });
            domLinks.forEach(url => discoveredUrls.add(url));
        };

        await extractLinks();

        for (let s = 0; s < 3 && discoveredUrls.size < maxVideos; s++) {
            await page.mouse.wheel(0, 1000);
            await page.waitForTimeout(2500);
            await extractLinks();
        }

    } catch (err: any) {
        console.warn(`[DISCOVERY] Search encountered an issue: ${err.message}. Running fallback...`);
        return await findVideosViaSearchEngine(page, searchQuery, maxVideos);
    }

    let finalUrls = Array.from(discoveredUrls).slice(0, maxVideos);

    if (finalUrls.length === 0) {
        console.log(`[DISCOVERY] No videos in DOM. Running search engine fallback...`);
        finalUrls = await findVideosViaSearchEngine(page, searchQuery, maxVideos);
    }

    return finalUrls;
}

// ─── 7. DISCOVER REVIEW VIDEOS ACROSS ONE OR MORE QUERIES ────────────────────
// Accepts an optional list of pre-built (bilingual) queries — falls back to the
// default Darija dual-query pattern when none are supplied.
export async function discoverReviewVideos(
    page: Page,
    baseKeywords: string,
    targetVideoCount = 8,
    customQueries?: string[]
): Promise<string[]> {
    const queries = customQueries && customQueries.length > 0
        ? customQueries
        : [`وش رايكم في ${baseKeywords}`, `رايي في ${baseKeywords}`];

    let videoUrls: string[] = [];

    for (const query of queries) {
        if (videoUrls.length >= targetVideoCount) break;
        const remaining = targetVideoCount - videoUrls.length;
        const found = await searchTikTokVideos(page, query, remaining);
        videoUrls = Array.from(new Set([...videoUrls, ...found]));
    }

    return videoUrls.slice(0, targetVideoCount);
}

// ─── 8. COMMENT TAB ACTIVATION (WITH DRIFT DETECTION) ────────────────────────
// TikTok shows two tabs side by side: "Commentaires" and "Tu pourrais aimer"
// (a recommendation feed, not comments — see the screenshot of the bug this
// fixes). Whichever one loads selected isn't guaranteed, and clicking isn't
// enough to prove it worked — TikTok's SPA can silently ignore a click that
// doesn't hit exactly the right internal element. So every click here is
// followed by an actual check for comment-panel content, and we explicitly
// never click anything matching the "you might like" label — only the
// "Commentaires" one, even if both happen to share a selector.
async function isCommentPanelActive(page: Page): Promise<boolean> {
    // 1. Check if comment items OR the comment typing input bar is visible!
    // (The input bar is ALWAYS visible when the comment tab is active, even with 0 comments!)
    const markers = await page.$$([
        '[data-e2e="comment-list"]',
        '[data-e2e="comment-level-1"]',
        '[data-e2e="comment-input"]',
        'div[contenteditable="true"]',
        'div[data-e2e="comment-avatar-1"]'
    ].join(', '));

    for (const m of markers) {
        if (await m.isVisible().catch(() => false)) return true;
    }

    // 2. Check for empty state text ("Soyez le premier à commenter" / "Be the first to comment")
    const emptyNotice = await page.$('text=/Soyez le premier|Be the first|كن أول من يعلق/i');
    if (emptyNotice && await emptyNotice.isVisible().catch(() => false)) return true;

    return false;
}


async function clickCommentTab(page: Page): Promise<boolean> {
    // 1. PLAYWRIGHT EXACT SELECTOR (Targeting the exact HTML you provided)
    try {
        // Target: <span class="tux-web-canary H4-Semibold" data-testid="tux-web-text">Commentaires</span>
        const exactTuxSpan = page.locator('span[data-testid="tux-web-text"].tux-web-canary').filter({ hasText: COMMENT_TAB_REGEX }).first();
        
        if (await exactTuxSpan.isVisible({ timeout: 2000 })) {
            console.log(`[SCRAPER] 🎯 Found exact Tux Span: <span class="tux-web-canary...">. Clicking...`);
            
            // A. Click the span itself
            await exactTuxSpan.click({ force: true });
            await page.waitForTimeout(500);
            
            // B. Click its immediate parent (TikTok usually puts the onClick event on the wrapper tab)
            const parentTab = exactTuxSpan.locator('xpath=..');
            if (await parentTab.isVisible()) {
                await parentTab.click({ force: true }).catch(() => {});
            }

            await page.waitForTimeout(1000);
            return true;
        }
    } catch (e) { /* fall through to DOM strategy */ }

    // 2. DOM BRUTE FORCE (Directly querying your snippet inside the browser)
    try {
        const clicked = await page.evaluate(({ commentPattern }) => {
            const commentRe = new RegExp(commentPattern, 'i');
            
            // Find the exact span
            const spans = Array.from(document.querySelectorAll('span[data-testid="tux-web-text"]'));
            const targetSpan = spans.find(s => commentRe.test((s.textContent || '').trim()));

            if (targetSpan) {
                // Fire a massive wave of click events on the span and its parent
                const events = ['pointerdown', 'pointerup', 'click'];
                events.forEach(type => targetSpan.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
                
                const parent = targetSpan.closest('[role="tab"]') || targetSpan.parentElement;
                if (parent) {
                    events.forEach(type => parent.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
                }
                
                return targetSpan.textContent;
            }
            return null;
        }, { commentPattern: COMMENT_TAB_REGEX.source });

        if (clicked) {
            console.log(`[SCRAPER] 🎯 DOM Bruteforce clicked the Tux Span: "${clicked.trim()}"`);
            return true;
        }
    } catch (e) { /* fall through */ }

    // 3. FALLBACK: Action Bar Icon (The speech bubble on the right of the video)
    const fallbackIcons = ['button[data-e2e="comment-icon"]', 'button[data-e2e="browse-comment-icon"]'];
    for (const sel of fallbackIcons) {
        if (await debugClick(page, sel, 'Clicking action bar comment icon')) return true;
    }

    return false;
}

async function ensureCommentTabActive(page: Page): Promise<boolean> {
    if (await isCommentPanelActive(page)) {
        console.log(`[SCRAPER] 💬 Comment panel is already active.`);
        return true;
    }

    console.log(`[SCRAPER] 📑 Comment panel not active (likely on "${RECOMMEND_TAB_LABELS[0]}" or similar) — clicking "${COMMENT_TAB_LABELS[0]}"...`);

    for (let attempt = 1; attempt <= 3; attempt++) {
        const clicked = await clickCommentTab(page);
        await page.waitForTimeout(1200);

        if (await isCommentPanelActive(page)) {
            console.log(`[SCRAPER] ✅ Comment panel confirmed active (attempt ${attempt}).`);
            return true;
        }

        if (!clicked) {
            console.log(`[SCRAPER] ⚠️ Attempt ${attempt}/3: couldn't find a clickable "${COMMENT_TAB_LABELS[0]}" tab element.`);
        } else {
            console.log(`[SCRAPER] ⚠️ Attempt ${attempt}/3: clicked but comment panel still not confirmed — retrying...`);
        }
        await page.waitForTimeout(800);
    }

    console.log(`[SCRAPER] ⚠️ Could not confirm the comment tab after 3 attempts — proceeding anyway (results may be sparse). Set TIKTOK_COMMENT_TAB_LABELS in .env if TikTok is showing a label we don't recognize.`);
    return false;
}

// ─── 9. COMMENT HARVESTER (WITH TAB ACTIVATION & NAVIGATION LOCK) ────────────
export async function scrapeCommentsFromPage(page: Page, videoUrl: string, maxScrolls = 8): Promise<RawComment[]> {
    console.log(`\n[SCRAPER] 🎬 Loading video: ${videoUrl}`);
    const collected = new Map<string, RawComment>();
    let isZeroCommentsConfirmed = false;

    const videoIdMatch = videoUrl.match(/\/video\/(\d+)/);
    const targetVideoId = videoIdMatch ? videoIdMatch[1] : '';

    const navigationGuard = (frame: any) => {
        if (frame === page.mainFrame()) {
            const newUrl = frame.url();
            if (targetVideoId && !newUrl.includes(targetVideoId) && newUrl.includes('/video/')) {
                console.log(`[NAVIGATION GUARD] 🛑 Blocked redirection to related video.`);
                page.goto(videoUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
            }
        }
    };
    page.on('framenavigated', navigationGuard);

    const responseHandler = async (response: any) => {
        if (response.url().includes('/api/comment/list/')) {
            try {
                const data = await response.json();
                
                // ── INSTANT ZERO COMMENT BAILOUT ──
                if (data && (data.total === 0 || (Array.isArray(data.comments) && data.comments.length === 0 && collected.size === 0))) {
                    isZeroCommentsConfirmed = true;
                    console.log(`[SCRAPER] ℹ️ API confirmed video has 0 comments.`);
                    return;
                }

                if (data && Array.isArray(data.comments)) {
                    console.log(`[SCRAPER] 🎯 Intercepted ${data.comments.length} comments from API.`);
                    data.comments.forEach((c: any) => {
                        if (c.text && !collected.has(c.cid)) {
                            collected.set(c.cid, {
                                cid: c.cid,
                                author: `@${c.user?.unique_id || c.user?.nickname || 'user'}`,
                                text: c.text,
                                likes: c.digg_count || 0,
                                timestamp: c.create_time || Date.now()
                            });
                        }
                    });
                }
            } catch (e) {}
        }
    };
    page.on('response', responseHandler);

    try {
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(2500);
        await nukeModals(page);

        // ── CHECK 1: FAST UI ZERO-COMMENT CHECK ──
        const isZeroInUi = await page.evaluate(() => {
            const count = document.querySelector('span[data-e2e="comment-count"]')?.textContent?.trim();
            const emptyNotice = /Soyez le premier|Be the first|كن أول من يعلق/i.test(document.body.innerText);
            return count === '0' || emptyNotice;
        }).catch(() => false);

        if (isZeroInUi) {
            console.log(`[SCRAPER] ⏭️ Fast UI check confirmed 0 comments. Skipping video immediately!`);
            return [];
        }

        // Activate tab if not open
        await ensureCommentTabActive(page);

        // Position mouse over comments column
        const commentContainer = await page.$('[data-e2e="comment-list"]');
        if (commentContainer) {
            await commentContainer.hover().catch(() => {});
        } else {
            await page.mouse.move(1100, 450);
        }

        // Scroll loop
        for (let i = 0; i < maxScrolls; i++) {
            // BAIL OUT IF API CONFIRMED 0 COMMENTS
            if (isZeroCommentsConfirmed) {
                console.log(`[SCRAPER] ⏭️ Zero comments confirmed mid-scroll. Skipping remainder of video.`);
                break;
            }

            if (i > 0 && i % TAB_WATCHDOG_INTERVAL === 0) {
                await nukeModals(page);
                if (!(await isCommentPanelActive(page))) {
                    console.log(`[SCRAPER] 🔄 Drifted off tab (iteration ${i}) — re-activating...`);
                    await ensureCommentTabActive(page);
                }
            }

            await page.evaluate(() => {
                const list = document.querySelector('[data-e2e="comment-list"]') || 
                             document.querySelector('.comment-container') ||
                             document.querySelector('div[class*="DivCommentListContainer"]');
                if (list) list.scrollTop += 1200;
            });

            await page.mouse.wheel(0, 900);
            await page.waitForTimeout(1500);
        }

    } catch (e: any) {
        console.warn(`[SCRAPER] Warning loading video: ${e.message}`);
    } finally {
        page.off('response', responseHandler);
        page.off('framenavigated', navigationGuard);
    }

    const comments = Array.from(collected.values());
    console.log(`[SCRAPER] ✅ Successfully extracted ${comments.length} comments from this video.`);
    return comments;
}

// ─── 10. DISK SAFEGUARD — PERSIST RAW COMMENTS BEFORE AI SYNTHESIS ───────────
export function saveRawCommentsBackup(productId: string, productName: string, comments: RawComment[]): string {
    const backupFile = path.join(process.cwd(), 'src', `raw_scraped_${productId}.json`);
    const existing = atomicReadJSON<any>(backupFile, { comments: [] });
    const existingComments: any[] = Array.isArray(existing.comments) ? existing.comments : [];

    // Text-normalized dedup catches the same comment resurfacing under a
    // reposted video or a pinned comment shared across several review videos
    // — a plain cid/text-key check (used per-video during scraping) misses
    // those because TikTok assigns each repost a fresh cid.
    const merged = dedupeComments([...existingComments, ...comments]);

    atomicWriteJSON(backupFile, {
        productId,
        productName,
        harvestDate: new Date().toISOString(),
        comments: merged
    });

    const droppedDupes = existingComments.length + comments.length - merged.length;
    console.log(`[SCRAPER] 💾 Raw backup safeguarded: ${merged.length} total comments in ${path.basename(backupFile)}${droppedDupes > 0 ? ` (${droppedDupes} duplicate(s) collapsed)` : ''}`);
    return backupFile;
}

// ─── SESSION HEALTH DIAGNOSTIC ────────────────────────────────────────────────
// Not used to change scraping behavior directly — this is a cheap, best-effort
// read of the current page so that when the batch worker notices a suspicious
// streak of empty results, it can log *why* instead of just "no videos found"
// N times in a row (login wall vs. captcha/verify vs. generic network issue).
export async function diagnoseSessionIssue(page: Page): Promise<string> {
    try {
        const url = page.url();
        if (/\/login|passport\.tiktok/i.test(url)) return 'redirected to login page';
        if (/captcha|verify/i.test(url)) return 'redirected to a captcha/verification challenge';

        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
        if (/log ?in|se connecter|sign in|تسجيل الدخول/i.test(bodyText) && /continue|guest|invité|متابعة/i.test(bodyText)) {
            return 'a login/guest wall is present on the page';
        }
        if (/captcha|verify you.?re human|puzzle|glissez/i.test(bodyText)) {
            return 'a captcha/human-verification challenge is present';
        }
        if (/erreur|something went wrong|une erreur est survenue/i.test(bodyText)) {
            return 'TikTok returned a generic error page';
        }
        return 'no obvious block detected — may just be low content for this query';
    } catch (e: any) {
        return `could not inspect page (${e.message})`;
    }
}

// ─── 11. MASTER AUTONOMOUS HARVESTER (SINGLE PRODUCT, STANDALONE USE) ────────
export async function autoHarvestProduct(
    productId: string,
    productName: string,
    baseKeywords: string,
    targetVideoCount = 8
): Promise<void> {
    console.log(`\n============================================================`);
    console.log(`🤖 Starting High-Yield Autonomous TikTok Harvester`);
    console.log(`📦 Product: ${productName} (${productId})`);
    console.log(`🎯 Target Keywords: "${baseKeywords}"`);
    console.log(`📁 Profile: Persisting session in ${USER_DATA_DIR}`);
    console.log(`============================================================`);

    const context = await launchTikTokContext();
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    const allComments: RawComment[] = [];

    try {
        const videoUrls = await discoverReviewVideos(page, baseKeywords, targetVideoCount);

        console.log(`\n🎬 Total Discovered Review Videos: ${videoUrls.length}`);
        videoUrls.forEach((u, i) => console.log(`   ${i + 1}. ${u}`));

        if (videoUrls.length === 0) {
            console.log(`⚠️ No review videos found.`);
            return;
        }

        for (let i = 0; i < videoUrls.length; i++) {
            const comments = await scrapeCommentsFromPage(page, videoUrls[i], 8);
            allComments.push(...comments);
            if (i < videoUrls.length - 1) {
                await randomDelay(1000, 2000, '[SCRAPER] ⏳ Pausing between videos');
            }
        }

        console.log(`\n🎉 Total Raw Comments Harvested: ${allComments.length}`);

        if (allComments.length === 0) {
            console.log(`⚠️ No comments gathered.`);
            return;
        }

        saveRawCommentsBackup(productId, productName, allComments);

        await processTikTokComments(productId, productName, allComments, {
            videosScanned: videoUrls.length,
            totalRawComments: allComments.length
        });

    } catch (err: any) {
        console.error(`[AUTO-HARVEST] Pipeline error:`, err);
    } finally {
        await closeTikTokContext(context);
    }
}

// ─── 12. STANDALONE MANUAL RUN (npx tsx src/tiktok_auto_collector.ts) ────────
async function run() {
    await autoHarvestProduct(
        "DZ-CLE-BIO-001",
        "Biolila Cleansing Gel",
        "غسول بيوليلا",
        8
    );
}

if (require.main === module) {
    run();
}