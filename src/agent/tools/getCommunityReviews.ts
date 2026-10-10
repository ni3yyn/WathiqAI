import fs from 'fs';
import path from 'path';
import { norm } from './getProduct';
import { getProducts } from '../../wathiq/backendClient';

export interface GetCommunityReviewsArgs {
    productId?: string | null;
    productName?: string | null;
    /**
     * Brand scope ("what do people think of Venus products in general?",
     * "واش راي الناس في منتجات فينوس كاملة؟"). Aggregates every review we
     * hold for that brand's products instead of failing with "no single
     * product specified".
     */
    brandName?: string | null;
}

export interface CommunityReviewData {
    productName?: string;
    satisfactionRate?: number | string;
    summary?: string;
    [key: string]: any;
}

export type CommunityReviewsResult =
    | { found: true; reviewData: CommunityReviewData }
    | { found: true; brandData: BrandReviewAggregate }
    | { found: false; message: string };

export interface BrandReviewAggregate {
    brand: string;
    productsWithReviews: number;
    averageSatisfaction: number | null;
    perProduct: Array<{ productId: string; productName?: string; satisfactionRate?: number | string; summary?: string }>;
    summary: string;
}

function parseSatisfaction(v: number | string | undefined): number | null {
    if (typeof v === 'number' && !isNaN(v)) return v;
    if (typeof v === 'string') {
        const n = parseFloat(v.replace(/[^0-9.]/g, ''));
        if (!isNaN(n)) return n;
    }
    return null;
}

/**
 * Brand-scope aggregation: joins the reviews DB against the catalog on
 * product ID (with the same fuzzy-ID tolerance as single lookups), then
 * averages satisfaction across every reviewed product of the brand.
 */
async function aggregateBrandReviews(
    brandName: string,
    reviewsDb: Record<string, CommunityReviewData>
): Promise<CommunityReviewsResult> {
    const products = await getProducts();
    const target = norm(brandName);
    if (!target) return { found: false, message: 'لم أتمكن من تحديد الماركة المطلوبة.' };

    const brandProducts = products.filter((p: any) => {
        const b = norm(p.brand || '');
        return b && (b === target || b.includes(target) || target.includes(b));
    });
    if (brandProducts.length === 0) {
        return { found: false, message: `لم يتم العثور على منتجات لماركة "${brandName}" في الكتالوج الحالي.` };
    }

    const cleanId = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const perProduct: BrandReviewAggregate['perProduct'] = [];
    const seen = new Set<string>();

    for (const p of brandProducts) {
        let entry = reviewsDb[p.id];
        if (!entry) {
            const c = cleanId(p.id);
            for (const key of Object.keys(reviewsDb)) {
                const ck = cleanId(key);
                if (ck.includes(c) || c.includes(ck)) { entry = reviewsDb[key]; break; }
            }
        }
        if (entry && !seen.has(p.id)) {
            seen.add(p.id);
            perProduct.push({
                productId: p.id,
                productName: entry.productName || p.name,
                satisfactionRate: entry.satisfactionRate,
                summary: entry.summary,
            });
        }
    }

    if (perProduct.length === 0) {
        return {
            found: false,
            message: `لدينا ${brandProducts.length} منتج لهذه الماركة في الكتالوج، لكن لم نجمع بعد تجارب مستخدمين لأي منها.`,
        };
    }

    const sats = perProduct.map(x => parseSatisfaction(x.satisfactionRate)).filter((n): n is number => n !== null);
    const avg = sats.length ? Math.round((sats.reduce((a, b) => a + b, 0) / sats.length) * 10) / 10 : null;

    const resolvedBrand = brandProducts[0]?.brand || brandName;
    return {
        found: true,
        brandData: {
            brand: resolvedBrand,
            productsWithReviews: perProduct.length,
            averageSatisfaction: avg,
            perProduct,
            summary: `تجارب المجتمع لمنتجات ${resolvedBrand} (${perProduct.length} منتج بتجارب موثقة${avg !== null ? `، متوسط الرضا ${avg}%` : ''}).`,
        },
    };
}

// ─── REVIEWS DB CACHE (mtime-keyed) ──────────────────────────────────────────
// The old implementation sat inline in agent.ts and did a SYNCHRONOUS
// readFileSync + JSON.parse of reviews_db.json on EVERY tool call. The file
// only changes when new reviews are ingested, so we cache the parsed DB and
// re-read only when the file's mtime changes.
let cachedDb: Record<string, CommunityReviewData> | null = null;
let cachedDbMtime = -1;
let cachedDbPath: string | null = null;

function resolveDbPath(): string {
    const candidates = [
        path.join(process.cwd(), 'src', 'reviews_db.json'),
        path.join(process.cwd(), 'reviews_db.json'),
        path.join(__dirname, '..', 'reviews_db.json'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[0];
}

function loadReviewsDb(): Record<string, CommunityReviewData> | null {
    try {
        const dbPath = resolveDbPath();
        if (!fs.existsSync(dbPath)) return null;
        const mtime = fs.statSync(dbPath).mtimeMs;
        if (cachedDb && cachedDbPath === dbPath && cachedDbMtime === mtime) {
            return cachedDb;
        }
        cachedDb = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        cachedDbMtime = mtime;
        cachedDbPath = dbPath;
        console.log(`[REVIEWS] Loaded ${Object.keys(cachedDb!).length} review entries from ${dbPath}`);
        return cachedDb;
    } catch (e: any) {
        console.warn(`[REVIEWS] Failed to load reviews DB: ${e.message}`);
        return cachedDb; // serve stale cache if we have one
    }
}

/**
 * Pure lookup logic — session fallbacks (last discussed product) stay in the
 * agent.ts wrapper, this function only resolves what it is explicitly given.
 */
export async function getCommunityReviews(args: GetCommunityReviewsArgs): Promise<CommunityReviewsResult> {
    const { productId, productName, brandName } = args;

    const reviewsDb = loadReviewsDb();
    if (!reviewsDb) {
        return { found: false, message: 'قاعدة بيانات التجارب غير متوفرة حالياً.' };
    }

    // ── 0. STRATEGY 0: BRAND-SCOPE AGGREGATION ──
    if (brandName && !productId && !productName) {
        return aggregateBrandReviews(brandName, reviewsDb);
    }
    // ── 1. STRATEGY A: EXACT ID LOOKUP ──
    let reviewData: CommunityReviewData | null = productId ? reviewsDb[productId] : null;

    // ── 2. STRATEGY B: FUZZY ID LOOKUP (Handles BIO vs BIOL typos) ──
    if (!reviewData && productId) {
        const cleanTarget = productId.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
        for (const key of Object.keys(reviewsDb)) {
            const cleanKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
            if (cleanKey.includes(cleanTarget) || cleanTarget.includes(cleanKey)) {
                console.log(`[REVIEWS] 🎯 Matched via fuzzy ID: ${productId} -> ${key}`);
                reviewData = reviewsDb[key];
                break;
            }
        }
    }

    // ── 3. STRATEGY C: PRODUCT NAME FALLBACK LOOKUP ──
    if (!reviewData && productName) {
        const normTarget = norm(productName);
        for (const key of Object.keys(reviewsDb)) {
            const entryName = norm(reviewsDb[key].productName || '');
            if (entryName && (entryName.includes(normTarget) || normTarget.includes(entryName))) {
                console.log(`[REVIEWS] 🎯 Matched via product name: "${productName}" -> ${reviewsDb[key].productName}`);
                reviewData = reviewsDb[key];
                break;
            }
        }
    }

    if (!reviewData) {
        console.log(`[REVIEWS] ❌ No reviews found for ID: ${productId} or Name: ${productName}`);
        return {
            found: false,
            message: 'لم نجمع بعد عدداً كافياً من تجارب المستخدمين لهذا المنتج في منصات التواصل.'
        };
    }

    return { found: true, reviewData };
}
