/**
 * find_actives_dupe — local (e.g. Algerian) formulations that share the KEY
 * ACTIVES of a reference product that may NOT be in the catalog (CeraVe,
 * Effaclar Duo+, The Ordinary, COSRX…), at a lower price.
 *
 * The reference's active fingerprint comes from (in order): actives the caller
 * names, a built-in fingerprint of well-known imports (references.ts), or the
 * catalog product's own ingredient list. Candidates are ranked by how many of
 * those actives they actually contain, then by price saving. Concentrations are
 * never claimed — only which actives are shared.
 */
import { getProducts } from '../../wathiq/backendClient';
import { getProduct, formatCandidateForUI } from './getProduct';
import { getSearchEntry } from './searchIndex';
import { getRepresentativePrice, getConservativeSavingPrice, isPriceKnown } from '../priceUtils';
import { normalizeCountry, normalizeCategory } from '../taxonomy';
import { matchReference } from '../references';
import { similarToDisliked } from '../cabinet';
import {
    detectActives, getConcept, resolveAllConcepts, resolveConcept, matchConceptInList, matchLiteralInList,
} from '../ingredientKnowledge';

export interface FindActivesDupeArgs {
    /** Name of the (often imported) product being replaced — free text. */
    reference_product?: string;
    /** Key actives to match, any language: ["Niacinamide", "salicylic acid", "زنك"]. */
    target_actives?: string[];
    category?: string;
    /** Prefer/limit to this country of origin ("Algeria"). */
    country?: string;
    /** What the reference costs (DZD) — candidates must be cheaper, savings are computed from it. */
    reference_price?: number;
    avoid?: string[];
    exclude_product_ids?: string[];
    disliked_lists?: string[][];
    limit?: number;
}

function toList(raw: any): string[] {
    if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.replace(/\.$/, '').split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

function violatesAvoid(list: string[], avoid: string[]): boolean {
    return avoid.some(a => {
        const c = resolveConcept(a);
        return (c ? matchConceptInList(c, list) : matchLiteralInList(a, list)).length > 0;
    });
}

export async function findActivesDupe(args: FindActivesDupeArgs) {
    // ── 1. Reference fingerprint ─────────────────────────────────────────────
    const targetKeys = new Set<string>();
    let label = args.reference_product?.trim() || '';
    let refCategory = args.category;
    let refPrice = args.reference_price && args.reference_price > 0 ? args.reference_price : undefined;
    let source: 'caller' | 'built_in' | 'catalog' = 'caller';
    let approximate = false;
    let refId: string | undefined;

    for (const a of args.target_actives || []) for (const c of resolveAllConcepts(a)) targetKeys.add(c.key);

    const fp = args.reference_product ? matchReference(args.reference_product) : null;
    if (fp) {
        fp.actives.forEach(k => targetKeys.add(k));
        label = fp.label;
        refCategory = refCategory || fp.category;
        source = 'built_in';
        approximate = true;
    }

    if (targetKeys.size === 0 && args.reference_product) {
        const r = await getProduct({ productName: args.reference_product, query: args.reference_product });
        if (r.found && r.product) {
            const actives = detectActives(r.product.ingredientList);
            actives.forEach((_, k) => targetKeys.add(k));
            label = `${r.product.brand} ${r.product.name}`.trim();
            refCategory = refCategory || String(r.product.category || '');
            refPrice = refPrice ?? (r.product.priceMin ?? r.product.priceMax ?? undefined);
            refId = r.product.id;
            source = 'catalog';
        }
    }

    // Many actives in a reference are secondary; keep it to the 4 that define it.
    const targets = [...targetKeys].slice(0, 4);
    if (targets.length === 0) {
        return {
            error: 'لم أستطع تحديد المكونات الفعالة للمنتج المرجعي. اذكر أهم مكوناته الفعالة (مثال: نياسيناميد، حمض الساليسيليك، زنك) أو اسمه بدقة.',
        };
    }

    // ── 2. Candidates ────────────────────────────────────────────────────────
    const catCanon = refCategory ? (normalizeCategory(refCategory) || refCategory).toLowerCase() : '';
    const wantedCountry = normalizeCountry(args.country)?.toLowerCase();
    const avoid = args.avoid || [];
    const excluded = new Set((args.exclude_product_ids || []).map(s => s.toLowerCase()));
    if (refId) excluded.add(refId.toLowerCase());
    const catalog = await getProducts();

    type Row = { raw: any; matched: string[]; price: number; ratio: number; unpriced?: boolean };
    const collect = (countryFilter: boolean): Row[] => {
        const rows: Row[] = [];
        for (const raw of catalog) {
            if (!raw?.id || excluded.has(String(raw.id).toLowerCase())) continue;
            const e = getSearchEntry(raw);
            if (catCanon && !(e.catCanon === catCanon || e.catCanon.includes(catCanon) || catCanon.includes(e.catCanon))) continue;
            if (countryFilter && wantedCountry && e.countryCanon !== wantedCountry) continue;

            const list = toList(raw.ingredients);
            if (list.length === 0) continue;
            if (avoid.length > 0 && violatesAvoid(list, avoid)) continue;
            if (args.disliked_lists?.length && similarToDisliked(list, args.disliked_lists)) continue;

            const price = getRepresentativePrice(raw);
            const unpriced = !isPriceKnown(raw);
            // "Cheaper than X" must be PROVABLE: the whole price range (its max) has to
            // beat the reference. Products without a price are kept apart (below).
            if (refPrice && !unpriced && !(getConservativeSavingPrice(raw) < refPrice)) continue;
            if (refPrice && unpriced) {
                // fall through: collected as unpriced match, never ranked as a saving
            }

            const actives = detectActives(list);
            const matched = targets.filter(k => actives.has(k));
            const need = Math.max(1, Math.ceil(targets.length * 0.5));
            if (matched.length < need) continue;
            rows.push({ raw, matched, price, ratio: matched.length / targets.length, unpriced });
        }
        return rows;
    };

    let rows = collect(true);
    let countryRelaxed = false;
    if (rows.length === 0 && wantedCountry) { rows = collect(false); countryRelaxed = rows.length > 0; }

    const priced = rows.filter(r => !r.unpriced);
    const unpricedRows = rows.filter(r => r.unpriced);
    const score = (r: Row) => r.ratio * 100 + (refPrice && r.price ? ((refPrice - getConservativeSavingPrice(r.raw)) / refPrice) * 20 : 0);
    priced.sort((a, b) => score(b) - score(a) || (a.price || Infinity) - (b.price || Infinity));
    unpricedRows.sort((a, b) => b.ratio - a.ratio);
    const top = priced.slice(0, Math.min(Math.max(args.limit || 4, 1), 6));
    const unpricedTop = unpricedRows.slice(0, 2);

    const targetLabels = targets.map(k => getConcept(k)?.label.ar || k);
    if (top.length === 0 && unpricedTop.length === 0) {
        return {
            error: refPrice
                ? 'لا يوجد في الكتالوج بديل أرخص يشارك المكونات الفعالة الأساسية لهذا المنتج.'
                : 'لا يوجد في الكتالوج بديل يشارك المكونات الفعالة الأساسية لهذا المنتج.',
            reference: { label, actives: targetLabels },
        };
    }

    const products = top.map(r => {
        const ui: any = formatCandidateForUI(r.raw);
        ui.sharedActives = r.matched.map(k => getConcept(k)?.label.ar || k);
        ui.sharedActiveKeys = r.matched;
        ui.missingActives = targets.filter(k => !r.matched.includes(k)).map(k => getConcept(k)?.label.ar || k);
        ui.matchRatio = Math.round(r.ratio * 100);
        const worst = getConservativeSavingPrice(r.raw);
        ui.priceSavingPct = refPrice && worst ? Math.max(0, Math.round(((refPrice - worst) / refPrice) * 100)) : null;
        return ui;
    });
    const unpricedProducts = unpricedTop.map(r => {
        const ui: any = formatCandidateForUI(r.raw);
        ui.sharedActives = r.matched.map(k => getConcept(k)?.label.ar || k);
        ui.sharedActiveKeys = r.matched;
        ui.missingActives = targets.filter(k => !r.matched.includes(k)).map(k => getConcept(k)?.label.ar || k);
        ui.matchRatio = Math.round(r.ratio * 100);
        ui.priceSavingPct = null;
        return ui;
    });

    return {
        reference: { label, actives: targetLabels, price: refPrice ?? null, source, approximate },
        products,
        // Same actives, but no price on file — can't be called "cheaper", still worth mentioning.
        unpricedMatches: unpricedProducts,
        countryRelaxed,
        note: approximate
            ? 'بصمة المكونات الفعالة للمنتج المرجعي تقريبية (من تركيبته المنشورة)؛ المقارنة تخص المكونات المشتركة فقط وليس التركيزات.'
            : undefined,
    };
}
