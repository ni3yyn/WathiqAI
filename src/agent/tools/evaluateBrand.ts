import { getProducts, evaluateProduct as wathiqEvaluate } from '../../wathiq/backendClient';
import { normalizeProductType } from './evaluateProduct'; // export this from evaluateProduct.ts if not already
import { normalizeCategory } from '../taxonomy';

// Reuse getProduct.ts's REAL normalizer and fuzzy scorer instead of a
// simplified reimplementation — `norm()` strips diacritics/punctuation
// (needed for "L'Oréal" / "Bioderma" / accented Latin names, which is the
// common case, not the exception) and layers Arabic->Latin transliteration
// on top for the minority of users who type the brand in Arabic.
// Requires adding `export` to `norm` and `fuzzyScore` in getProduct.ts.
import { norm, fuzzyScore } from './getProduct';
import { getRepresentativePrice, resolvePriceBounds } from '../priceUtils';

const WATHIQ_BRAND_URL = process.env.WATHIQ_EVALUATE_BRAND_URL
    // Reverted to the correct, convention-matching casing now that the backend
    // file has been renamed to `evaluateBrand.js` in the repo. Only correct once
    // that rename is actually deployed (git push succeeded AND a curl POST to
    // this exact URL returns 400, not 404) — don't rely on this before that.
    || 'https://oilguard-backend.vercel.app/api/evaluateBrand.js';

export interface EvaluateBrandArgs {
    brandName: string;
    /**
     * Optional category focus for compound questions like
     * "what do you think of X brand? their sunscreen specifically" —
     * after the brand-level aggregation, every product of THIS category is
     * scored individually so the answer can name the best/worst sunscreen
     * (or cleanser, serum, ...) instead of hand-waving "the brand is fine".
     * Accepts any alias the taxonomy knows ("sunscreen", "واقي شمس", "spf",
     * "cleanser", "غسول", ...).
     */
    focusCategory?: string;
}

interface BrandMatch {
    products: any[];
    resolvedBrandName: string;
}

/**
 * Resolves a user-typed brand name (Latin, Arabic, accented, misspelled) to
 * the set of catalog products for that brand — mirroring getProduct.ts's own
 * exact -> substring -> fuzzy -> ambiguous strategy, so brand resolution
 * behaves the same way product resolution already does elsewhere in the app.
 */
function resolveBrandProducts(brandName: string, products: any[]):
    { found: true } & BrandMatch | { found: false; candidates?: string[] } {

    const target = norm(brandName);
    if (!target) return { found: false };

    // Distinct brand names in the catalog, normalized once.
    const brandIndex = new Map<string, string>(); // normalized -> original display name
    products.forEach((p: any) => {
        if (!p.brand) return;
        const n = norm(p.brand);
        if (!brandIndex.has(n)) brandIndex.set(n, p.brand);
    });

    // 1) Exact or substring match (handles "venus", "Venus", "VENUS Cosmetics")
    const substringHits = [...brandIndex.entries()].filter(
        ([n]) => n === target || n.includes(target) || target.includes(n)
    );

    if (substringHits.length === 1) {
        const [n, display] = substringHits[0];
        return { found: true, resolvedBrandName: display, products: products.filter((p: any) => norm(p.brand) === n) };
    }

    if (substringHits.length > 1) {
        // e.g. target "cera" matching both "CeraVe" and some unrelated "Ceramide Co"
        return { found: false, candidates: substringHits.map(([, display]) => display) };
    }

    // 2) Fuzzy fallback for typos ("loriel" -> "L'Oréal")
    const scored = [...brandIndex.entries()]
        .map(([n, display]) => ({ n, display, score: fuzzyScore(target, n) }))
        .filter(s => s.score > 0.5)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { found: false };

    const top = scored[0];
    const runnerUp = scored[1];
    const confident = top.score >= 0.7 && (!runnerUp || top.score >= runnerUp.score * 1.3);

    if (confident) {
        return { found: true, resolvedBrandName: top.display, products: products.filter((p: any) => norm(p.brand) === top.n) };
    }

    return { found: false, candidates: scored.slice(0, 4).map(s => s.display) };
}

export function parseIngredients(raw: any): string[] {
    if (typeof raw === 'string') {
        return raw.replace(/\.$/, '').split(',').map(s => s.trim()).filter(s => s.length > 1);
    }
    if (Array.isArray(raw)) return raw.map(String).filter(s => s.length > 1);
    return [];
}

/** True when a catalog product belongs to the (already canonicalized) category. */
function productMatchesCategory(p: any, canonicalCategory: string): boolean {
    const rawCatId = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
    const pCatNorm = normalizeCategory(rawCatId) || rawCatId;
    const a = pCatNorm.toLowerCase();
    const b = canonicalCategory.toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
}

/**
 * Scores every product of one category within the brand, individually,
 * through the same deterministic backend as single-product evaluation.
 * Capped at 4 products (each call is a backend round-trip); reported honestly
 * via productsInCategory vs productsScored.
 */
async function buildCategoryFocus(brandProducts: any[], canonicalCategory: string) {
    const inCategory = brandProducts.filter(p => productMatchesCategory(p, canonicalCategory));

    if (inCategory.length === 0) {
        return {
            category: canonicalCategory,
            productsInCategory: 0,
            productsScored: 0,
            note: `لا توجد منتجات من فئة "${canonicalCategory}" لهذه الماركة في الكتالوج الحالي.`,
        };
    }

    const MAX_FOCUS = 4;
    const toScore = inCategory
        .filter((p: any) => parseIngredients(p.ingredients).length > 0)
        .slice(0, MAX_FOCUS);

    const scored = await Promise.all(toScore.map(async (p: any) => {
        try {
            const evaluation: any = await wathiqEvaluate({
                ingredients_list: parseIngredients(p.ingredients),
                user_profile: { allergies: [], conditions: [] },
                selected_claims: [],
                product_type: normalizeProductType(p.category),
            });
            return {
                id: p.id,
                name: p.name,
                brand: p.brand,
                price: getRepresentativePrice(p) || undefined,
                currency: resolvePriceBounds(p.price).currency,
                score: typeof evaluation?.oilGuardScore === 'number' ? evaluation.oilGuardScore : null,
                verdict: evaluation?.finalVerdict ?? null,
            };
        } catch (e: any) {
            console.warn('[EVALUATE_BRAND] focus-category skip product', p.id, e.message);
            return { id: p.id, name: p.name, brand: p.brand, score: null, verdict: null };
        }
    }));

    const valid = scored.filter(s => s.score !== null)
        .sort((a, b) => (b.score! - a.score!));

    return {
        category: canonicalCategory,
        productsInCategory: inCategory.length,
        productsScored: valid.length,
        truncated: inCategory.length > MAX_FOCUS,
        perProduct: scored,
        best: valid[0] ? { id: valid[0].id, name: valid[0].name, score: valid[0].score } : null,
        worst: valid.length > 1
            ? { id: valid[valid.length - 1].id, name: valid[valid.length - 1].name, score: valid[valid.length - 1].score }
            : null,
        categoryAvgScore: valid.length
            ? Math.round((valid.reduce((s, v) => s + v.score!, 0) / valid.length) * 10) / 10
            : null,
    };
}

export async function evaluateBrand(args: EvaluateBrandArgs) {
    const { brandName } = args;
    if (!brandName) return { error: 'Please provide a brand name to evaluate.' };

    const products = await getProducts();
    const resolution = resolveBrandProducts(brandName, products);

    if (!resolution.found) {
        if (resolution.candidates?.length) {
            return { error: `لم أتمكن من تحديد الماركة بدقة. هل تقصد إحدى هذه الماركات: ${resolution.candidates.join('، ')}؟` };
        }
        return { error: `لم يتم العثور على منتجات لماركة "${brandName}" في الكتالوج الحالي.` };
    }

    const brandProducts = resolution.products;
    const resolvedBrandName = resolution.resolvedBrandName;

    if (brandProducts.length === 0) {
        return { error: `لم يتم العثور على منتجات لماركة "${brandName}" في الكتالوج الحالي.` };
    }

    // Only send products that actually have parseable ingredients —
    // products with no INCI list can't be scored and would silently skew
    // sampleSize/aggregates if included as zero-ingredient evaluations.
    const payloadProducts = brandProducts
        .map((p: any) => ({
            id: p.id,
            name: p.name,
            category: typeof p.category === 'object' ? p.category?.id : p.category,
            country: p.country,
            price: getRepresentativePrice(p) || undefined,
            currency: resolvePriceBounds(p.price).currency,
            ingredients_list: parseIngredients(p.ingredients),
            product_type: normalizeProductType(p.category),
            marketingClaims: p.marketingClaims || [],
        }))
        .filter((p: any) => p.ingredients_list.length > 0);

    const skippedCount = brandProducts.length - payloadProducts.length;

    if (payloadProducts.length === 0) {
        return { error: `تم العثور على ${brandProducts.length} منتج لهذه الماركة، لكن لا يوجد لأي منها قائمة مكونات قابلة للتحليل.` };
    }

    // ── CATEGORY FOCUS starts NOW, in parallel with the brand aggregate ──
    // (it used to run only after the brand endpoint answered, so a compound
    // question paid for both round-trips back to back). Failures are
    // non-fatal and degrade to "no category focus".
    const canonicalFocus = args.focusCategory ? normalizeCategory(args.focusCategory) : undefined;
    const focusPromise: Promise<any> = canonicalFocus
        ? buildCategoryFocus(brandProducts, canonicalFocus).catch((focusErr: any) => {
            console.warn('[EVALUATE_BRAND] category focus failed (non-fatal):', focusErr.message);
            return null;
        })
        : Promise.resolve(null);

    try {
        console.log(`[EVALUATE_BRAND] Requesting: ${WATHIQ_BRAND_URL}`);
        // Hard timeout — a hung brand endpoint used to stall the whole turn.
        const controller = new AbortController();
        const timeoutMs = parseInt(process.env.WATHIQ_BRAND_TIMEOUT_MS || '30000', 10);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
            response = await fetch(WATHIQ_BRAND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ brand: resolvedBrandName, products: payloadProducts }),
                signal: controller.signal,
            });
        } catch (fetchErr: any) {
            if (fetchErr?.name === 'AbortError') {
                throw new Error(`Brand evaluation timed out after ${timeoutMs}ms`);
            }
            throw fetchErr;
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            throw new Error(`Brand evaluation API failed: ${response.statusText}`);
        }

        const profile = await response.json();

        // Already running (or finished) — one tool call answers both halves
        // of a compound question without serial latency.
        const categoryFocus: any = await focusPromise;

        return {
            ...profile,
            // surface catalog-side coverage gaps distinctly from the
            // aggregation itself, so the agent can mention it honestly
            catalogProductCount: brandProducts.length,
            skippedNoIngredients: skippedCount,
            categoryFocus,
        };
    } catch (error: any) {
        console.error('[EVALUATE_BRAND] API call failed:', error.message);
        return { error: `Failed to evaluate brand: ${error.message}` };
    }
}