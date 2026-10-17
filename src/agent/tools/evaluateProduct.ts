import { getProduct } from './getProduct';
import { evaluateProduct as wathiqEvaluate } from '../../wathiq/backendClient';
import { normalizeClaimToCatalog } from '../taxonomy';

export interface EvaluateProductArgs {
    productId?: string;
    productName?: string;
    query?: string;
    selectedClaims?: string[];
    user_profile?: {
        allergies?: string[];
        conditions?: string[];
        skinType?: string;
        scalpType?: string;
    };
}

/**
 * Convert catalog categories to the product types understood by Wathiq's logic.
 * Keep skin_serum and hair_serum distinct: the evaluation engine treats them
 * differently for leave-on/treatment and hair/scalp rules.
 */
export function normalizeProductType(rawCategory: unknown): string {
    let raw = '';
    if (rawCategory && typeof rawCategory === 'object') {
        const category = rawCategory as { id?: unknown; label?: unknown; name?: unknown };
        raw = String(category.id ?? category.label ?? category.name ?? '');
    } else if (typeof rawCategory === 'string') {
        raw = rawCategory;
    }

    const t = raw
        .normalize('NFKC')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');

    const aliases: Record<string, string> = {
        'skin_serum': 'skin_serum',
        'face_serum': 'skin_serum',
        'facial_serum': 'skin_serum',
        'serum_visage': 'skin_serum',
        'serum_peau': 'skin_serum',
        'hair_serum': 'hair_serum',
        'scalp_serum': 'hair_serum',
        'serum_capillaire': 'hair_serum',
        'hair_mask': 'mask',
        'face_mask': 'mask',
        'facial_mask': 'mask',
        'body_wash': 'cleanser',
        'body_cleanser': 'cleanser',
        'oil_blend': 'oil_blend',
        'oil_replacement': 'oil_replacement',
    };

    return aliases[t] || t || 'other';
}

/** Parse only the catalog's declared INCI list. This function does not infer missing ingredients. */
export function parseProductIngredients(raw: unknown): string[] {
    const values = typeof raw === 'string'
        ? raw.replace(/\.$/, '').split(',')
        : Array.isArray(raw)
            ? raw
            : [];

    const seen = new Set<string>();
    const ingredients: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const item = String(value).trim();
        if (item.length <= 1) continue;
        const key = item.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        ingredients.push(item);
    }
    return ingredients;
}

function cleanStringList(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const item = value.trim();
        if (!item) continue;
        const key = item.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function normalizeClaims(rawClaims: unknown): string[] {
    if (!Array.isArray(rawClaims)) return [];
    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const raw of rawClaims) {
        if (typeof raw !== 'string') continue;
        const claim = raw.trim();
        if (!claim) continue;
        const canonical = (normalizeClaimToCatalog(claim) || claim).trim();
        const key = canonical.toLocaleLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        normalized.push(canonical);
    }
    return normalized;
}

function objectArray(value: unknown): any[] {
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

/**
 * Compact, source-grounded evidence for the agent's reasoning.
 * All explanatory text is copied verbatim from Wathiq's response; no claims,
 * reasons, evidence, or citations are synthesized here. The full evaluation is
 * still returned unchanged to the product-analysis UI, which displays source notes in
 * compact, collapsed accordions and omits score calculations from the visible factor list.
 */
function buildAssistantEvidence(evaluation: any, ingredientsList: string[], selectedClaims: string[]) {
    const claims = objectArray(evaluation?.marketing_results ?? evaluation?.marketingResults).map((item: any) => ({
        claim: typeof item.claim === 'string' ? item.claim : null,
        status: typeof item.status === 'string' ? item.status : null,
        confidence: typeof item.confidence === 'string' ? item.confidence : null,
        explanation: typeof item.explanation === 'string' ? item.explanation : null,
        reasons: objectArray(item.reasons).slice(0, 8).map((reason: any) => ({
            type: typeof reason.type === 'string' ? reason.type : null,
            text: typeof reason.text === 'string' ? reason.text : null,
            tone: typeof reason.tone === 'string' ? reason.tone : null,
        })),
        userAdvice: cleanStringList(item.userAdvice).slice(0, 6),
        evidenceSections: objectArray(item.evidenceSections).slice(0, 6).map((section: any) => ({
            title: typeof section.title === 'string' ? section.title : null,
            tone: typeof section.tone === 'string' ? section.tone : null,
            items: objectArray(section.items).slice(0, 8).map((evidence: any) => ({
                id: evidence.id ?? null,
                name: typeof evidence.name === 'string' ? evidence.name : null,
                doseStatus: typeof evidence.doseStatus === 'string' ? evidence.doseStatus : null,
                concentrationDisplay: typeof evidence.concentrationDisplay === 'string' ? evidence.concentrationDisplay : null,
                dosageLabel: typeof evidence.dosageLabel === 'string' ? evidence.dosageLabel : null,
                isAdequate: typeof evidence.isAdequate === 'boolean' ? evidence.isAdequate : null,
                isUnverified: typeof evidence.isUnverified === 'boolean' ? evidence.isUnverified : null,
            })),
        })),
    }));

    const personalMatch = evaluation?.personalMatch && typeof evaluation.personalMatch === 'object'
        ? {
            status: typeof evaluation.personalMatch.status === 'string' ? evaluation.personalMatch.status : null,
            reasons: objectArray(evaluation.personalMatch.reasons).slice(0, 10).map((item: any) => ({
                type: typeof item.type === 'string' ? item.type : null,
                code: typeof item.code === 'string' ? item.code : null,
                text: typeof item.text === 'string' ? item.text : null,
            })),
        }
        : null;

    return {
        source: 'wathiq_evaluation_backend',
        oilGuardScore: evaluation.oilGuardScore,
        finalVerdict: typeof evaluation.finalVerdict === 'string' ? evaluation.finalVerdict : null,
        safetyScore: typeof evaluation.safety?.score === 'number' ? evaluation.safety.score : null,
        efficacyScore: typeof evaluation.efficacy?.score === 'number' ? evaluation.efficacy.score : null,
        // These labels are useful when an answer needs to explain the overall score.
        scoreBreakdown: objectArray(evaluation.scoreBreakdown).slice(0, 16).map((item: any) => ({
            type: typeof item.type === 'string' ? item.type : null,
            text: typeof item.text === 'string' ? item.text : null,
            value: item.value === undefined || item.value === null ? null : String(item.value),
        })),
        personalMatch,
        claimsRequested: selectedClaims,
        claimsReturned: claims.length,
        claims,
        detectedIngredients: objectArray(evaluation.detected_ingredients ?? evaluation.detectedIngredients)
            .slice(0, 24)
            .map((item: any) => ({
                id: typeof item.id === 'string' ? item.id : null,
                name: typeof item.name === 'string' ? item.name : null,
            })),
        catalogIngredientCount: ingredientsList.length,
    };
}

export async function evaluateProduct(args: EvaluateProductArgs) {
    const lookupKey = (args.productId || args.productName || args.query || '').trim();
    if (!lookupKey) {
        return { error: 'Please provide a product ID or product name to evaluate.' };
    }

    let productResult: any;
    try {
        productResult = await getProduct({
            productId: args.productId?.trim() || undefined,
            productName: args.productName?.trim() || undefined,
            query: args.query?.trim() || args.productName?.trim() || undefined,
        });
    } catch (error: any) {
        console.error('[EVALUATE] Product lookup failed:', error?.message || error);
        return { error: `Could not look up product "${lookupKey}". Please retry or provide its exact catalog ID.` };
    }

    if (!productResult?.found || !productResult?.product) {
        if (Array.isArray(productResult?.candidates) && productResult.candidates.length > 0) {
            return {
                error: `Could not determine the exact product for "${lookupKey}". Please choose one of the matching catalog products.`,
                candidates: productResult.candidates,
            };
        }
        return {
            error: productResult?.suggestion || `ما قدرتش نحدد المنتج "${lookupKey}" بثقة. اكتب اسم الماركة مع جزء من اسم المنتج، أو اختاره من النتائج إذا ظهرت. ما تحتاجش تعرف معرّف المنتج.`,
            lookupStatus: 'not_found',
            query: lookupKey,
        };
    }

    const product = productResult.product;
    const ingredientsList = parseProductIngredients(product.ingredients);

    if (ingredientsList.length === 0) {
        return {
            error: `المنتج "${product.brand || ''} ${product.name || ''}" موجود في الكتالوج لكن قائمة مكوناته غير متوفرة، لذا لا يمكن تحليل تركيبته.`.trim(),
            productId: product.id,
            name: product.name,
            brand: product.brand,
            noIngredients: true,
        };
    }

    const productType = normalizeProductType(product.category);
    const selectedClaims = normalizeClaims(
        args.selectedClaims?.length ? args.selectedClaims : product.marketingClaims,
    );

    const profile = args.user_profile || {};
    const userProfile = {
        allergies: cleanStringList(profile.allergies),
        conditions: cleanStringList(profile.conditions),
        skinType: typeof profile.skinType === 'string' && profile.skinType.trim() ? profile.skinType.trim() : undefined,
        scalpType: typeof profile.scalpType === 'string' && profile.scalpType.trim() ? profile.scalpType.trim() : undefined,
    };

    const payload = {
        ingredients_list: ingredientsList,
        user_profile: userProfile,
        selected_claims: selectedClaims,
        product_type: productType,
    };

    console.log(`[EVALUATE] Product: ${product.name} (${product.id})`);
    console.log(`[EVALUATE] product_type: "${productType}"`);
    console.log(`[EVALUATE] ingredients_count: ${ingredientsList.length}`);
    console.log(`[EVALUATE] selected_claims_count: ${selectedClaims.length}`);

    try {
        const evaluationResult: any = await wathiqEvaluate(payload);
        const score = evaluationResult?.oilGuardScore;

        if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
            console.error('[EVALUATE] Unexpected response shape/score:', JSON.stringify({
                hasScore: score !== undefined,
                score,
                verdict: evaluationResult?.finalVerdict,
            }).slice(0, 300));
            return {
                error: 'تعذّر التحقق من نتيجة التقييم التي أعادها محرك وثيق. لم أعرض درجة غير صالحة على أنها نتيجة موثوقة.',
                productId: product.id,
                name: product.name,
                brand: product.brand,
                evaluationUnavailable: true,
            };
        }

        console.log(`[EVALUATE] Done. Score: ${score}/100, Verdict: "${evaluationResult.finalVerdict || 'غير محدد'}"`);

        // Do not rebuild, summarize, or overwrite the backend response: the UI's
        // product card uses its full explanations, reasons and evidence sections.
        const evaluation = evaluationResult;
        const assistantEvidence = buildAssistantEvidence(evaluation, ingredientsList, selectedClaims);

        return {
            productId: product.id,
            name: product.name,
            brand: product.brand,
            category: productType,
            country: product.country,
            price: product.price,
            currency: product.currency,
            image: product.image,
            evaluation, // full, untouched Wathiq result for the product-analysis card
            assistantEvidence, // compact, verbatim evidence for grounded agent replies
            evaluationMeta: {
                source: 'wathiq_evaluation_backend',
                productType,
                ingredientCount: ingredientsList.length,
                requestedClaimCount: selectedClaims.length,
                returnedClaimCount: assistantEvidence.claimsReturned,
                evaluatedAt: new Date().toISOString(),
            },
        };
    } catch (error: any) {
        const detail = String(error?.message || error || 'unknown error');
        console.error('[EVALUATE] API call failed:', detail);
        return {
            error: 'تعذّر الوصول إلى محرك تقييم وثيق حاليًا. لم يتم احتساب تقييم بديل محلي أو اختلاق درجة.',
            productId: product.id,
            name: product.name,
            brand: product.brand,
            evaluationUnavailable: true,
            // Keep technical detail in server logs; do not expose internals as user-facing evidence.
        };
    }
}
