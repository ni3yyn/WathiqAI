import { getProducts } from '../../wathiq/backendClient';
import {
    normalizeCountry,
    normalizeCategory,
    normalizeArabicText,
    matchesMultilingualCondition,
    expandToCatalogClaims
} from '../taxonomy';
import { resolvePriceBounds, formatPriceDisplay, PriceBounds } from '../priceUtils';
import { getSearchEntry } from './searchIndex';

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
    /** Skip the first N results — for "show me more / غيرهم / autres". */
    offset?: number;
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

export async function searchProducts(args: SearchProductsArgs) {
    const products = await getProducts();
    const limit = Math.min(Math.max(args.limit || 10, 1), 30);
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

    let scoredProducts = pool.map(p => {
        let score = 0;
        let totalPossible = 0;
        let queryTokensMatched = 0;

        // Precomputed once per product (see searchIndex.ts) — no per-query
        // Arabic normalization of the whole catalog anymore.
        const entry = getSearchEntry(p);
        const { pIng, allTags, allTagsNorm, bounds, searchable: searchableText } = entry;

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

            let matchedClaimsCount = 0;

            // We check if ANY of the product's tags match the translated expanded claims
            expandedUserClaims.forEach(expandedClaim => {
                const ec = normalizeArabicText(expandedClaim);
                if (allTagsNorm.some(t => t.includes(ec) || ec.includes(t))) {
                    matchedClaimsCount++;
                }
            });

            // If we found at least 1 match, grant proportional score (bonus for multiple matches)
            if (matchedClaimsCount > 0) {
                // Cap the maximum score at 20, but give at least 10 points for matching a primary claim
                score += Math.min(20, 10 + (matchedClaimsCount * 5));
            }
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
        return { product: p, score, matchPercentage, queryTokensMatched, bounds };
    });

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
    // If over-constrained, relax the SOFTEST constraint first (claims, then
    // condition targeting) and re-run the validity filter — rather than
    // showing the user an empty list when the catalog simply can't satisfy
    // every wish at once. Exclusions and prices are NEVER relaxed.
    if (validResults.length === 0 && (args.marketing_claims?.length || targetConditions.length > 0)) {
        // Relaxation 1: drop claim scoring
        if (args.marketing_claims?.length) {
            const relaxed = scoredProducts.filter(item =>
                item.score > 0 || (!args.query && !args.active_ingredient)
            );
            if (relaxed.length > 0) {
                validResults = relaxed;
                relaxedFilters.push('marketing_claims');
            }
        }
        // Relaxation 2: still empty and query-less → show the filtered pool
        if (validResults.length === 0 && !args.query && !args.active_ingredient) {
            validResults = scoredProducts.filter(item => item.score >= 0);
            if (validResults.length > 0 && targetConditions.length > 0) {
                relaxedFilters.push('skin_type/hair_type targeting');
            }
        }
    }

    // Sort
    if (args.sort_by === 'price_asc') {
        validResults.sort((a, b) => (a.bounds.min || 0) - (b.bounds.min || 0));
    } else if (args.sort_by === 'price_desc') {
        validResults.sort((a, b) => (b.bounds.max || 0) - (a.bounds.max || 0));
    } else {
        // relevance: score first, cheapest as tie-breaker
        validResults.sort((a, b) => (b.score - a.score) || ((a.bounds.min || 0) - (b.bounds.min || 0)));
    }

    // Paginate: offset/limit supports "show me more like these".
    const paged = validResults.slice(offset, offset + limit);
    const results = paged.map(item => formatProductForUI(item.product, item.bounds));
    const hasMore = offset + limit < validResults.length;

    let fallbackMessage: string | null = null;
    if (results.length === 0) {
        fallbackMessage = "No products found matching those exact criteria. Try broadening the search (e.g. fewer filters or an alternative category).";
    } else if (relaxedFilters.length > 0) {
        fallbackMessage = `Note: could not fully satisfy: ${relaxedFilters.join('; ')}.`;
    }

    return {
        foundCount: validResults.length,
        returnedCount: results.length,
        products: results,
        fallbackMessage,
        appliedFilters,
        relaxedFilters,
        hasMore,
        nextOffset: hasMore ? offset + limit : null
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
        currency: bounds.currency,
        image: p.image,
        claims: p.marketingClaims || [],
        targetTypes: p.targetTypes || []
    };
}
