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

// Normalizes category IDs to match what the backend's product_type expects
// Exported so evaluateBrand.ts uses the exact same category->product_type
// mapping instead of a second copy that could drift out of sync.
export function normalizeProductType(rawCategory: any): string {
    const raw = typeof rawCategory === 'object'
        ? (rawCategory?.id || '')
        : (typeof rawCategory === 'string' ? rawCategory : '');

    const t = raw.toLowerCase().trim();

    if (t === 'skin_serum' || t === 'hair_serum') return 'serum';
    if (t === 'hair_mask' || t === 'face_mask') return 'mask';
    if (t === 'body_wash') return 'cleanser';
    if (t === 'oil_blend' || t === 'oil_replacement') return 'oil';

    return t || 'other';
}

export async function evaluateProduct(args: EvaluateProductArgs) {
    // 1. Retrieve the real product by ID, name, or search query
    const lookupKey = args.productId || args.productName || args.query;
    if (!lookupKey) {
        return { error: 'Please provide a product ID or product name to evaluate.' };
    }

    const productResult = await getProduct({
        productId: args.productId,
        productName: args.productName,
        query: args.query || args.productName
    });

    if (!productResult.found || !productResult.product) {
        if (productResult.candidates && productResult.candidates.length > 0) {
            const list = productResult.candidates.map(c => `${c.brand} - ${c.name} (${c.id})`).join('\n');
            return { 
                error: `Could not determine the exact product for "${lookupKey}". Candidates found:\n${list}` 
            };
        }
        return { error: `Product not found: "${lookupKey}". Please specify a known product name or ID.` };
    }

    const product = productResult.product;

    // 2. Parse ingredient list into a clean string array
    let ingredientsList: string[] = [];
    if (typeof product.ingredients === 'string') {
        ingredientsList = product.ingredients
            .replace(/\.$/, '')
            .split(',')
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 1);
    } else if (Array.isArray(product.ingredients)) {
        ingredientsList = product.ingredients.map((s: any) => String(s).trim()).filter((s: string) => s.length > 1);
    }

    // 3. Normalize product type for the backend
    const productType = normalizeProductType(product.category);

    // 4. Determine claims to evaluate and normalize them to canonical catalog claims
    const rawClaims = args.selectedClaims?.length
        ? args.selectedClaims
        : (product.marketingClaims || []);

    const selectedClaims: string[] = rawClaims
        .map((c: any) => normalizeClaimToCatalog(String(c)) || String(c))
        .filter((c: string, idx: number, arr: string[]) => arr.indexOf(c) === idx);

    // 5. Build payload
    const payload = {
        ingredients_list: ingredientsList,
        user_profile: {
            allergies: args.user_profile?.allergies || [],
            conditions: args.user_profile?.conditions || [],
            skinType: args.user_profile?.skinType,
            scalpType: args.user_profile?.scalpType,
        },
        selected_claims: selectedClaims,
        product_type: productType
    };

    console.log(`[EVALUATE] Product: ${product.name} (${product.id})`);
    console.log(`[EVALUATE] product_type: "${productType}"`);
    console.log(`[EVALUATE] ingredients_count: ${ingredientsList.length}`);
    console.log(`[EVALUATE] selected_claims: ${JSON.stringify(selectedClaims)}`);

    // 6. Call the Wathiq evaluation API
    try {
        const evaluationResult = await wathiqEvaluate(payload);

        if (typeof evaluationResult?.oilGuardScore !== 'number') {
            console.error('[EVALUATE] Unexpected response shape:', JSON.stringify(evaluationResult).slice(0, 300));
            return {
                error: 'Evaluation API returned an unexpected response. The backend may be unavailable or the product type is not supported.',
                rawResponse: evaluationResult
            };
        }

        console.log(`[EVALUATE] Done. Score: ${evaluationResult.oilGuardScore}/100, Verdict: "${evaluationResult.finalVerdict}"`);

        return {
            productId: product.id,
            name: product.name,
            brand: product.brand,
            category: productType,
            country: product.country,
            price: product.price,
            currency: product.currency,
            image: product.image,
            evaluation: evaluationResult
        };
    } catch (error: any) {
        console.error('[EVALUATE] API call failed:', error.message);
        return { error: `Failed to evaluate product: ${error.message}` };
    }
}