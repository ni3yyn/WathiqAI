/**
 * compare_products — side-by-side comparison of 2–4 catalog products.
 *
 * Motivation: "compare the first one with the CeraVe one", "قارن بينهما",
 * "lequel est mieux?" used to force the model to call evaluate_product twice
 * and improvise a comparison inside the strict 2–3 sentence budget — the
 * verdict was often truncated and no card existed to render. This tool makes
 * comparison a first-class, deterministic operation:
 *
 *   1. Resolves each requested product by ID or name (reusing getProduct's
 *      exact -> fuzzy -> ambiguous machinery).
 *   2. Evaluates every product through the SAME deterministic backend so
 *      scores are comparable (same rubric, same user profile).
 *   3. Computes per-dimension winners (overall, safety, efficacy, price)
 *      with explicit Arabic reasons — no LLM arithmetic involved.
 *   4. Surfaces shared vs. diverging key ingredients so the model can answer
 *      "why did the second one win?" honestly.
 *
 * Session fallbacks (empty/omitted product list -> last two discussed
 * products) live in the agent.ts wrapper, keeping this function pure.
 */

import { getProduct } from './getProduct';
import { evaluateProduct as wathiqEvaluate } from '../../wathiq/backendClient';
import { normalizeProductType } from './evaluateProduct';
import { parseIngredients } from './evaluateBrand';
import { normalizeClaimToCatalog } from '../taxonomy';
import { getRepresentativePrice, resolvePriceBounds } from '../priceUtils';

export interface CompareProductsArgs {
    /** 2–4 products to compare. id preferred; name alone also works. */
    products: Array<{ id?: string; name?: string }>;
    /** Optional: focus the verdict on one concern ("حب الشباب", "hydration"). */
    focus?: string;
    user_profile?: {
        allergies?: string[];
        conditions?: string[];
        skinType?: string;
        scalpType?: string;
    };
}

const MAX_COMPARE = 4;
const MIN_COMPARE = 2;

interface ComparedEntry {
    id: string;
    brand: string;
    name: string;
    price: number;
    priceDisplay: string;
    currency: string;
    category: string;
    score: number | null;          // oilGuardScore 0-100
    safetyScore: number | null;
    efficacyScore: number | null;
    verdict: string | null;
    keyIngredients: string[];      // detected actives, trimmed
    allergenHits: string[];        // intersect with user_profile.allergies
    claimsVerified: number;
    claimsTotal: number;
    evalError?: string;
}

async function evaluateOne(product: any, args: CompareProductsArgs): Promise<ComparedEntry> {
    const ingredientsList = parseIngredients(product.ingredients);
    const base: ComparedEntry = {
        id: product.id,
        brand: product.brand,
        name: product.name,
        price: getRepresentativePrice(product),
        priceDisplay: (() => {
            const b = resolvePriceBounds(product.price);
            return b.min !== undefined ? (b.min === b.max ? `${b.min}` : `${b.min} – ${b.max}`) : 'غير معروف';
        })(),
        currency: resolvePriceBounds(product.price).currency,
        category: normalizeProductType(product.category),
        score: null,
        safetyScore: null,
        efficacyScore: null,
        verdict: null,
        keyIngredients: [],
        allergenHits: [],
        claimsVerified: 0,
        claimsTotal: 0,
    };

    if (ingredientsList.length === 0) {
        base.evalError = 'لا تتوفر قائمة مكونات قابلة للتحليل لهذا المنتج.';
        return base;
    }

    const selectedClaims: string[] = (product.marketingClaims || [])
        .map((c: any) => normalizeClaimToCatalog(String(c)) || String(c))
        .filter((c: string, i: number, arr: string[]) => arr.indexOf(c) === i);

    try {
        const evaluation: any = await wathiqEvaluate({
            ingredients_list: ingredientsList,
            user_profile: {
                allergies: args.user_profile?.allergies || [],
                conditions: args.user_profile?.conditions || [],
                skinType: args.user_profile?.skinType,
                scalpType: args.user_profile?.scalpType,
            },
            selected_claims: selectedClaims,
            product_type: base.category,
        });

        if (typeof evaluation?.oilGuardScore !== 'number') {
            base.evalError = 'الخادم أعاد استجابة غير متوقعة أثناء التقييم.';
            return base;
        }

        base.score = evaluation.oilGuardScore;
        base.safetyScore = evaluation.safety?.score ?? null;
        base.efficacyScore = evaluation.efficacy?.score ?? null;
        base.verdict = evaluation.finalVerdict ?? null;
        base.keyIngredients = (evaluation.detected_ingredients || [])
            .slice(0, 8)
            .map((i: any) => i.name || i.id)
            .filter(Boolean);

        // Honest allergen surfacing: intersect the product's INCI list with
        // the session's allergy tokens (the same canonical tokens the rest of
        // the pipeline uses: fragrance/alcohol/paraben/sulfate/silicone/...).
        const allergyTokens = (args.user_profile?.allergies || []).map(a => a.toLowerCase());
        if (allergyTokens.length > 0) {
            const aliasMap: RegExp[][] = allergyTokens.map(tok => {
                if (/fragrance|parfum|عطر/.test(tok)) return [/^parfum$/i, /fragrance/i];
                if (/alcohol|كحول/.test(tok)) return [/\balcohol\b/i];
                if (/paraben|بارابين/.test(tok)) return [/paraben/i];
                if (/sulfate|sulphate|كبريتات|سلفات/.test(tok)) return [/sulfate|sulphate/i];
                if (/silicone|سيليكون/.test(tok)) return [/dimethicone|silicone|cyclomethicone/i];
                return [new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')];
            });
            base.allergenHits = ingredientsList.filter(ing =>
                aliasMap.some(res => res.some(re => re.test(ing)))
            );
        }

        const claims = evaluation.marketing_results || [];
        base.claimsTotal = claims.length;
        base.claimsVerified = claims.filter((c: any) =>
            /verified|supported|مؤكد|مدعوم/i.test(String(c.status || ''))
        ).length;
    } catch (e: any) {
        base.evalError = `فشل التقييم: ${e.message}`;
    }
    return base;
}

/** "Venus Sunscreen SPF50+", not "Venus Venus Sunscreen SPF50+". */
function displayName(brand: string, name: string): string {
    if (!brand) return name;
    return name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`;
}

/** Pick the winner index for a numeric dimension; -1 on tie or insufficient data. */
function winnerOf(entries: ComparedEntry[], pick: (e: ComparedEntry) => number | null, higherIsBetter = true): number {
    let best = -1;
    let bestVal = higherIsBetter ? -Infinity : Infinity;
    let tied = false;
    entries.forEach((e, i) => {
        const v = pick(e);
        if (v === null || v === undefined || isNaN(v as number)) return;
        const better = higherIsBetter ? v > bestVal : v < bestVal;
        if (better) { bestVal = v; best = i; tied = false; }
        else if (v === bestVal) tied = true;
    });
    return tied ? -1 : best;
}

export async function compareProducts(args: CompareProductsArgs) {
    const requested = (args.products || []).filter(p => p && (p.id || p.name)).slice(0, MAX_COMPARE);
    if (requested.length < MIN_COMPARE) {
        return { error: `المقارنة تتطلب منتجين على الأقل (استلمت ${requested.length}).` };
    }

    // ── 1. Resolve every product ──
    const resolved: any[] = [];
    const unresolved: string[] = [];
    const ambiguous: string[] = [];
    for (const r of requested) {
        const res = await getProduct({ productId: r.id, productName: r.name, query: r.name });
        if (res.found && res.product) {
            resolved.push(res.product);
        } else if (res.candidates && res.candidates.length > 0) {
            ambiguous.push(`${r.name || r.id} → ${res.candidates.map(c => `${c.brand} ${c.name}`).join(' / ')}`);
        } else {
            unresolved.push(r.name || r.id || '?');
        }
    }

    if (resolved.length < MIN_COMPARE) {
        return {
            error: `لم أتمكن من حسم منتجين صالحين للمقارنة.` +
                (unresolved.length ? ` غير موجود: ${unresolved.join('، ')}.` : '') +
                (ambiguous.length ? ` غامض (حدد الدقيق): ${ambiguous.join('؛ ')}.` : ''),
            resolvedCount: resolved.length,
        };
    }

    // ── 2. Evaluate all in parallel (same rubric => comparable scores) ──
    const entries = await Promise.all(resolved.map(p => evaluateOne(p, args)));

    // ── 3. Deterministic winners per dimension ──
    const scored = entries.filter(e => e.score !== null);
    const winners: Record<string, { id?: string; label: string }> = {};

    const wOverall = winnerOf(entries, e => e.score);
    if (wOverall >= 0) winners.overall = { id: entries[wOverall].id, label: displayName(entries[wOverall].brand, entries[wOverall].name) };

    const wSafety = winnerOf(entries, e => e.safetyScore);
    if (wSafety >= 0) winners.safety = { id: entries[wSafety].id, label: displayName(entries[wSafety].brand, entries[wSafety].name) };

    const wEfficacy = winnerOf(entries, e => e.efficacyScore);
    if (wEfficacy >= 0) winners.efficacy = { id: entries[wEfficacy].id, label: displayName(entries[wEfficacy].brand, entries[wEfficacy].name) };

    const priced = entries.filter(e => e.price > 0);
    if (priced.length === entries.length) {
        const wPrice = winnerOf(entries, e => (e.price > 0 ? e.price : null), false);
        if (wPrice >= 0) winners.cheapest = { id: entries[wPrice].id, label: displayName(entries[wPrice].brand, entries[wPrice].name) };
    }

    // ── 4. Shared vs. diverging actives (for "why?" follow-ups) ──
    const ingredientSets = entries.map(e => new Set(e.keyIngredients.map(k => k.toLowerCase())));
    const sharedActives = ingredientSets.length > 0
        ? [...ingredientSets[0]].filter(k => ingredientSets.every(s => s.has(k)))
        : [];

    // ── 5. Human-readable Arabic verdict line (deterministic, no guessing) ──
    const summaryParts: string[] = [];
    if (winners.overall && scored.length >= MIN_COMPARE) {
        const wIdx = entries.findIndex(e => e.id === winners.overall.id);
        const runner = scored
            .filter(e => e.id !== winners.overall.id)
            .sort((a, b) => (b.score! - a.score!))[0];
        const margin = runner && runner.score !== null ? Math.abs(entries[wIdx].score! - runner.score) : 0;
        summaryParts.push(
            margin <= 3
                ? (entries.length > 2
                    ? `المنتجات متقاربة جداً في التقييم العام (فارق ${margin} نقاط فقط بين الأول والثاني).`
                    : `المنتجان متقاربان جداً في التقييم العام (فارق ${margin} نقاط فقط).`)
                : `${winners.overall.label} يتفوق إجمالاً بفارق ${margin} نقطة عن أقرب منافس.`
        );
    }
    const allergenNotes = entries.filter(e => e.allergenHits.length > 0);
    if (allergenNotes.length > 0) {
        summaryParts.push(
            allergenNotes.map(e => `⚠️ "${displayName(e.brand, e.name)}" يحتوي على ${e.allergenHits.join('، ')} (من قائمة تجنّبك)`).join('؛ ')
        );
    }

    return {
        comparedCount: entries.length,
        focus: args.focus || null,
        entries: entries.map(e => ({
            id: e.id,
            brand: e.brand,
            name: e.name,
            price: e.price > 0 ? `${e.priceDisplay} ${e.currency}` : 'غير معروف',
            category: e.category,
            score: e.score,
            safetyScore: e.safetyScore,
            efficacyScore: e.efficacyScore,
            verdict: e.verdict,
            keyIngredients: e.keyIngredients,
            allergenHits: e.allergenHits,
            claimsHonesty: e.claimsTotal > 0 ? `${e.claimsVerified}/${e.claimsTotal}` : null,
            evalError: e.evalError || null,
        })),
        winners,
        sharedActives,
        summary: summaryParts.join(' ') || null,
        unresolved: unresolved.length ? unresolved : undefined,
        ambiguous: ambiguous.length ? ambiguous : undefined,
    };
}
