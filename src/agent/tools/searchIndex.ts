/**
 * Precomputed search entries.
 *
 * searchProducts used to run normalizeArabicText() over every product's
 * brand, name, country, full ingredient string and every tag — on EVERY
 * query, for the whole catalog (hundreds of products × multi-hundred-char
 * ingredient lists). The catalog only changes on refresh, so each product is
 * normalized exactly once, lazily, and cached on a WeakMap keyed by the
 * product object (it disappears automatically when a refreshed catalog
 * replaces the array).
 */
import { normalizeArabicText, normalizeCountry, normalizeCategory } from '../taxonomy';
import { resolvePriceBounds, PriceBounds } from '../priceUtils';

export interface SearchEntry {
    pBrand: string;
    pName: string;
    pCountry: string;
    pIng: string;               // normalized ingredient string ('' when missing)
    hasIngredients: boolean;
    pCatId: string;
    pCatLabel: string;
    countryCanon: string;       // canonical country (lowercase)
    catCanon: string;           // canonical category (lowercase)
    allTags: string[];          // lowercase raw tags
    allTagsNorm: string[];
    marketingClaimsNorm: string[];
    searchable: string;         // brand+name+cat+label+country+ing+tags (normalized)
    bounds: PriceBounds;
}

const cache = new WeakMap<object, SearchEntry>();

export function getSearchEntry(p: any): SearchEntry {
    const hit = cache.get(p);
    if (hit) return hit;

    const pBrand = normalizeArabicText(p.brand || '');
    const pName = normalizeArabicText(p.name || '');
    const pCountry = normalizeArabicText(p.country || '');
    const ingRaw = Array.isArray(p.ingredients) ? p.ingredients.join(' ') : (p.ingredients || '');
    const pIng = normalizeArabicText(ingRaw);
    const pCatId = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
    const pCatLabel = typeof p.category === 'object' ? (p.category?.label || '') : '';

    const allTags: string[] = [...(p.marketingClaims || []), ...(p.targetTypes || [])]
        .map((c: any) => (typeof c === 'string' ? c.toLowerCase() : ''));
    const allTagsNorm = allTags.map(t => normalizeArabicText(t));
    const marketingClaimsNorm = (Array.isArray(p.marketingClaims) ? p.marketingClaims : [])
        .filter((claim: any) => typeof claim === 'string')
        .map((claim: string) => normalizeArabicText(claim));

    const entry: SearchEntry = {
        pBrand,
        pName,
        pCountry,
        pIng,
        hasIngredients: !(typeof ingRaw === 'string' && ingRaw.trim().length < 3) && !!ingRaw,
        pCatId,
        pCatLabel,
        countryCanon: (normalizeCountry(p.country) || (p.country || '').trim()).toLowerCase(),
        catCanon: (normalizeCategory(pCatId) || pCatId).toLowerCase(),
        allTags,
        allTagsNorm,
        marketingClaimsNorm,
        searchable: `${pBrand} ${pName} ${normalizeArabicText(pCatId)} ${normalizeArabicText(pCatLabel)} ${pCountry} ${pIng} ${allTagsNorm.join(' ')}`,
        bounds: resolvePriceBounds(p.price),
    };
    cache.set(p, entry);
    return entry;
}
