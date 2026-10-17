import { getProducts, evaluateProduct as evaluateWithWathiq } from '../../wathiq/backendClient';
import {
    normalizeCountry,
    normalizeCategory,
    normalizeArabicText,
    matchesMultilingualCondition,
    expandToCatalogClaims,
    normalizeClaimToCatalog
} from '../taxonomy';
import { resolvePriceBounds, formatPriceDisplay, PriceBounds } from '../priceUtils';
import { getSearchEntry } from './searchIndex';
import { STATUS } from '../statuses';

export interface SearchProductsHooks {
    /** Optional live status callback supplied by the agent tool dispatcher. */
    onStatus?: (status: string) => void;
}

export interface SearchProductsArgs {
    query?: string;
    brand?: string;
    country?: string;
    category?: string;
    /** One condition ("بشرة دهنية") or several joined by / , "or" ("جافة أو حساسة"). */
    skin_type?: string;
    hair_type?: string;
    marketing_claims?: string[];
    active_ingredient?: string;
    /** Ingredients that must NOT appear (allergies, "بدون كحول", "fragrance-free"). */
    exclude_ingredients?: string[];
    /** Product IDs to leave out (e.g. "show me others", "not this one"). */
    exclude_product_ids?: string[];
    min_price?: number;
    max_price?: number;
    around_price?: number;
    cheaper_than_product_id?: string;
    cheaper_than_price?: number;
    sort_by?: 'price_asc' | 'price_desc' | 'relevance';
    limit?: number;
    /** Skip the first N evaluated results — for "show me more / غيرهم / autres". */
    offset?: number;
}

/** Evaluate a bounded shortlist rather than making one backend request per catalog item. */
const EVALUATION_CANDIDATE_LIMIT = Math.max(5, Math.min(40, Number.parseInt(process.env.WATHIQ_SEARCH_EVALUATION_CANDIDATES || '20', 10) || 20));
const EVALUATION_CONCURRENCY = Math.max(1, Math.min(8, Number.parseInt(process.env.WATHIQ_SEARCH_EVALUATION_CONCURRENCY || '4', 10) || 4));
const TOP_RESULTS_LIMIT = 5;

function normalizeEvaluationProductType(rawCategory: any): string {
    const raw = typeof rawCategory === 'object' ? (rawCategory?.id || '') : (typeof rawCategory === 'string' ? rawCategory : '');
    const t = raw.toLowerCase().trim();
    if (t === 'skin_serum' || t === 'hair_serum') return 'serum';
    if (t === 'hair_mask' || t === 'face_mask') return 'mask';
    if (t === 'body_wash') return 'cleanser';
    if (t === 'oil_blend' || t === 'oil_replacement') return 'oil';
    return t || 'other';
}

function toIngredientArray(raw: any): string[] {
    if (typeof raw === 'string') return raw.replace(/\.$/, '').split(',').map(s => s.trim()).filter(s => s.length > 1);
    if (Array.isArray(raw)) return raw.map((s: any) => String(s).trim()).filter((s: string) => s.length > 1);
    return [];
}

function evaluationClaims(product: any, requestedClaims?: string[]): string[] {
    const raw = requestedClaims?.length ? requestedClaims : (Array.isArray(product.marketingClaims) ? product.marketingClaims : []);
    return raw.map((c: any) => normalizeClaimToCatalog(String(c)) || String(c).trim())
        .filter((c: string, i: number, arr: string[]) => !!c && arr.indexOf(c) === i);
}

async function evaluateCandidate(product: any, args: SearchProductsArgs): Promise<{ score: number; verdict?: string } | null> {
    const ingredients = toIngredientArray(product.ingredients);
    if (ingredients.length === 0) return null;
    const userProfile = {
        allergies: [],
        conditions: [],
        skinType: args.skin_type || undefined,
        scalpType: args.hair_type || undefined,
    };
    try {
        const result = await evaluateWithWathiq({
            ingredients_list: ingredients,
            user_profile: userProfile,
            selected_claims: evaluationClaims(product, args.marketing_claims),
            product_type: normalizeEvaluationProductType(product.category),
        });
        if (typeof result?.oilGuardScore !== 'number' || !Number.isFinite(result.oilGuardScore)) return null;
        return { score: result.oilGuardScore, verdict: typeof result.finalVerdict === 'string' ? result.finalVerdict : undefined };
    } catch (error: any) {
        console.warn(`[SEARCH_PRODUCTS][EVALUATE] Failed for ${product.id || product.name}: ${error?.message || error}`);
        return null;
    }
}

async function evaluateCandidates(candidates: any[], args: SearchProductsArgs): Promise<Array<{ item: any; evaluation: { score: number; verdict?: string } | null }>> {
    const out: Array<{ item: any; evaluation: { score: number; verdict?: string } | null }> = new Array(candidates.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(EVALUATION_CONCURRENCY, candidates.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= candidates.length) return;
            const item = candidates[index];
            out[index] = { item, evaluation: await evaluateCandidate(item.product, args) };
        }
    });
    await Promise.all(workers);
    return out;
}

/** Split a multi-condition string into individual condition phrases. */
function splitConditions(raw?: string): string[] {
    if (!raw) return [];
    return raw
        .split(/\s*(?:،|,|\/|\s+or\s+|\s+ou\s+|\s+و\s+|\s+and\s+)\s*/i)
        .map(s => s.trim())
        .filter(s => s.length > 1);
}

/** Canonicalize an exclude token for ingredient-string matching. */
function normalizeExcludeToken(raw: string): string[] {
    const t = normalizeArabicText(raw);
    const tokens: string[] = [];
    // Expand friendly names to the INCI strings that actually appear in lists.
    const aliasMap: Array<[RegExp, string[]]> = [
        [/fragrance|parfum|عطر/, ['parfum', 'fragrance']],
        [/alcohol|كحول/, ['alcohol']],
        [/paraben|بارابين/, ['paraben']],
        [/sulfate|sulphate|sls|كبريتات|سلفات/, ['sulfate', 'sulphate', 'sodium lauryl sulfate', 'sodium laureth sulfate']],
        [/silicone|سيليكون/, ['dimethicone', 'silicone', 'cyclomethicone']],
        [/essential oil|زيت عطري/, ['essential oil']],
    ];
    for (const [re, inci] of aliasMap) {
        if (re.test(t)) {
            tokens.push(...inci);
            return tokens;
        }
    }
    if (t.length >= 3) tokens.push(t);
    return tokens;
}

export async function searchProducts(args: SearchProductsArgs, hooks: SearchProductsHooks = {}) {
    const products = await getProducts();
    // This tool returns at most five products per page: they are ranked by the
    // real Wathiq evaluation score below, not merely by catalog text relevance.
    const limit = Math.min(Math.max(args.limit || TOP_RESULTS_LIMIT, 1), TOP_RESULTS_LIMIT);
    const offset = Math.max(args.offset || 0, 0);

    // Tracks which user constraints survived, for honest fallback messages.
    const appliedFilters: string[] = [];
    const relaxedFilters: string[] = [];

    // ─── STEP 1: CONSTRAINT FILTERING (Country, Category, Brand) ─────────────
    let pool = products;

    // Normalize country (handles "Algérie", "الجزائر", "Algeria", etc.)
    const targetCountry = normalizeCountry(args.country);
    if (targetCountry) {
        const targetCountryLc = targetCountry.toLowerCase();
        const countryMatches = pool.filter(p => getSearchEntry(p).countryCanon === targetCountryLc);
        if (countryMatches.length > 0) {
            pool = countryMatches;
            appliedFilters.push(`country=${targetCountry}`);
        }
    }

    // Normalize category (handles French, Arabic, English aliases)
    const targetCat = normalizeCategory(args.category);
    if (targetCat) {
        const targetCatLc = targetCat.toLowerCase();
        const catMatches = pool.filter(p => {
            const c = getSearchEntry(p).catCanon;
            return c === targetCatLc || c.includes(targetCatLc) || targetCatLc.includes(c);
        });
        if (catMatches.length > 0) {
            pool = catMatches;
            appliedFilters.push(`category=${targetCat}`);
        }
    }

    // Brand filter (handles multi-brand "Venus or Belnco", accents, case-insensitivity)
    if (args.brand) {
        const reqBrands = args.brand.toLowerCase().split(/or|\/|,/).map(b => b.trim()).filter(Boolean);
        const reqBrandsNorm = reqBrands.map(b => normalizeArabicText(b));
        const brandMatches = pool.filter(p => {
            const pBrand = getSearchEntry(p).pBrand;
            return reqBrandsNorm.some(b => pBrand.includes(b) || b.includes(pBrand));
        });
        if (brandMatches.length > 0) {
            pool = brandMatches;
            appliedFilters.push(`brand=${args.brand}`);
        }
    }

    // Explicit exclusions by ID ("not this one", "other than these")
    if (args.exclude_product_ids && args.exclude_product_ids.length > 0) {
        const excluded = new Set(args.exclude_product_ids.map(id => String(id).toLowerCase().trim()));
        const before = pool.length;
        pool = pool.filter(p => !excluded.has((p.id || '').toLowerCase()));
        if (pool.length < before) appliedFilters.push(`excluded=${before - pool.length} product(s)`);
    }

    // ─── STEP 2: PRICE WINDOW SETUP & "CHEAPER THAN" LOGIC ──────────────────
    let minPrice = args.min_price;
    let maxPrice = args.max_price;

    // If cheaper_than_product_id was provided, resolve reference product price & category
    if (args.cheaper_than_product_id) {
        const refId = args.cheaper_than_product_id.toLowerCase().trim();
        const refProduct = products.find(p => p.id?.toLowerCase() === refId);
        if (refProduct) {
            const refBounds = resolvePriceBounds(refProduct.price);
            const refVal = refBounds.min !== undefined ? refBounds.min : refBounds.max;
            if (refVal && refVal > 0) {
                maxPrice = Math.min(maxPrice || Infinity, refVal - 1);
            }
            // Adopt same category if not specified
            if (!args.category && refProduct.category) {
                const rawCatId = typeof refProduct.category === 'object' ? (refProduct.category?.id || '') : (refProduct.category || '');
                const refCat = normalizeCategory(rawCatId) || rawCatId;
                const catMatches = pool.filter(p => {
                    const pCat = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
                    return (normalizeCategory(pCat) || pCat).toLowerCase() === refCat.toLowerCase();
                });
                if (catMatches.length > 0) pool = catMatches;
            }
            // Exclude the reference product itself so we don't suggest what the user already has
            pool = pool.filter(p => p.id?.toLowerCase() !== refId);
            appliedFilters.push(`cheaper_than=${refProduct.name || refId}`);
        }
    }

    // If cheaper_than_price was provided (e.g. 2550 DZD)
    if (args.cheaper_than_price && args.cheaper_than_price > 0) {
        maxPrice = Math.min(maxPrice || Infinity, args.cheaper_than_price - 1);
        appliedFilters.push(`cheaper_than_price=${args.cheaper_than_price}`);
    }

    if (args.around_price && args.around_price > 0) {
        minPrice = Math.max(0, Math.floor(args.around_price * 0.8));
        maxPrice = Math.ceil(args.around_price * 1.25);
        appliedFilters.push(`around_price=${args.around_price}`);
    }

    // Hard Price Filtering (prevents expensive products from showing when looking for budget options)
    if (maxPrice !== undefined && maxPrice > 0 && maxPrice !== Infinity) {
        const priceFiltered = pool.filter(p => {
            const b = resolvePriceBounds(p.price);
            const pVal = b.min !== undefined ? b.min : b.max;
            // Include products with unknown price or price strictly <= maxPrice
            return pVal === undefined || pVal <= maxPrice;
        });
        if (priceFiltered.length > 0) pool = priceFiltered;
    }

    if (minPrice !== undefined && minPrice > 0) {
        const priceFiltered = pool.filter(p => {
            const b = resolvePriceBounds(p.price);
            const pVal = b.max !== undefined ? b.max : b.min;
            return pVal === undefined || pVal >= minPrice;
        });
        if (priceFiltered.length > 0) pool = priceFiltered;
    }

    // ─── STEP 2b: INGREDIENT EXCLUSIONS (allergies, "بدون كحول") ─────────────
    // HARD filter — never relaxed. A user with an allergy would rather see
    // fewer results than a product containing the allergen. Products with NO
    // ingredient list are excluded too (can't verify = can't recommend when
    // exclusions are in play).
    const excludeTokens = (args.exclude_ingredients || [])
        .flatMap(normalizeExcludeToken)
        .filter(Boolean);

    if (excludeTokens.length > 0) {
        const safe = pool.filter(p => {
            const e = getSearchEntry(p);
            if (!e.hasIngredients) return false;
            return !excludeTokens.some(tok => e.pIng.includes(tok));
        });
        // Keep at least the exclusion-filtered pool even if small; only fall
        // back to the unfiltered pool if exclusions wiped EVERYTHING — and
        // report that honestly instead of silently serving allergens.
        if (safe.length > 0) {
            pool = safe;
            appliedFilters.push(`exclude_ingredients=[${(args.exclude_ingredients || []).join(', ')}]`);
        } else {
            relaxedFilters.push(`no products fully satisfy exclude=[${(args.exclude_ingredients || []).join(', ')}] — showing results WITHOUT that guarantee`);
        }
    }

    // ─── STEP 3: RELEVANCE SCORING PIPELINE ───────────────────────────────────
    // Multi-condition support: "بشرة دهنية وحب الشباب" scores each condition.
    const skinConditions = splitConditions(args.skin_type);
    const hairConditions = splitConditions(args.hair_type);
    const targetConditions = [...skinConditions, ...hairConditions];

    // Expand marketing claims if provided
    const expandedUserClaims = args.marketing_claims?.length
        ? expandToCatalogClaims(args.marketing_claims)
        : [];
    const requestedClaimSet = new Set(expandedUserClaims.map(claim => normalizeArabicText(claim)).filter(Boolean));

    let scoredProducts = pool.map(p => {
        let score = 0;
        let totalPossible = 0;
        let queryTokensMatched = 0;

        // Precomputed once per product (see searchIndex.ts) — no per-query
        // Arabic normalization of the whole catalog anymore.
        const entry = getSearchEntry(p);
        const { pIng, allTags, marketingClaimsNorm, bounds, searchable: searchableText } = entry;

        // 1. Query Token Match (Weight: 35) — Arabic-normalized on both sides.
        if (args.query) {
            totalPossible += 35;
            const queryTokens = normalizeArabicText(args.query).split(/\s+/).filter(t => t.length > 1);
            // Include tags in searchable text so "dark spots" or "dandruff" or "anti-acne" matches!

            queryTokens.forEach(token => {
                if (searchableText.includes(token)) queryTokensMatched++;
            });

            if (queryTokens.length > 0) {
                score += (queryTokensMatched / queryTokens.length) * 35;
            }
        }

        // 2. Active Ingredient INCI Match (Weight: 35)
        if (args.active_ingredient) {
            totalPossible += 35;
            const ings = args.active_ingredient.toLowerCase().split(/or|\/|,/).map(i => i.trim()).filter(Boolean);
            if (ings.some(i => pIng.includes(normalizeArabicText(i)))) {
                score += 35;
            }
        }

        // 3. Skin / Hair Target Types (Weight: 20, proportional over multiple conditions)
        if (targetConditions.length > 0) {
            totalPossible += 20;
            let condHits = 0;
            for (const cond of targetConditions) {
                if (allTags.some(t => matchesMultilingualCondition(t, cond))) condHits++;
            }
            if (condHits > 0) {
                score += (condHits / targetConditions.length) * 20;
            }
        }

        // 4. Marketing Claims Match (Weight: 20)
        if (expandedUserClaims.length > 0) {
            totalPossible += 20;
            const matchedClaimsCount = marketingClaimsNorm.filter(claim => requestedClaimSet.has(claim)).length;
            if (matchedClaimsCount > 0) score += Math.min(20, 10 + (matchedClaimsCount * 5));
        }

        // 5. Price Constraints (Weight: 10)
        if ((minPrice && minPrice > 0) || (maxPrice && maxPrice > 0 && maxPrice !== Infinity)) {
            totalPossible += 10;
            const highest = bounds.max !== undefined ? bounds.max : bounds.min;
            const lowest = bounds.min !== undefined ? bounds.min : bounds.max;

            let priceMatch = true;
            if (minPrice && minPrice > 0 && highest !== undefined && highest < minPrice) priceMatch = false;
            if (maxPrice && maxPrice > 0 && maxPrice !== Infinity && lowest !== undefined && lowest > maxPrice) priceMatch = false;

            if (priceMatch && (lowest !== undefined || bounds.min !== undefined)) {
                score += 10;
            }
        }

        const matchPercentage = totalPossible > 0 ? Math.round((score / totalPossible) * 100) : 100;
        const matchedClaimsCount = marketingClaimsNorm.filter(claim => requestedClaimSet.has(claim)).length;
        return { product: p, score, matchPercentage, queryTokensMatched, matchedClaimsCount, bounds };
    });

    // A requested marketing claim is an explicit product requirement, not a
    // weak ranking hint. Never return products tagged only for a different claim.
    if (requestedClaimSet.size > 0) {
        const claimMatches = scoredProducts.filter(item => item.matchedClaimsCount > 0);
        if (claimMatches.length === 0) {
            return {
                foundCount: 0,
                returnedCount: 0,
                products: [],
                appliedFilters,
                relaxedFilters,
                hasMore: false,
                nextOffset: null,
                fallbackMessage: `No catalog products are tagged with the requested claim(s): ${(args.marketing_claims || []).join(', ')}.`,
            };
        }
        scoredProducts = claimMatches;
        appliedFilters.push(`marketing_claims=${(args.marketing_claims || []).join('|')}`);
    }

    // ─── STEP 4: STRICT INGREDIENT SAFEGUARD ─────────────────────────────────
    if (args.active_ingredient) {
        const reqIngs = args.active_ingredient.toLowerCase().split(/or|\/|,/).map(i => i.trim()).filter(Boolean);
        const ingredientMatches = scoredProducts.filter(item => {
            const pIng = getSearchEntry(item.product).pIng;
            return reqIngs.some(i => pIng.includes(normalizeArabicText(i)));
        });

        if (ingredientMatches.length === 0) {
            return {
                foundCount: 0,
                returnedCount: 0,
                products: [],
                appliedFilters,
                relaxedFilters,
                hasMore: false,
                fallbackMessage: `We currently do not have any products in our catalog containing ${args.active_ingredient}. You might want to consider alternative active ingredients like Salicylic Acid or Niacinamide.`
            };
        } else {
            scoredProducts = ingredientMatches;
        }
    }

    // ─── STEP 5: TOKEN CUTOFF & RANKING ──────────────────────────────────────
    if (args.query) {
        const queryTokens = normalizeArabicText(args.query).split(/\s+/).filter(t => t.length > 1);
        if (queryTokens.length > 1) {
            const maxTokensMatched = Math.max(...scoredProducts.map(i => i.queryTokensMatched), 0);
            if (maxTokensMatched >= 2) {
                const highOverlap = scoredProducts.filter(item => item.queryTokensMatched >= maxTokensMatched - 1);
                if (highOverlap.length > 0) scoredProducts = highOverlap;
            }
        }
    }

    // Filter valid results
    let validResults = scoredProducts.filter(item =>
        item.score > 0 || (!args.query && targetConditions.length === 0 && !args.marketing_claims && !args.active_ingredient)
    );

    // ─── RELAXATION LADDER ───────────────────────────────────────────────────
    // If over-constrained, relax condition targeting only. Explicit claim
    // requests, exclusions, and prices are never relaxed silently.
    if (validResults.length === 0 && (args.marketing_claims?.length || targetConditions.length > 0)) {
        // Still empty and query-less → relax skin/hair targeting only.
        if (validResults.length === 0 && !args.query && !args.active_ingredient) {
            validResults = scoredProducts.filter(item => item.score >= 0);
            if (validResults.length > 0 && targetConditions.length > 0) {
                relaxedFilters.push('skin_type/hair_type targeting');
            }
        }
    }

    // Establish a bounded candidate shortlist using the existing catalog relevance
    // score. Evaluating every match could make a broad search need hundreds of API
    // calls; the shortlist keeps this path useful while still comparing candidates.
    const catalogRanked = [...validResults].sort((a, b) =>
        (b.score - a.score) || ((a.bounds.min ?? Number.POSITIVE_INFINITY) - (b.bounds.min ?? Number.POSITIVE_INFINITY))
    );
    const evaluationCandidates = catalogRanked.slice(0, EVALUATION_CANDIDATE_LIMIT);
    if (evaluationCandidates.length > 0) {
        hooks.onStatus?.(STATUS.SEARCH_EVALUATING);
    }
    const evaluated = await evaluateCandidates(evaluationCandidates, args);
    const scoredEvaluations = evaluated.filter((entry): entry is { item: any; evaluation: { score: number; verdict?: string } } => !!entry.evaluation);

    // Prefer the actual Wathiq score. Catalog relevance and price are deterministic
    // tie-breakers only; they never override a higher evaluation score.
    let rankedForDisplay: Array<{ item: any; evaluation: { score: number; verdict?: string } | null }>;
    let evaluationUnavailable = false;
    if (scoredEvaluations.length > 0) {
        // Only products with a real score may occupy the ranked list. A missing
        // evaluation is not a zero score and must not be passed off as a scored
        // recommendation merely to fill all five slots.
        rankedForDisplay = [...scoredEvaluations].sort((a, b) => {
            const scoreA = a.evaluation.score;
            const scoreB = b.evaluation.score;
            if (scoreA !== scoreB) return scoreB - scoreA;
            return (b.item.score - a.item.score)
                || ((a.item.bounds.min ?? Number.POSITIVE_INFINITY) - (b.item.bounds.min ?? Number.POSITIVE_INFINITY));
        });
    } else {
        // If the evaluation API is unavailable (or all candidates lack INCI),
        // keep results useful but never pretend they were sorted by evaluation.
        evaluationUnavailable = true;
        rankedForDisplay = catalogRanked.slice(0, EVALUATION_CANDIDATE_LIMIT).map(item => ({ item, evaluation: null }));
    }

    // Tell the user that backend evaluation is complete and the final shortlist
    // is being assembled. The request-scoped reporter suppresses duplicate events.
    if (evaluationCandidates.length > 0) hooks.onStatus?.(STATUS.SEARCH_RANKING);

    // Offset pages through the same bounded, evaluation-ranked shortlist.
    const paged = rankedForDisplay.slice(offset, offset + limit);
    const results = paged.map(({ item, evaluation }, index) => ({
        ...formatProductForUI(item.product, item.bounds),
        // Expose the real backend score to product cards/consuming clients.
        evaluationScore: evaluation?.score ?? null,
        evaluationVerdict: evaluation?.verdict ?? null,
        evaluationStatus: evaluation ? 'evaluated' : 'unavailable',
        rank: offset + index + 1,
    }));
    const hasMore = offset + limit < rankedForDisplay.length;

    let fallbackMessage: string | null = null;
    if (results.length === 0) {
        fallbackMessage = "No products found matching those exact criteria. Try broadening the search (e.g. fewer filters or an alternative category).";
    } else if (evaluationUnavailable) {
        fallbackMessage = "لم تتوفر درجة تقييم صالحة من محرك وثيق لهذه النتائج؛ عُرضت حسب مطابقة الكتالوج فقط، وليس حسب درجة الفعالية.";
    } else if (scoredEvaluations.length < evaluated.length) {
        fallbackMessage = `تم ترتيب ${scoredEvaluations.length} منتجًا فقط من أصل ${evaluated.length} مرشحًا حصلوا على تقييم صالح. لم أُدرج المنتجات التي تعذّر تقييمها ضمن النتائج المرتبة.`;
    } else if (relaxedFilters.length > 0) {
        fallbackMessage = `Note: could not fully satisfy: ${relaxedFilters.join('; ')}.`;
    }

    return {
        foundCount: validResults.length,
        catalogMatchCount: validResults.length,
        evaluatedCount: scoredEvaluations.length,
        returnedCount: results.length,
        products: results,
        rankingMode: evaluationUnavailable ? 'catalog_relevance_fallback' : 'wathiq_oilGuardScore_desc',
        evaluationCandidateLimit: EVALUATION_CANDIDATE_LIMIT,
        fallbackMessage,
        appliedFilters,
        relaxedFilters,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
        // Honesty about incomplete price data: how many shown products have no
        // price on file (they are NOT excluded by a budget — we just can't verify it).
        unpricedCount: results.filter(r => !r.priceKnown).length,
    };
}

function formatProductForUI(p: any, bounds: PriceBounds) {
    const displayPrice = formatPriceDisplay(bounds);

    let displayQty = '';
    if (typeof p.quantity === 'string') {
        displayQty = p.quantity;
    } else if (p.quantity && typeof p.quantity === 'object') {
        displayQty = `${p.quantity.qtyValue || ''} ${p.quantity.qtyUnit || ''}`.trim();
    }

    return {
        id: p.id,
        brand: p.brand,
        name: p.name,
        country: p.country,
        category: typeof p.category === 'object' ? (p.category?.id || p.category) : p.category,
        categoryLabel: typeof p.category === 'object' ? p.category?.label : null,
        quantity: displayQty,
        price: displayPrice,
        priceKnown: bounds.min !== undefined || bounds.max !== undefined,
        currency: bounds.currency,
        image: p.image,
        claims: p.marketingClaims || [],
        targetTypes: p.targetTypes || []
    };
}
