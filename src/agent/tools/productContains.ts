/**
 * product_contains — "does it contain parfum / alcohol / retinol…?"
 *
 * Motivation: get_product only hands the model the FIRST 15 INCI entries, so
 * "هل فيه عطر؟" could answer "no" when Parfum was ingredient #22. This tool
 * checks the FULL list deterministically (with multilingual aliases and
 * fatty-alcohol exclusion), reports the position of every hit, and flags
 * anything on the user's avoid/allergy list.
 */
import { getProduct } from './getProduct';
import {
    resolveConcept, matchConceptInList, matchLiteralInList, IngredientMatch,
} from '../ingredientKnowledge';

export interface ProductContainsArgs {
    productId?: string;
    productName?: string;
    /** One or several ingredients, any language: "عطر", "alcohol و parfum", "retinol". */
    ingredient: string;
    /** Session allergies/avoid list — used only to flag hits. */
    avoid?: string[];
}

export interface ContainsCheck {
    query: string;
    concept: string | null;       // canonical concept key when recognized
    conceptLabel: string | null;  // Arabic label
    present: boolean;
    matches: IngredientMatch[];
    onAvoidList: boolean;
}

const SPLIT_RE = /\s*(?:،|,|;|\/|\s+and\s+|\s+et\s+|\s+or\s+|\s+ou\s+|\s+و\s+|\s+و(?=[A-Za-z])|\s+أو\s+|\s+او\s+)\s*/i;

export function splitIngredientQueries(raw: string): string[] {
    return String(raw || '')
        .split(SPLIT_RE)
        .map(s => s.trim())
        .filter(s => s.length > 1)
        .slice(0, 6);
}

export async function productContains(args: ProductContainsArgs) {
    const queries = splitIngredientQueries(args.ingredient);
    if (queries.length === 0) {
        return { error: 'لم أفهم أي مكوّن تقصد. اذكر اسم المكوّن (مثال: عطر، كحول، ريتينول، Niacinamide).' };
    }

    const lookup = await getProduct({
        productId: args.productId,
        productName: args.productName,
        query: args.productName,
    });

    if (!lookup.found || !lookup.product) {
        if (lookup.candidates?.length) {
            return {
                error: 'منتجات متعددة تطابق الاسم — اختر واحداً.',
                candidates: lookup.candidates,
            };
        }
        return { error: 'لم أجد هذا المنتج في الكتالوج.' };
    }

    const p = lookup.product;
    const list = p.ingredientList;
    if (!list || list.length === 0) {
        return {
            error: `المنتج "${p.brand} ${p.name}" موجود لكن قائمة مكوناته غير متوفرة، لذا لا أستطيع التأكد.`,
            noIngredients: true,
            productId: p.id,
        };
    }

    const avoidKeys = new Set(
        (args.avoid || []).map(a => resolveConcept(a)?.key).filter((k): k is string => !!k)
    );
    const avoidLiterals = (args.avoid || []).map(a => a.toLowerCase());

    const checks: ContainsCheck[] = queries.map(q => {
        const concept = resolveConcept(q);
        const matches = concept ? matchConceptInList(concept, list) : matchLiteralInList(q, list);
        const onAvoid = (!!concept && avoidKeys.has(concept.key))
            || avoidLiterals.some(a => a.length > 2 && q.toLowerCase().includes(a));
        return {
            query: q,
            concept: concept?.key ?? null,
            conceptLabel: concept?.label.ar ?? null,
            present: matches.length > 0,
            matches,
            onAvoidList: onAvoid && matches.length > 0,
        };
    });

    return {
        productId: p.id,
        brand: p.brand,
        name: p.name,
        ingredientCount: list.length,
        checks,
        anyAvoidHit: checks.some(c => c.onAvoidList),
    };
}
