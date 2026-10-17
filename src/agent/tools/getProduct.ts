import { getProducts } from '../../wathiq/backendClient';
import { resolvePriceBounds, formatPriceDisplay } from '../priceUtils';
import { normalizeArabicText, normalizeCategory, detectCategoryInText } from '../taxonomy';

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
        targetTypes: p.targetTypes || [],
        ingredientsAvailable: Array.isArray(p.ingredients) ? p.ingredients.length > 0 : (typeof p.ingredients === 'string' && p.ingredients.trim().length > 0),
        canEvaluate: Array.isArray(p.ingredients) ? p.ingredients.length > 0 : (typeof p.ingredients === 'string' && p.ingredients.trim().length > 0)
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

// ─── Human-query parsing ─────────────────────────────────────────────────────
// Real users type a brand and a fragment, not a catalog ID. Strip conversational
// glue before ranking, but preserve likely brand/name words.
const QUERY_GLUE = new Set((
    'وش واش رايك فال ف في فين من عن على تع تاع نتاع هذا هذي هاذي هاد هاذا هادي ' +
    'قيملي قيم قيمي قيمو قيمني حلل حللي شوف شوفلي رايكم رأيك رأيكم ' +
    'اريد أريد نحب حاب حابة بغيت نبغي ممكن لو سمحت من فضلك please can you could tell me what do does is the a an of for about this that product one evaluate rate review analyze analyse check ' +
    'est ce que donne moi dis moi tu peux peux-tu quel quelle le la les un une de du des pour produit avis sur'
).split(/\s+/).filter(Boolean));

const CATEGORY_QUERY_WORDS = new Set((
    'sunscreen sun screen spf sunblock solaire ecran écran creme crème واقي واقي شمس واقي الشمس الواقي ' +
    'serum sérum سيروم غسول منظف cleanser nettoyant face wash cream lotion مرطب كريم moisturizer ' +
    'shampoo shampoing شامبو toner تونر scrub مقشر oil huile زيت mask masque ماسك conditioner بلسم'
).split(/\s+/).map(x => norm(x)));

function humanQueryTokens(raw: string): string[] {
    const normalized = norm(raw);
    const tokens = normalized.split(/\s+/).map(token => token.replace(/^(?:و|ف|ب)?ال(?=[\u0600-\u06FF])/, ''))
        .filter(token => token.length > 1 && !QUERY_GLUE.has(token) && !CATEGORY_QUERY_WORDS.has(token));
    return [...new Set(tokens)];
}

function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return previous[b.length];
}

function tokenMatches(queryToken: string, targetToken: string): boolean {
    if (queryToken === targetToken) return true;
    if (queryToken.length < 4 || targetToken.length < 4) return false;
    if (targetToken.includes(queryToken) || queryToken.includes(targetToken)) return true;
    const distance = editDistance(queryToken, targetToken);
    return 1 - distance / Math.max(queryToken.length, targetToken.length) >= 0.76;
}

function canonicalProductCategory(p: any): string {
    const raw = typeof p.category === 'object' ? (p.category?.id || p.category?.label || '') : (p.category || '');
    return normalizeCategory(String(raw)) || String(raw).toLowerCase();
}

function productHasIngredients(p: any): boolean {
    return Array.isArray(p.ingredients) ? p.ingredients.length > 0 : (typeof p.ingredients === 'string' && p.ingredients.trim().length > 0);
}

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
    const searchParts = [productId, productName, query]
        .map(value => typeof value === 'string' ? value.trim() : '')
        .filter(Boolean);
    const seenSearchParts = new Set<string>();
    const searchText = searchParts.filter(part => {
        const key = norm(part);
        if (!key || seenSearchParts.has(key)) return false;
        seenSearchParts.add(key);
        return true;
    }).join(' ').trim();
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

    // ── Strategy 4: intent-aware, conservative candidate ranking ──────────────
    // Retrieval and identity resolution are different decisions. A brand/category
    // hit must not silently select an arbitrary product when several are plausible.
    const qTokens = humanQueryTokens(searchText);
    const queryCategory = detectCategoryInText(searchText);
    if (qTokens.length === 0 && !queryCategory) {
        return { found: false, suggestion: 'ما قدرتش نحدد اسم المنتج. اكتب اسم الماركة أو جزءًا من الاسم الموجود على العلبة؛ ما تحتاجش تعرف المعرّف.' };
    }

    type ScoredItem = { raw: any; score: number; brandHits: number; nameHits: number; categoryMatch: boolean; specificHits: number };
    const scored: ScoredItem[] = [];
    for (const item of indexedCatalog) {
        const nameTokens = item.normName.split(' ').filter(Boolean);
        const category = canonicalProductCategory(item.raw);
        const categoryMatch = !!queryCategory && (category === queryCategory || category.includes(queryCategory) || queryCategory.includes(category));
        let brandHits = 0, nameHits = 0, specificHits = 0, wideHits = 0;
        const productBrandTokens = norm(item.raw.brand || '').split(' ').filter(Boolean);
        for (const tok of qTokens) {
            const inBrand = productBrandTokens.some((bt: string) => tokenMatches(tok, bt));
            const inName = nameTokens.some(nt => tokenMatches(tok, nt));
            if (inBrand) brandHits++;
            if (inName) {
                nameHits++;
                if (tok.length >= 4) specificHits++;
            }
            if (item.normSearchable.includes(tok)) wideHits++;
        }
        const denominator = Math.max(1, qTokens.length);
        const score = (brandHits / denominator * 0.40) + (nameHits / denominator * 0.45) + (wideHits / denominator * 0.10) + (categoryMatch ? 0.30 : 0);
        if (score > 0.12 || (categoryMatch && brandHits > 0)) {
            scored.push({ raw: item.raw, score, brandHits, nameHits, categoryMatch, specificHits });
        }
    }
    scored.sort((a, b) => b.score - a.score || Number(b.categoryMatch) - Number(a.categoryMatch) || b.specificHits - a.specificHits);

    if (!scored.length) {
        console.log(`[GET_PRODUCT] No matches for: "${searchText}"`);
        return { found: false, suggestion: `ما لقيتش منتجًا واضحًا يطابق "${searchText}". جرّب الماركة مع جزء من الاسم، أو اكتب الاسم كما يظهر على العلبة. ما تحتاجش معرّف المنتج.` };
    }

    const brandMatched = scored.filter(s => s.brandHits > 0);
    const categoryAndBrand = queryCategory ? brandMatched.filter(s => s.categoryMatch) : [];
    // Brand + category may auto-resolve only if exactly one catalog product fits.
    if (queryCategory && categoryAndBrand.length === 1) {
        const only = categoryAndBrand[0];
        console.log(`[GET_PRODUCT] Strategy 4 (unique brand+category): ${only.raw.id}`);
        return { found: true, matchStrategy: 'unique_brand_category', product: buildProduct(only.raw) };
    }

    const top = scored[0], runnerUp = scored[1];
    const brandNorm = norm(top.raw.brand || '');
    const queryContainsBrand = !!brandNorm && (` ${norm(searchText)} `).includes(` ${brandNorm} `);
    const topIsUnique = !runnerUp || top.score >= runnerUp.score * 1.35;
    const highConfidence = top.score >= 0.72 && topIsUnique && top.specificHits >= 1 && top.nameHits >= 1;
    if (highConfidence && (queryContainsBrand || top.specificHits >= 2)) {
        console.log(`[GET_PRODUCT] Strategy 4 (high-confidence name match ${(top.score * 100).toFixed(0)}%): ${top.raw.id}`);
        return { found: true, matchStrategy: `fuzzy_name (${(top.score * 100).toFixed(0)}%)`, product: buildProduct(top.raw) };
    }

    // If a brand is present, avoid polluting the clarification list with unrelated brands.
    let shortlist = scored;
    if (brandMatched.length) {
        const matchedBrands = new Set(brandMatched.map(s => s.raw.brand));
        const narrowed = scored.filter(s => matchedBrands.has(s.raw.brand));
        if (narrowed.length) shortlist = narrowed;
    }
    if (queryCategory) {
        const matchingCategory = shortlist.filter(s => s.categoryMatch);
        if (matchingCategory.length) shortlist = matchingCategory;
    }

    const candidates = shortlist.slice(0, 5).map(({ raw }) => ({
        ...formatCandidateForUI(raw),
        ingredientsAvailable: productHasIngredients(raw),
        canEvaluate: productHasIngredients(raw),
    }));
    console.log(`[GET_PRODUCT] Strategy 5 (clarification required): query="${searchText}" category=${queryCategory || 'none'} candidates=${candidates.map(c => c.id).join(', ')}`);
    return {
        found: false,
        matchStrategy: 'ambiguous',
        candidates,
        suggestion: candidates.length
            ? `لقيت منتجات قريبة من "${searchText}". اختار المنتج المقصود من النتائج؛ ما تحتاجش تكتب المعرّف. إذا ما لقيتوش، اكتب الاسم الكامل كما يظهر على العلبة.`
            : 'ما قدرتش نحدد المنتج بثقة. اكتب اسم الماركة أو الاسم الموجود على العلبة.',
    };
}
