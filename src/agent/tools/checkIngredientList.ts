/**
 * check_ingredient_list — safety/allergy analysis of a RAW ingredient list
 * pasted by the user ("هل هذه التركيبة آمنة؟ Aqua, Niacinamide, Parfum...").
 *
 * Motivation: every existing tool resolves against the Wathiq catalog first,
 * so a photo-transcribed INCI list from a product we don't sell was a dead
 * end ("لم أجد هذا المنتج في الكتالوج"). This tool sends the raw list
 * straight to the same deterministic evaluation backend, with the session
 * user-profile (allergies, skin/scalp type) attached automatically by the
 * agent wrapper — so "آمنة لي أنا؟" gets a personalized answer.
 *
 * Parsing handles the messiness of real-world pastes:
 *   - Latin commas, Arabic commas (،), semicolons, newlines, bullets
 *   - A leading product-name line ("Ingredients: ..." / "المكونات: ...")
 *   - Trailing periods, bracketed notes like "[+/- CI 77891]" are KEPT as-is
 *     (the backend sees them as unknowns rather than corrupting a neighbor)
 */

import { evaluateProduct as wathiqEvaluate } from '../../wathiq/backendClient';
import { normalizeProductType } from './evaluateProduct';

export interface CheckIngredientListArgs {
    /** The raw pasted ingredient list in any language/separator style. */
    ingredients_text: string;
    /** Optional product type so the backend applies the right rubric. */
    product_type?: string;   // serum | cleanser | sunscreen | cream | shampoo ...
    /** Optional display name so follow-ups ("هذه التركيبة") have an anchor. */
    label?: string;
    user_profile?: {
        allergies?: string[];
        conditions?: string[];
        skinType?: string;
        scalpType?: string;
    };
}

const MIN_INGREDIENTS = 2;
const MAX_INGREDIENTS = 120; // guard against accidental whole-page pastes

/**
 * Splits a raw paste into a clean INCI array. Exported for smoke tests.
 */
export function parseRawIngredientText(raw: string): string[] {
    if (!raw) return [];
    let text = String(raw);

    // Strip a leading label line: "Ingredients:", "المكونات:", "INCI:", "Composition:"
    text = text.replace(/^\s*(ingredients?|inci|المكونات|المكونات\s*الكاملة|composition|تركيبة\s*المنتج)\s*[:：]\s*/i, '');

    return text
        .split(/[,،;؛\n\r•·]+/)
        .map(s => s.replace(/\.$/, '').trim())
        .filter(s => s.length > 1 && !/^\d+$/.test(s)); // drop stray line numbers
}

export async function checkIngredientList(args: CheckIngredientListArgs) {
    const ingredients = parseRawIngredientText(args.ingredients_text || '');

    if (ingredients.length < MIN_INGREDIENTS) {
        return {
            error: 'لم أتمكن من استخراج قائمة مكونات صالحة من النص. الصق المكونات مفصولة بفواصل (مثال: Aqua, Glycerin, Niacinamide).',
        };
    }

    const truncated = ingredients.length > MAX_INGREDIENTS;
    const list = ingredients.slice(0, MAX_INGREDIENTS);

    const productType = normalizeProductType(args.product_type || 'other');
    const allergies = args.user_profile?.allergies || [];

    try {
        const evaluation: any = await wathiqEvaluate({
            ingredients_list: list,
            user_profile: {
                allergies,
                conditions: args.user_profile?.conditions || [],
                skinType: args.user_profile?.skinType,
                scalpType: args.user_profile?.scalpType,
            },
            selected_claims: [],
            product_type: productType,
        });

        if (typeof evaluation?.oilGuardScore !== 'number') {
            return {
                error: 'Evaluation API returned an unexpected response. The backend may be unavailable.',
            };
        }

        // Allergy intersection, same canonical-token aliasing as compare_products.
        const detected: string[] = (evaluation.detected_ingredients || [])
            .map((i: any) => i.name || i.id)
            .filter(Boolean);

        const allergyRegexes: RegExp[] = allergies.map(tok => {
            const t = tok.toLowerCase();
            if (/fragrance|parfum|عطر/.test(t)) return /parfum|fragrance/i;
            if (/alcohol|كحول/.test(t)) return /\balcohol\b/i;
            if (/paraben|بارابين/.test(t)) return /paraben/i;
            if (/sulfate|sulphate|كبريتات|سلفات/.test(t)) return /sulfate|sulphate/i;
            if (/silicone|سيليكون/.test(t)) return /dimethicone|silicone|cyclomethicone/i;
            return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        });
        const allergenHits = allergyRegexes.length
            ? list.filter(ing => allergyRegexes.some(re => re.test(ing)))
            : [];

        const safetyFlags: string[] = (evaluation.safety?.flags || evaluation.safety?.alerts || [])
            .map((f: any) => (typeof f === 'string' ? f : f?.message || f?.ingredient || ''))
            .filter(Boolean);

        return {
            label: args.label || 'التركيبة المُدخلة',
            ingredientCount: list.length,
            truncated,
            score: evaluation.oilGuardScore,
            verdict: evaluation.finalVerdict ?? null,
            safetyScore: evaluation.safety?.score ?? null,
            efficacyScore: evaluation.efficacy?.score ?? null,
            safetyFlags,
            allergenHits,
            detectedActives: detected.slice(0, 10),
            unknownIngredients: (evaluation.unknown_ingredients || []).slice(0, 15),
            personalizedNote: allergies.length > 0
                ? (allergenHits.length > 0
                    ? `⚠️ التركيبة تحتوي على ${allergenHits.join('، ')} — من قائمة المواد التي تتجنبها هذا الجلسة.`
                    : '✅ لم يتم رصد أي من المواد التي ذكرت أنك تتجنبها أو تتحسس منها.')
                : null,
        };
    } catch (error: any) {
        console.error('[CHECK_INGREDIENTS] API call failed:', error.message);
        return { error: `Failed to analyze ingredient list: ${error.message}` };
    }
}
