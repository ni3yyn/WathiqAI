import path from 'path';
import { Page } from 'playwright';
import dotenv from 'dotenv';
import {
    launchTikTokContext,
    closeTikTokContext,
    discoverReviewVideos,
    scrapeCommentsFromPage,
    saveRawCommentsBackup,
    diagnoseSessionIssue,
    randomDelay,
    RawComment,
    USER_DATA_DIR
} from './tiktok_auto_collector';
import { processTikTokComments, atomicReadJSON, atomicWriteJSON, REVIEWS_DB_FILE } from './tiktok_processor';
dotenv.config();

const CATALOG_FILE = path.join(process.cwd(), 'data', 'catalog.json');
const BATCH_STATE_FILE = path.join(process.cwd(), '.batch_state.json');
const REPORTS_DIR = path.join(process.cwd(), 'reports');

// How long to leave a product alone after it came back empty/failed, before
// it's eligible to be retried automatically on a future run.
const RETRY_COOLDOWN_MS = (parseFloat(process.env.BATCH_RETRY_COOLDOWN_HOURS || '') || 6) * 60 * 60 * 1000;

// How many empty/failed products in a row before we suspect the TikTok
// session itself is blocked (login wall, captcha, soft ban) rather than
// those products genuinely having no review content.
const SOFTBAN_STREAK_THRESHOLD = parseInt(process.env.BATCH_SOFTBAN_STREAK || '', 10) || 3;
const SOFTBAN_COOLDOWN_MS = (parseFloat(process.env.BATCH_SOFTBAN_COOLDOWN_MIN || '') || 5) * 60 * 1000;

// ─── CATALOG TYPES ────────────────────────────────────────────────────────────
interface CatalogCategory {
    id?: string;
    label?: string;
    icon?: string;
}

interface CatalogProduct {
    id: string;
    brand?: string;
    name?: string;
    country?: string;
    category?: CatalogCategory | string;
    quantity?: any;
    ingredients?: any;
    image?: string;
    marketingClaims?: string[];
    price?: any;
    targetTypes?: string[];
    [key: string]: any;
}

// ─── CLI OPTIONS ──────────────────────────────────────────────────────────────
interface CliOptions {
    limit?: number;
    from: number;
    category?: string;
    country?: string;
    force: boolean;
    forceOverwrite: boolean;
    headless: boolean;
    maxRuntimeMinutes?: number;
}

function parseArgs(argv: string[]): CliOptions {
    let opts: CliOptions = {
        from: 0,
        force: false,
        forceOverwrite: false,
        // Headless mode has no OS window at all, so it's immune to the whole
        // "what happens when I minimize it" problem. Default it from env so
        // it can be set once for unattended/background runs.
        headless: process.env.TIKTOK_HEADLESS === 'true'
    };

    // Two-pass: resolve --config=file.json first and use it as the base, so
    // any individual flag given on the command line afterward still wins
    // (the loop below runs after this and simply overwrites fields on `opts`).
    const configArg = argv.find(a => a.startsWith('--config='));
    if (configArg) {
        const configPath = path.resolve(configArg.split('=')[1]);
        const fileConfig = atomicReadJSON<Partial<CliOptions>>(configPath, {});
        opts = { ...opts, ...fileConfig };
        console.log(`[CONFIG] Loaded base options from ${configPath}`);
    }

    for (const arg of argv) {
        if (arg === '--force') {
            opts.force = true;
        } else if (arg === '--force-overwrite') {
            // Implies --force: there's no point re-harvesting a product just
            // to then refuse to overwrite it.
            opts.forceOverwrite = true;
            opts.force = true;
        } else if (arg === '--headless') {
            opts.headless = true;
        } else if (arg === '--headed') {
            opts.headless = false;
        } else if (arg === '--dz') {
            // Shorthand for --country=dz — the common case for this platform.
            opts.country = 'dz';
        } else if (arg.startsWith('--limit=')) {
            const val = parseInt(arg.split('=')[1], 10);
            if (!Number.isNaN(val) && val > 0) opts.limit = val;
        } else if (arg.startsWith('--from=')) {
            const val = parseInt(arg.split('=')[1], 10);
            if (!Number.isNaN(val) && val >= 0) opts.from = val;
        } else if (arg.startsWith('--category=')) {
            opts.category = arg.split('=')[1].trim().toLowerCase();
        } else if (arg.startsWith('--country=')) {
            opts.country = arg.split('=')[1].trim().toLowerCase();
        } else if (arg.startsWith('--max-runtime=')) {
            const val = parseFloat(arg.split('=')[1]);
            if (!Number.isNaN(val) && val > 0) opts.maxRuntimeMinutes = val;
        } else if (arg.startsWith('--config=')) {
            // Already consumed above — skip so it doesn't fall through.
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
    }

    return opts;
}

function printHelp(): void {
    console.log(`
Wathiq Batch Catalog Harvester

Usage:
  npx tsx src/batch_harvester.ts [options]

Options:
  --limit=N          Process at most N products in this run
  --from=INDEX       Start scanning the catalog from this index (0-based)
  --category=SLUG    Only process products whose category id/label matches SLUG
  --country=CODE     Only process products from this market: dz, fr, kr, us,
                      or a free-text match against the catalog's country field
                      (e.g. --country=algeria, --country=algérie also work)
  --dz               Shorthand for --country=dz
  --headless         Run with no visible window at all — immune to being
                      minimized/backgrounded, best for unattended/server runs
  --headed           Force a visible window (overrides TIKTOK_HEADLESS=true)
  --force            Re-harvest products even if already in reviews_db.json
                      (existing entry is kept unless it's worse, or unless
                      --force-overwrite is also given)
  --force-overwrite  Like --force, but always replaces the existing entry
                      even if the new harvest found less signal
  --max-runtime=MIN  Stop gracefully after MIN minutes, saving all progress
                      so far (a partial run is always safe to resume later)
  --config=FILE      Load base options from a JSON file (same field names as
                      above, e.g. {"country":"dz","category":"serum"}) —
                      flags given on the command line still override it
  --help, -h         Show this message

Automatic behavior (no flag needed):
  • Products that failed / found nothing recently are skipped for
    ${(RETRY_COOLDOWN_MS / 3_600_000).toFixed(1)}h (BATCH_RETRY_COOLDOWN_HOURS) before being retried automatically.
  • ${SOFTBAN_STREAK_THRESHOLD}+ empty/failed products in a row triggers a session-health pause
    (BATCH_SOFTBAN_STREAK / BATCH_SOFTBAN_COOLDOWN_MIN); if it persists after
    a retry, the run stops with a diagnostic instead of burning the catalog.
  • A JSON run report is written to reports/ after every product.

Notes:
  A visible (headed) window keeps working correctly even if you minimize it
  or switch away — Chrome is launched with background-throttling disabled
  and the page is told it's always visible/focused, so scrolling, video
  loading and comment fetching don't slow down. For a true "runs in the
  background with nothing on screen" setup, use --headless instead.

Examples:
  npx tsx src/batch_harvester.ts --dz --limit=20
  npx tsx src/batch_harvester.ts --country=dz --category=serum --force
  npx tsx src/batch_harvester.ts --dz --headless --max-runtime=120
  npx tsx src/batch_harvester.ts --config=configs/dz-nightly.json
`);
}

// ─── CATALOG / DB HELPERS ─────────────────────────────────────────────────────
function loadCatalog(): CatalogProduct[] {
    const catalog = atomicReadJSON<CatalogProduct[]>(CATALOG_FILE, []);
    if (!Array.isArray(catalog) || catalog.length === 0) {
        console.error(`❌ Could not load a non-empty catalog from ${CATALOG_FILE}`);
        console.error(`   Expected a JSON array of product objects (see data/catalog.json).`);
        process.exit(1);
    }
    return catalog;
}

function getCategoryId(p: CatalogProduct): string {
    if (!p.category) return '';
    if (typeof p.category === 'string') return p.category.toLowerCase();
    return `${p.category.id || ''} ${p.category.label || ''}`.toLowerCase().trim();
}

function getDisplayName(p: CatalogProduct): string {
    return `${p.brand || ''} ${p.name || ''}`.replace(/\s+/g, ' ').trim() || p.id;
}

function alreadyHarvested(productId: string): boolean {
    const reviewsDb = atomicReadJSON<Record<string, any>>(REVIEWS_DB_FILE, {});
    return Boolean(reviewsDb[productId]);
}

// ─── FINE-GRAINED RESUME STATE ─────────────────────────────────────────────────
// reviews_db.json only tells us about products that *succeeded*. Without this,
// a product that came back "no videos found" gets retried on every single run
// forever (wasting time), and a run that crashes mid-way has no memory of
// which not-yet-successful products it already tried this session.
type AttemptStatus = 'processed' | 'no_videos' | 'no_comments' | 'failed';

interface ProductAttemptState {
    status: AttemptStatus;
    timestamp: string;
    attempts: number;
}

function loadBatchState(): Record<string, ProductAttemptState> {
    return atomicReadJSON<Record<string, ProductAttemptState>>(BATCH_STATE_FILE, {});
}

function recordAttempt(productId: string, status: AttemptStatus): void {
    const state = loadBatchState();
    const prevAttempts = state[productId]?.attempts || 0;
    state[productId] = { status, timestamp: new Date().toISOString(), attempts: prevAttempts + 1 };
    atomicWriteJSON(BATCH_STATE_FILE, state);
}

function isOnRetryCooldown(productId: string): boolean {
    const entry = loadBatchState()[productId];
    if (!entry || entry.status === 'processed') return false;
    const age = Date.now() - new Date(entry.timestamp).getTime();
    return age < RETRY_COOLDOWN_MS;
}

// ─── COUNTRY / MARKET FILTERING ───────────────────────────────────────────────
// Catalog IDs already carry a market prefix ("DZ-CLE-BIO-001", "FR-...",
// "KR-...", "US-..." — see getProduct.ts's ID pattern). We match --country
// against that prefix first (cheap, exact), then fall back to a free-text
// match against the catalog's `country` field so "--country=algeria" or
// "--country=algérie" also work without the caller needing to know the code.
const COUNTRY_ALIASES: Record<string, string[]> = {
    dz: ['algeria', 'algérie', 'algerie', 'الجزائر'],
    fr: ['france', 'فرنسا'],
    kr: ['korea', 'south korea', 'corée', 'coree', 'كوريا'],
    us: ['united states', 'usa', 'america', 'أمريكا'],
};

export function isFromCountry(p: CatalogProduct, countryFilter: string): boolean {
    const filter = countryFilter.trim().toLowerCase();
    if (!filter) return true;

    const idPrefix = (p.id || '').split('-')[0].toLowerCase();
    if (idPrefix === filter) return true;

    const country = (p.country || '').toLowerCase();
    if (country === filter || country.includes(filter)) return true;

    const aliases = COUNTRY_ALIASES[filter];
    if (aliases && aliases.some(alias => country.includes(alias))) return true;

    return false;
}

export function isAlgerianProduct(p: CatalogProduct): boolean {
    return isFromCountry(p, 'dz');
}

// ─── BILINGUAL QUERY GENERATION ───────────────────────────────────────────────
// Catalog entries frequently mix Arabic and Latin script in a single field
// (e.g. "DERMASOUFRE غسول دارماسوفر"). We split the two scripts apart so we can
// build natural, high-intent search phrases in both Darija and French rather
// than searching the raw mixed-script blob verbatim.
export function buildProductQueries(p: CatalogProduct): string[] {
    const rawCombined = `${p.brand || ''} ${p.name || ''}`.replace(/\s+/g, ' ').trim();

    const arabicMatches = rawCombined.match(/[\u0600-\u06FF][\u0600-\u06FF\s]*/g);
    const latinMatches = rawCombined.match(/[A-Za-z][A-Za-z0-9'’\-\s]*/g);

    const arabicName = arabicMatches ? arabicMatches.join(' ').replace(/\s+/g, ' ').trim() : '';
    const latinName = latinMatches ? latinMatches.join(' ').replace(/\s+/g, ' ').trim() : '';

    const darijaSubject = arabicName || rawCombined;
    const frenchSubject = latinName || p.brand || rawCombined;

    const queries: string[] = [];
    if (darijaSubject) {
        queries.push(`وش رايكم في ${darijaSubject}`);
        queries.push(`رايي في ${darijaSubject}`);
    }
    if (frenchSubject) {
        queries.push(`avis ${frenchSubject}`);
        // For DZ-market products, imported brands (Garnier, Cerave, L'Oréal...)
        // also get reviewed heavily by French/Moroccan/Tunisian creators.
        // Anchoring the French query to "algerie" keeps results local.
        if (isAlgerianProduct(p)) {
            queries.push(`avis ${frenchSubject} algerie`);
        }
    }

    // De-dupe while preserving order.
    return Array.from(new Set(queries.filter(Boolean)));
}

// ─── RANDOM HELPERS ───────────────────────────────────────────────────────────
function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── FILTER / QUEUE BUILDING ──────────────────────────────────────────────────
function buildQueue(catalog: CatalogProduct[], opts: CliOptions): CatalogProduct[] {
    let list = catalog.slice(opts.from);

    if (opts.category) {
        list = list.filter(p => getCategoryId(p).includes(opts.category as string));
    }

    if (opts.country) {
        list = list.filter(p => isFromCountry(p, opts.country as string));
    }

    if (!opts.force) {
        list = list.filter(p => !alreadyHarvested(p.id));

        const beforeCooldown = list.length;
        list = list.filter(p => !isOnRetryCooldown(p.id));
        const skippedForCooldown = beforeCooldown - list.length;
        if (skippedForCooldown > 0) {
            console.log(`⏳ Skipping ${skippedForCooldown} product(s) that failed/found nothing recently (retry cooldown active — use --force to override).`);
        }
    }

    if (opts.limit) {
        list = list.slice(0, opts.limit);
    }

    return list;
}

// ─── PER-PRODUCT PIPELINE ─────────────────────────────────────────────────────
const VIDEOS_PER_PRODUCT = parseInt(process.env.BATCH_VIDEOS_PER_PRODUCT || '', 10) || 6;
const SCROLLS_PER_VIDEO = parseInt(process.env.BATCH_SCROLLS_PER_VIDEO || '', 10) || 8;

interface HarvestOutcome {
    status: AttemptStatus;
    videosScanned: number;
    rawComments: number;
}

async function harvestOneProduct(page: Page, product: CatalogProduct, opts: CliOptions): Promise<HarvestOutcome> {
    const productName = getDisplayName(product);
    const queries = buildProductQueries(product);

    console.log(`\n──────────────────────────────────────────────────────────`);
    console.log(`📦 ${productName} (${product.id})`);
    console.log(`🔎 Queries: ${queries.join(' | ')}`);

    try {
        const videoUrls = await discoverReviewVideos(page, productName, VIDEOS_PER_PRODUCT, queries);

        if (videoUrls.length === 0) {
            console.log(`⚠️ No review videos found for "${productName}".`);
            return { status: 'no_videos', videosScanned: 0, rawComments: 0 };
        }

        console.log(`🎬 Discovered ${videoUrls.length} candidate video(s).`);

        const allComments: RawComment[] = [];
        for (let i = 0; i < videoUrls.length; i++) {
            const comments = await scrapeCommentsFromPage(page, videoUrls[i], SCROLLS_PER_VIDEO);
            allComments.push(...comments);

            if (i < videoUrls.length - 1) {
                // Polite pacing between videos.
                await randomDelay(1000, 2000, '⏳ Pausing between videos');
            }
        }

        if (allComments.length === 0) {
            console.log(`⚠️ No comments collected for "${productName}".`);
            return { status: 'no_comments', videosScanned: videoUrls.length, rawComments: 0 };
        }

        // Disk safeguard: persist raw comments before spending any AI tokens.
        saveRawCommentsBackup(product.id, productName, allComments);

        const wrote = await processTikTokComments(
            product.id,
            productName,
            allComments,
            { videosScanned: videoUrls.length, totalRawComments: allComments.length },
            { overwritePolicy: opts.forceOverwrite ? 'always' : 'keep-best' }
        );

        return {
            status: wrote ? 'processed' : 'no_comments',
            videosScanned: videoUrls.length,
            rawComments: allComments.length
        };

    } catch (err: any) {
        console.error(`❌ Failed to harvest "${productName}" (${product.id}): ${err?.message || err}`);
        return { status: 'failed', videosScanned: 0, rawComments: 0 };
    }
}

// ─── JSON RUN REPORT ───────────────────────────────────────────────────────────
interface ReportEntry {
    productId: string;
    productName: string;
    status: AttemptStatus;
    videosScanned: number;
    rawComments: number;
    timestamp: string;
}

function writeReport(runId: string, entries: ReportEntry[], finished: boolean): void {
    const payload = {
        runId,
        startedAt: entries[0]?.timestamp ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finished,
        productCount: entries.length,
        entries
    };
    // "latest.json" is always the freshest run (survives a crash mid-run);
    // the timestamped file is kept as history once the run finishes.
    atomicWriteJSON(path.join(REPORTS_DIR, 'latest.json'), payload);
    if (finished) {
        atomicWriteJSON(path.join(REPORTS_DIR, `batch_${runId}.json`), payload);
    }
}

// ─── MASTER BATCH RUNNER ──────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const catalog = loadCatalog();
    const queue = buildQueue(catalog, opts);

    console.log(`\n=============================================================`);
    console.log(`🏭 WATHIQ BATCH CATALOG HARVESTER`);
    console.log(`📚 Catalog size: ${catalog.length} | Queue after filters: ${queue.length}`);
    console.log(`⚙️  from=${opts.from} limit=${opts.limit ?? 'none'} category=${opts.category ?? 'any'} country=${opts.country ?? 'any'} force=${opts.force} headless=${opts.headless}`);
    console.log(`=============================================================`);

    if (queue.length === 0) {
        console.log(`✅ Nothing to do — every matching product already has reviews (use --force to re-harvest).`);
        return;
    }

    let context = await launchTikTokContext({ headless: opts.headless });
    let page: Page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    let sinceRecycle = 0;
    let recycleThreshold = randomInt(5, 8);

    const stats = { processed: 0, no_videos: 0, no_comments: 0, failed: 0, skipped: 0 };
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const reportEntries: ReportEntry[] = [];

    const runStart = Date.now();
    const maxRuntimeMs = opts.maxRuntimeMinutes ? opts.maxRuntimeMinutes * 60_000 : null;

    // Session-health tracking: a run of empty/failed products in a row is
    // more likely a blocked/soft-banned session than N unrelated products all
    // genuinely having zero content — see diagnoseSessionIssue().
    let emptyStreak = 0;
    let softbanPauses = 0;

    let shuttingDown = false;
    let stopReason = '';
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n🛑 Received ${signal}, closing browser context gracefully...`);
        writeReport(runId, reportEntries, true);
        await closeTikTokContext(context);
        process.exit(0);
    };
    process.on('SIGINT', () => { shutdown('SIGINT'); });
    process.on('SIGTERM', () => { shutdown('SIGTERM'); });

    try {
        for (let i = 0; i < queue.length; i++) {
            if (shuttingDown) break;

            if (maxRuntimeMs && Date.now() - runStart >= maxRuntimeMs) {
                stopReason = `max runtime of ${opts.maxRuntimeMinutes} minute(s) reached`;
                console.log(`\n⏰ ${stopReason} — stopping gracefully after ${i}/${queue.length} products. All progress so far is saved; re-run to continue.`);
                break;
            }

            const product = queue[i];

            // Re-check idempotence right before processing — the DB file may
            // have been updated by another run since the queue was built.
            if (!opts.force && alreadyHarvested(product.id)) {
                console.log(`\n⏭️  Skipping "${getDisplayName(product)}" (${product.id}) — already harvested.`);
                stats.skipped++;
                continue;
            }

            console.log(`\n[${i + 1}/${queue.length}] ─────────────────────────────`);
            const outcome = await harvestOneProduct(page, product, opts);
            stats[outcome.status]++;
            recordAttempt(product.id, outcome.status);

            reportEntries.push({
                productId: product.id,
                productName: getDisplayName(product),
                status: outcome.status,
                videosScanned: outcome.videosScanned,
                rawComments: outcome.rawComments,
                timestamp: new Date().toISOString()
            });
            writeReport(runId, reportEntries, false);

            // ── SESSION HEALTH: detect a likely login-wall/captcha/soft-ban ──
            if (outcome.status === 'no_videos' || outcome.status === 'no_comments' || outcome.status === 'failed') {
                emptyStreak++;
            } else {
                emptyStreak = 0;
            }

            if (emptyStreak >= SOFTBAN_STREAK_THRESHOLD) {
                const diagnosis = await diagnoseSessionIssue(page);
                softbanPauses++;
                console.warn(`\n🚧 ${emptyStreak} empty/failed products in a row — possible session issue: ${diagnosis}.`);

                if (softbanPauses > 2) {
                    stopReason = `session still looks unhealthy after ${softbanPauses - 1} cool-down pause(s) (${diagnosis})`;
                    console.error(`❌ ${stopReason}. Stopping the batch — check the profile in ${USER_DATA_DIR} with a headed run (--headed), resolve any login/captcha wall manually, then re-run (already-processed products are skipped automatically).`);
                    break;
                }

                console.warn(`⏳ Pausing ~${(SOFTBAN_COOLDOWN_MS / 60_000).toFixed(1)} min before retrying, in case this is a temporary rate limit...`);
                await randomDelay(SOFTBAN_COOLDOWN_MS, SOFTBAN_COOLDOWN_MS + 30_000);
                emptyStreak = 0; // give it a clean slate after the cool-down
            }

            sinceRecycle++;

            // ── MEMORY MANAGEMENT: recycle the browser context every 5–8 products ──
            if (sinceRecycle >= recycleThreshold && i < queue.length - 1) {
                console.log(`\n♻️  Recycling browser context after ${sinceRecycle} products (memory management)...`);
                await closeTikTokContext(context);
                context = await launchTikTokContext({ headless: opts.headless });
                page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
                sinceRecycle = 0;
                recycleThreshold = randomInt(5, 8);
            }

            // ── POLITE RATE LIMITING: pause between products ──
            if (i < queue.length - 1 && !shuttingDown) {
                await randomDelay(10000, 15000, '⏳ Pausing between products');
            }
        }
    } finally {
        if (!shuttingDown) {
            writeReport(runId, reportEntries, true);
            await closeTikTokContext(context);
        }
    }

    console.log(`\n=============================================================`);
    console.log(`🎉 BATCH RUN COMPLETE${stopReason ? ` (stopped early: ${stopReason})` : ''}`);
    console.log(`✅ Processed:    ${stats.processed}`);
    console.log(`⏭️  Skipped:      ${stats.skipped}`);
    console.log(`🕳️  No videos:    ${stats.no_videos}`);
    console.log(`💬 No comments:  ${stats.no_comments}`);
    console.log(`❌ Failed:       ${stats.failed}`);
    console.log(`📄 Report:       reports/batch_${runId}.json`);
    console.log(`=============================================================\n`);
}

if (require.main === module) {
    main().catch(err => {
        console.error(`\n❌ Fatal batch harvester error:`, err);
        process.exit(1);
    });
}