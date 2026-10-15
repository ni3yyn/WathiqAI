import { getProducts } from '../../wathiq/backendClient';
import { resolvePriceBounds, formatPriceDisplay } from '../priceUtils';
import { normalizeArabicText } from '../taxonomy';

export interface GetProductArgs {
    productId?: string;    // Exact product ID, partial ID, or ID fragment
    productName?: string;  // Product name (e.g., "Belnco Clarifying Serum")
    query?: string;        // Free-text search term
}

// ─── Transliteration dictionary for Arabic brand spellings ───────────────────
export const ARABIC_BRAND_TRANSLITERATIONS: { [key: string]: string } = {
    'فينوس': 'venus',
    'بلنكو': 'belnco',
    'غارنيي': 'garnier',
    'غارنييه': 'garnier',
    'لوريال': "l'oréal",
    'نيدجما': 'nedjma',
    'سيان': 'cien',
    'بيوديرما': 'bioderma',
    'كوساركس': 'cosrx',
    'كوسركس': 'cosrx',
    'نيتروجينا': 'neutrogena',
    'سيراف': 'cerave',
    'سيرافي': 'cerave',
    'ايسدن': 'isdin',
};

// ─── Normalization helper ────────────────────────────────────────────────────
// Now layers the shared Arabic orthographic normalizer (alef variants,
// taa-marbuta, yaa, tashkeel — see taxonomy.normalizeArabicText) UNDER the
// Latin diacritic stripping, so "بشره"/"بشرة" and "CeraVe"/"cérave" all fold
// to the same comparison form. The old version only handled Latin accents,
// which is why diacritized or Darija-spelled queries silently missed.
export function norm(s: any): string {
    if (!s) return '';
    let text = normalizeArabicText(
        String(s)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036F]/g, '')   // strip Latin diacritics
    )
        .replace(/[^a-z0-9\u0600-\u06FF\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    for (const [ar, en] of Object.entries(ARABIC_BRAND_TRANSLITERATIONS)) {
        if (text.includes(normalizeArabicText(ar))) {
            text += ` ${en}`;
        }
    }
    return text;
}

// ─── Token-overlap fuzzy score (0–1) ────────────────────────────────────────
export function fuzzyScore(query: string, target: string): number {
    const qTokens = norm(query).split(' ').filter(t => t.length > 1);
    const tText = norm(target);
    if (qTokens.length === 0) return 0;
    let hits = 0;
    for (const tok of qTokens) {
        if (tText.includes(tok)) hits++;
    }
    return hits / qTokens.length;
}

// ─── Quantity resolver ───────────────────────────────────────────────────────
function resolveQty(q: any): string {
    if (typeof q === 'string') return q;
    if (q && typeof q === 'object') return `${q.qtyValue || ''} ${q.qtyUnit || ''}`.trim();
    return '';
}

// ─── Format Candidate Products for UI Rails ──────────────────────────────────
export function formatCandidateForUI(p: any) {
    const bounds = resolvePriceBounds(p.price);
    const qty = resolveQty(p.quantity);
    const catLabel = typeof p.category === 'object' ? p.category?.label : null;
    const catId = typeof p.category === 'object' ? p.category?.id : p.category;

    return {
        id: p.id,
        brand: p.brand || 'وثيق',
        name: p.name || 'منتج عناية',
        country: p.country || '',
        category: catId,
        categoryLabel: catLabel,
        quantity: qty,
        price: formatPriceDisplay(bounds),
        priceKnown: bounds.min !== undefined || bounds.max !== undefined,
        currency: bounds.currency || 'دج',
        image: p.image || '',
        claims: (p.marketingClaims || []).slice(0, 3),
        targetTypes: p.targetTypes || []
    };
}

// ─── Build rich normalized product object ────────────────────────────────────
function buildProduct(raw: any) {
    const price = resolvePriceBounds(raw.price);
    const qty = resolveQty(raw.quantity);
    const catLabel = typeof raw.category === 'object' ? raw.category?.label : null;
    const catId = typeof raw.category === 'object' ? raw.category?.id : raw.category;

    const ingredientList: string[] = (() => {
        if (typeof raw.ingredients === 'string') {
            return raw.ingredients.replace(/\.$/, '').split(',').map((s: string) => s.trim()).filter(Boolean);
        }
        if (Array.isArray(raw.ingredients)) return raw.ingredients.map(String);
        return [];
    })();

    const displayPrice = formatPriceDisplay(price);

    const contextSummary = [
        `**${raw.brand} – ${raw.name}** (ID: \`${raw.id}\`)`,
        catLabel ? `Category: ${catLabel}` : (catId ? `Category: ${catId}` : ''),
        qty ? `Size: ${qty}` : '',
        displayPrice ? `Price: ${displayPrice} ${price.currency}` : '',
        raw.country ? `Made in: ${raw.country}` : '',
        raw.targetTypes?.length ? `For: ${raw.targetTypes.join(', ')}` : '',
        raw.marketingClaims?.length ? `Claims: ${raw.marketingClaims.join(' · ')}` : '',
        ingredientList.length ? `${ingredientList.length} ingredients detected` : '',
    ].filter(Boolean).join(' | ');

    return {
        id: raw.id,
        brand: raw.brand,
        name: raw.name,
        country: raw.country,
        category: catId,
        categoryLabel: catLabel,
        quantity: qty,
        currency: price.currency,
        priceMin: price.min,
        priceMax: price.max,
        price: displayPrice,
        image: raw.image || '',
        ingredients: raw.ingredients,
        ingredientList,
        ingredientCount: ingredientList.length,
        marketingClaims: raw.marketingClaims || [],
        targetTypes: raw.targetTypes || [],
        contextSummary,
    };
}

// ─── In-Memory Speed Cache (Indexed Catalog) ─────────────────────────────────
interface IndexedProduct {
    idUpper: string;
    idNorm: string;
    /** ID with every non-alphanumeric char stripped — for dashless lookups. */
    idSquashed: string;
    normName: string;
    normBrandName: string;
    normSearchable: string;
    normIngredients: string;
    raw: any;
}

let cachedCatalogRef: any[] | null = null;
let indexedCatalog: IndexedProduct[] = [];
let idMap = new Map<string, any>();

function ensureIndexedCatalog(products: any[]) {
    if (cachedCatalogRef === products && indexedCatalog.length > 0) {
        return;
    }

    cachedCatalogRef = products;
    idMap.clear();
    indexedCatalog = new Array(products.length);

    for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const idUpper = (p.id || '').toUpperCase().trim();
        const idNorm = idUpper.toLowerCase();
        if (idUpper) idMap.set(idUpper, p);

        const nName = norm(p.name);
        const nBrand = norm(p.brand);
        const catId = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
        const country = p.country || '';

        indexedCatalog[i] = {
            idUpper,
            idNorm,
            idSquashed: idNorm.replace(/[^a-z0-9]/g, ''),
            normName: nName,
            normBrandName: `${nBrand} ${nName}`,
            normSearchable: `${nBrand} ${nName} ${norm(catId)} ${norm(country)}`,
            normIngredients: p.ingredients ? norm(p.ingredients) : '',
            raw: p
        };
    }
}

/** Squash an ID-ish string the same way the index does (drop dashes/case). */
function squashId(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when the query is a generic category word ("serum", "غسول", "كريم")
 *  rather than a specific product — those must never auto-resolve to the
 *  first catalog entry that happens to contain the word. */
const GENERIC_SINGLE_WORDS = new Set([
    'serum', 'سيروم', 'cleanser', 'غسول', 'منظف', 'cream', 'كريم', 'مرطب',
    'moisturizer', 'sunscreen', 'واقي', 'shampoo', 'شامبو', 'toner', 'تونر',
    'mask', 'ماسك', 'قناع', 'scrub', 'مقشر', 'lotion', 'huile', 'زيت', 'oil',
]);

// ─── Main lookup function ────────────────────────────────────────────────────
export async function getProduct(args: GetProductArgs): Promise<{
    found: boolean;
    matchStrategy?: string;
    product?: ReturnType<typeof buildProduct>;
    candidates?: any[];
    suggestion?: string;
}> {
    const products = await getProducts();
    ensureIndexedCatalog(products);

    const { productId, productName, query } = args;

    // ── Strategy 1: Exact ID match (O(1) Map Lookup) ─────────────────────────
    if (productId) {
        const cleanId = productId.trim().toUpperCase();
        if (/^[A-Z]{2}-[A-Z]{3}-[A-Z0-9]{3}-\d{3}$/i.test(cleanId) || idMap.has(cleanId)) {
            const exact = idMap.get(cleanId);
            if (exact) {
                console.log(`[GET_PRODUCT] Strategy 1 (exact ID O(1)): ${exact.id}`);
                return { found: true, matchStrategy: 'exact_id', product: buildProduct(exact) };
            }
        }
    }

    // ── Strategy 2: Partial ID match ─────────────────────────────────────────
    // Now also handles dashless / lowercase / pasted-fragment IDs by comparing
    // squashed forms on both sides ("dzclebel002" matches "DZ-CLE-BEL-002").
    if (productId) {
        const squashedQuery = squashId(productId);
        const looksIdish = squashedQuery.length >= 4
            && (/[a-z]/.test(squashedQuery) && /\d/.test(squashedQuery));

        if (looksIdish) {
            const partialMatches: any[] = [];
            for (let i = 0; i < indexedCatalog.length; i++) {
                const item = indexedCatalog[i];
                if (item.idSquashed.includes(squashedQuery) || squashedQuery.includes(item.idSquashed)) {
                    partialMatches.push(item.raw);
                    if (partialMatches.length > 5) break;
                }
            }

            if (partialMatches.length === 1) {
                console.log(`[GET_PRODUCT] Strategy 2 (partial ID): ${partialMatches[0].id}`);
                return { found: true, matchStrategy: 'partial_id', product: buildProduct(partialMatches[0]) };
            }

            if (partialMatches.length > 1) {
                const candidates = partialMatches.map(p => formatCandidateForUI(p));
                return {
                    found: false,
                    matchStrategy: 'ambiguous_id',
                    candidates,
                    suggestion: `Multiple products match "${productId}". Which one did you mean?`
                };
            }
        }
    }

    // ── Build combined search text ───────────────────────────────────────────
    const searchText = [productId, productName, query].filter(Boolean).join(' ').trim();
    if (!searchText) {
        return { found: false, suggestion: 'Please provide a product ID or a name/brand to search for.' };
    }

    const normSearch = norm(searchText);

    // ── Strategy 3: Fast Pre-Indexed Exact Name match ────────────────────────
    // FIX: the old code also accepted `normName.includes(normSearch)`, which
    // made any generic one-word query ("serum", "غسول") resolve to the FIRST
    // catalog product containing that word — a confident-looking but random
    // answer. Now:
    //   • full-string equality (name or brand+name) → still an instant hit
    //   • substring containment → collect ALL hits; auto-resolve only when it
    //     is unique AND the query isn't a generic category word; otherwise
    //     fall through to scored matching / ambiguous candidates.
    if (normSearch) {
        for (let i = 0; i < indexedCatalog.length; i++) {
            const item = indexedCatalog[i];
            if (item.normName === normSearch || item.normBrandName === normSearch) {
                console.log(`[GET_PRODUCT] Strategy 3 (exact name): ${item.raw.id}`);
                return { found: true, matchStrategy: 'exact_name', product: buildProduct(item.raw) };
            }
        }

        const qTokenCount = normSearch.split(' ').filter(t => t.length > 1).length;
        const isGenericSingle = qTokenCount <= 1 && GENERIC_SINGLE_WORDS.has(normSearch);

        if (!isGenericSingle) {
            const containmentHits: IndexedProduct[] = [];
            for (let i = 0; i < indexedCatalog.length; i++) {
                const item = indexedCatalog[i];
                if (item.normName.includes(normSearch) && normSearch.length >= 4) {
                    containmentHits.push(item);
                    if (containmentHits.length > 4) break;
                }
            }
            if (containmentHits.length === 1) {
                console.log(`[GET_PRODUCT] Strategy 3b (unique substring): ${containmentHits[0].raw.id}`);
                return { found: true, matchStrategy: 'unique_substring', product: buildProduct(containmentHits[0].raw) };
            }
            // Multiple containment hits → let Strategy 4/5 rank them properly.
        }
    }

    // ── Strategy 4: High-Performance Pre-Tokenized Scored Fuzzy Match ─────────
    const qTokens = normSearch.split(' ').filter(t => t.length > 1);
    if (qTokens.length === 0) {
        return { found: false, suggestion: `No product found matching "${searchText}".` };
    }

    type ScoredItem = { raw: any; score: number };
    const scored: ScoredItem[] = [];

    for (let i = 0; i < indexedCatalog.length; i++) {
        const item = indexedCatalog[i];
        let nameHits = 0;
        let wideHits = 0;
        let ingHits = 0;

        for (let j = 0; j < qTokens.length; j++) {
            const tok = qTokens[j];
            if (item.normBrandName.includes(tok)) nameHits++;
            if (item.normSearchable.includes(tok)) wideHits++;
            if (item.normIngredients && item.normIngredients.includes(tok)) ingHits++;
        }

        const nameScore = (nameHits / qTokens.length) * 0.70;
        const wideScore = (wideHits / qTokens.length) * 0.20;
        const ingScore = (ingHits / qTokens.length) * 0.10;
        const totalScore = nameScore + wideScore + ingScore;

        if (totalScore > 0.2) {
            scored.push({ raw: item.raw, score: totalScore });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
        console.log(`[GET_PRODUCT] No matches for: "${searchText}"`);
        return {
            found: false,
            suggestion: `No product found matching "${searchText}". Try using search_products for broader discovery.`
        };
    }

    const top = scored[0];
    const runnerUp = scored[1];

    // High confidence if score >= 0.45 and clearly leading
    const confident = top.score >= 0.45 && (!runnerUp || top.score >= runnerUp.score * 1.3);
    if (confident) {
        console.log(`[GET_PRODUCT] Strategy 4 (fuzzy, confident ${(top.score * 100).toFixed(0)}%): ${top.raw.id}`);
        return { found: true, matchStrategy: `fuzzy_name (${(top.score * 100).toFixed(0)}%)`, product: buildProduct(top.raw) };
    }

    // ── Strategy 5: Ambiguous Candidates (Formatted as UI Cards) ─────────────
    const candidates = scored.slice(0, 4).map(({ raw }) => formatCandidateForUI(raw));
    console.log(`[GET_PRODUCT] Strategy 5 (ambiguous): top candidates = ${candidates.map(c => c.id).join(', ')}`);
    return {
        found: false,
        matchStrategy: 'ambiguous',
        candidates,
        suggestion: `I found ${candidates.length} products that might match "${searchText}". Which one did you mean?`
    };
}
