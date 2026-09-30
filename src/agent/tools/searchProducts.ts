import { getProducts } from '../../wathiq/backendClient';
import { 
    normalizeCountry, 
    normalizeCategory, 
    matchesMultilingualCondition, 
    expandToCatalogClaims 
} from '../taxonomy';
import { resolvePriceBounds, formatPriceDisplay, PriceBounds } from '../priceUtils';

export interface SearchProductsArgs {
    query?: string;
    brand?: string;
    country?: string;
    category?: string;
    skin_type?: string;
    hair_type?: string;
    marketing_claims?: string[];
    active_ingredient?: string;
    min_price?: number;
    max_price?: number;
    around_price?: number;
    cheaper_than_product_id?: string;
    cheaper_than_price?: number;
    sort_by?: 'price_asc' | 'price_desc' | 'relevance';
    limit?: number;
}

export async function searchProducts(args: SearchProductsArgs) {
    const products = await getProducts();
    const limit = args.limit || 10;

    // ─── STEP 1: CONSTRAINT FILTERING (Country, Category, Brand) ─────────────
    let pool = products;

    // Normalize country (handles "Algérie", "الجزائر", "Algeria", etc.)
    const targetCountry = normalizeCountry(args.country);
    if (targetCountry) {
        const countryMatches = pool.filter(p => {
            const pCountryNorm = normalizeCountry(p.country) || (p.country || '').trim();
            return pCountryNorm.toLowerCase() === targetCountry.toLowerCase();
        });
        if (countryMatches.length > 0) pool = countryMatches;
    }

    // Normalize category (handles French, Arabic, English aliases)
    const targetCat = normalizeCategory(args.category);
    if (targetCat) {
        const catMatches = pool.filter(p => {
            const rawCatId = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
            const pCatNorm = normalizeCategory(rawCatId) || rawCatId;
            return pCatNorm.toLowerCase() === targetCat.toLowerCase() ||
                   pCatNorm.toLowerCase().includes(targetCat.toLowerCase()) ||
                   targetCat.toLowerCase().includes(pCatNorm.toLowerCase());
        });
        if (catMatches.length > 0) pool = catMatches;
    }

    // Brand filter (handles multi-brand "Venus or Belnco", accents, case-insensitivity)
    if (args.brand) {
        const reqBrands = args.brand.toLowerCase().split(/or|\/|,/).map(b => b.trim()).filter(Boolean);
        const brandMatches = pool.filter(p => {
            const pBrand = (p.brand || '').toLowerCase();
            return reqBrands.some(b => pBrand.includes(b) || b.includes(pBrand));
        });
        if (brandMatches.length > 0) pool = brandMatches;
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
                const targetCat = normalizeCategory(rawCatId) || rawCatId;
                const catMatches = pool.filter(p => {
                    const pCat = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
                    return (normalizeCategory(pCat) || pCat).toLowerCase() === targetCat.toLowerCase();
                });
                if (catMatches.length > 0) pool = catMatches;
            }
            // Exclude the reference product itself so we don't suggest what the user already has
            pool = pool.filter(p => p.id?.toLowerCase() !== refId);
        }
    }

    // If cheaper_than_price was provided (e.g. 2550 DZD)
    if (args.cheaper_than_price && args.cheaper_than_price > 0) {
        maxPrice = Math.min(maxPrice || Infinity, args.cheaper_than_price - 1);
    }

    if (args.around_price && args.around_price > 0) {
        minPrice = Math.max(0, Math.floor(args.around_price * 0.8));
        maxPrice = Math.ceil(args.around_price * 1.25);
    }

    // Hard Price Filtering (prevents expensive products from showing when looking for budget options)
    if (maxPrice !== undefined && maxPrice > 0) {
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

    // Expand marketing claims if provided
    const expandedClaims = args.marketing_claims?.length
        ? expandToCatalogClaims(args.marketing_claims)
        : [];

    // ─── STEP 3: RELEVANCE SCORING PIPELINE ───────────────────────────────────
    let scoredProducts = pool.map(p => {
        let score = 0;
        let totalPossible = 0;
        let queryTokensMatched = 0;

        const pBrand = (p.brand || '').toLowerCase();
        const pName = (p.name || '').toLowerCase();
        const pCountry = (p.country || '').toLowerCase();
        const pIng = (p.ingredients || '').toLowerCase();
        const pCatId = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
        const pCatLabel = typeof p.category === 'object' ? (p.category?.label || '') : '';

        const allTags: string[] = [
            ...(p.marketingClaims || []),
            ...(p.targetTypes || [])
        ].map((c: any) => typeof c === 'string' ? c.toLowerCase() : '');

        const bounds = resolvePriceBounds(p.price);

        // 1. Query Token Match (Weight: 35)
        if (args.query) {
            totalPossible += 35;
            const queryTokens = args.query.toLowerCase().trim().split(/\s+/).filter(t => t.length > 1);
            // Include tags in searchable text so "dark spots" or "dandruff" or "anti-acne" matches!
            const searchableText = `${pBrand} ${pName} ${pCatId} ${pCatLabel} ${pCountry} ${pIng} ${allTags.join(' ')}`;
            
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
            if (ings.some(i => pIng.includes(i))) {
                score += 35;
            }
        }

        // 3. Skin / Hair Target Types (Weight: 20)
        const targetReq = args.skin_type || args.hair_type;
        if (targetReq) {
            totalPossible += 20;
            const matchesTarget = allTags.some(t => matchesMultilingualCondition(t, targetReq));
            if (matchesTarget) {
                score += 20;
            }
        }

        // 4. Marketing Claims Match (Weight: 20)
        if (args.marketing_claims && args.marketing_claims.length > 0) {
            totalPossible += 20;
            
            // This translates ["brightening"] into ["تفتيح البشرة", "تفتيح البقع الداكنة", ...]
            const expandedUserClaims = expandToCatalogClaims(args.marketing_claims);
            let matchedClaimsCount = 0;

            // We check if ANY of the product's tags match the translated expanded claims
            expandedUserClaims.forEach(expandedClaim => {
                if (allTags.some(t => t.includes(expandedClaim) || expandedClaim.includes(t))) {
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
        if ((minPrice && minPrice > 0) || (maxPrice && maxPrice > 0)) {
            totalPossible += 10;
            const highest = bounds.max !== undefined ? bounds.max : bounds.min;
            const lowest = bounds.min !== undefined ? bounds.min : bounds.max;

            let priceMatch = true;
            if (minPrice && minPrice > 0 && highest !== undefined && highest < minPrice) priceMatch = false;
            if (maxPrice && maxPrice > 0 && lowest !== undefined && lowest > maxPrice) priceMatch = false;

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
            const pIng = (item.product.ingredients || '').toLowerCase();
            return reqIngs.some(i => pIng.includes(i));
        });

        if (ingredientMatches.length === 0) {
            return {
                foundCount: 0,
                returnedCount: 0,
                products: [],
                fallbackMessage: `We currently do not have any products in our catalog containing ${args.active_ingredient}. You might want to consider alternative active ingredients like Salicylic Acid or Niacinamide.`
            };
        } else {
            scoredProducts = ingredientMatches;
        }
    }

    // ─── STEP 5: TOKEN CUTOFF & RANKING ──────────────────────────────────────
    if (args.query) {
        const queryTokens = args.query.toLowerCase().trim().split(/\s+/).filter(t => t.length > 1);
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
        item.score > 0 || (!args.query && !args.skin_type && !args.hair_type && !args.marketing_claims && !args.active_ingredient)
    );

    // Sort
    if (args.sort_by === 'price_asc') {
        validResults.sort((a, b) => (a.bounds.min || 0) - (b.bounds.min || 0));
    } else if (args.sort_by === 'price_desc') {
        validResults.sort((a, b) => (b.bounds.max || 0) - (a.bounds.max || 0));
    } else {
        validResults.sort((a, b) => b.score - a.score);
    }

    // Format top results
    const topResults = validResults.slice(0, limit);
    const results = topResults.map(item => formatProductForUI(item.product, item.bounds));

    let fallbackMessage: string | null = null;
    if (results.length === 0) {
        fallbackMessage = "No products found matching those exact criteria. Try broadening the search (e.g. fewer filters or an alternative category).";
    }

    return {
        foundCount: validResults.length,
        returnedCount: results.length,
        products: results,
        fallbackMessage
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