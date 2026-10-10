/**
 * find_alternatives — real substitutes/dupes for a catalog product.
 *
 * The old "cheaper alternative" path only filtered by category + price, so a
 * "cheaper serum" often shared no actives with the original. This ranks
 * same-category candidates by SHARED KEY ACTIVES (niacinamide, zinc, salicylic
 * acid…), then price saving, and reports WHY each one matches.
 */
import { getProducts } from '../../wathiq/backendClient';
import { getProduct, formatCandidateForUI } from './getProduct';
import { getSearchEntry } from './searchIndex';
import { getRepresentativePrice } from '../priceUtils';
import { normalizeCountry, normalizeCategory } from '../taxonomy';
import { detectActives, getConcept, resolveConcept, matchConceptInList, matchLiteralInList } from '../ingredientKnowledge';

export interface FindAlternativesArgs {
    productId?: string;
    productName?: string;
    /** Only products strictly cheaper than the reference. */
    cheaper_only?: boolean;
    /** Prefer/limit to a country of origin. */
    country?: string;
    /** Allergies / avoided ingredients — hard filter. */
    avoid?: string[];
    exclude_product_ids?: string[];
    limit?: number;
}

function toList(raw: any): string[] {
    if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.replace(/\.$/, '').split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

function violatesAvoid(list: string[], avoid: string[]): boolean {
    for (const a of avoid) {
        const c = resolveConcept(a);
        const hits = c ? matchConceptInList(c, list) : matchLiteralInList(a, list);
        if (hits.length) return true;
    }
    return false;
}

export async function findAlternatives(args: FindAlternativesArgs) {
    const lookup = await getProduct({ productId: args.productId, productName: args.productName, query: args.productName });
    if (!lookup.found || !lookup.product) {
        if (lookup.candidates?.length) {
            return { error: 'منتجات متعددة تطابق الاسم — حدّد المنتج المقصود.', candidates: lookup.candidates };
        }
        return { error: 'لم أجد المنتج المرجعي في الكتالوج.' };
    }

    const ref = lookup.product;
    const refList = ref.ingredientList;
    const refActives = detectActives(refList);
    const refPrice = ref.priceMin ?? ref.priceMax ?? 0;
    const refCat = (normalizeCategory(String(ref.category || '')) || String(ref.category || '')).toLowerCase();
    const refClaims = new Set((ref.marketingClaims || []).map((c: string) => c.trim()));
    const wantedCountry = normalizeCountry(args.country)?.toLowerCase();
    const avoid = args.avoid || [];
    const excluded = new Set((args.exclude_product_ids || []).map(s => s.toLowerCase()));
    excluded.add(String(ref.id).toLowerCase());

    const catalog = await getProducts();

    const scored: Array<{ raw: any; score: number; shared: string[]; price: number; sharedClaims: number }> = [];
    for (const raw of catalog) {
        if (!raw?.id || excluded.has(String(raw.id).toLowerCase())) continue;
        const e = getSearchEntry(raw);
        if (!(e.catCanon === refCat || e.catCanon.includes(refCat) || refCat.includes(e.catCanon))) continue;

        const list = toList(raw.ingredients);
        if (avoid.length > 0) {
            if (list.length === 0) continue;              // can't verify → can't recommend
            if (violatesAvoid(list, avoid)) continue;
        }

        const price = getRepresentativePrice(raw);
        if (args.cheaper_only && refPrice > 0 && !(price > 0 && price < refPrice)) continue;

        const actives = detectActives(list);
        const shared = [...refActives.keys()].filter(k => actives.has(k));
        const sharedClaims = (raw.marketingClaims || []).filter((c: string) => refClaims.has(String(c).trim())).length;

        let score = 0;
        if (refActives.size > 0) {
            const union = new Set([...refActives.keys(), ...actives.keys()]).size || 1;
            score += shared.length * 12 + (shared.length / union) * 20;
        }
        score += sharedClaims * 4;
        if (refPrice > 0 && price > 0 && price < refPrice) score += Math.min(10, ((refPrice - price) / refPrice) * 20);
        if (wantedCountry && e.countryCanon === wantedCountry) score += 6;

        if (score > 0) scored.push({ raw, score, shared, price, sharedClaims });
    }

    scored.sort((a, b) => (b.score - a.score) || ((a.price || Infinity) - (b.price || Infinity)));
    const limit = Math.min(Math.max(args.limit || 4, 1), 8);
    const top = scored.slice(0, limit);

    if (top.length === 0) {
        return {
            error: args.cheaper_only
                ? 'لا يوجد في الكتالوج بديل أرخص من نفس الفئة يشارك مكوناته الفعالة.'
                : 'لم أجد بدائل مناسبة من نفس الفئة في الكتالوج.',
            reference: { id: ref.id, brand: ref.brand, name: ref.name },
        };
    }

    const products = top.map(t => {
        const ui: any = formatCandidateForUI(t.raw);
        const labels = t.shared.map(k => getConcept(k)?.label.ar || k);
        const diffPct = refPrice > 0 && t.price > 0 ? Math.round(((refPrice - t.price) / refPrice) * 100) : null;
        ui.sharedActives = labels;
        ui.sharedActiveKeys = t.shared;
        ui.priceDiffPct = diffPct;                         // +N = cheaper by N%, −N = pricier
        ui.matchStrength = refActives.size === 0 ? 'claims_only'
            : t.shared.length === refActives.size ? 'all_actives'
            : t.shared.length > 0 ? 'some_actives' : 'claims_only';
        return ui;
    });

    return {
        reference: {
            id: ref.id,
            brand: ref.brand,
            name: ref.name,
            price: ref.price,
            currency: ref.currency,
            actives: [...refActives.keys()].map(k => getConcept(k)?.label.ar || k),
        },
        products,
        weakMatch: products.every((p: any) => p.matchStrength === 'claims_only'),
        note: refActives.size === 0
            ? 'المنتج المرجعي لا يحتوي مكونات فعالة معروفة للنظام؛ تم الترتيب حسب الادعاءات التسويقية المشتركة والسعر.'
            : undefined,
    };
}
