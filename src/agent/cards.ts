/**
 * Eager card streaming, shared by the LLM path (agent.ts) and the fast lane.
 * Given the tool that just finished and what it left in turnState, emit the
 * matching UI card exactly once.
 */
import type { AgentStateTracker } from './sessionMemory';

export type CardEmitter = (type: string, data: any) => void;

export function emitCardForTool(toolName: string, t: AgentStateTracker, emit?: CardEmitter): boolean {
    if (!emit) return false;
    const x = t as any;

    switch (toolName) {
        case 'search_products':
            if (t.lastProductResults) { emit('product_results', { products: t.lastProductResults }); return true; }
            return false;
        case 'find_alternatives':
            if (t.lastProductResults) {
                emit('product_results', { products: t.lastProductResults, reference: x.lastAlternativesReference || undefined });
                return true;
            }
            return false;
        case 'evaluate_product':
            if (t.lastAnalysis) {
                emit('product_analysis', {
                    analysis: t.lastAnalysis.evaluation,
                    productId: t.lastAnalysis.productId,
                    productName: t.lastAnalysis.name,
                    brand: t.lastAnalysis.brand,
                });
                return true;
            }
            if (t.lastProductResults) { emit('product_results', { products: t.lastProductResults }); return true; }
            return false;
        case 'get_product':
            if (t.lastProduct) { emit('product', { product: t.lastProduct }); return true; }
            if (t.lastProductResults) { emit('product_results', { products: t.lastProductResults }); return true; }
            return false;
        case 'build_routine':
        case 'modify_routine':
            if (t.lastRoutine) { emit('routine', { routine: t.lastRoutine }); return true; }
            return false;
        case 'evaluate_brand':
            if (t.lastBrandEvaluation) { emit('brand_evaluation', { brandEvaluation: t.lastBrandEvaluation }); return true; }
            return false;
        case 'get_community_reviews':
            if (x.lastBrandReviews) { emit('brand_reviews', { brandReviews: x.lastBrandReviews }); return true; }
            if (x.lastReviewData) { emit('community_reviews', x.lastReviewData); return true; }
            if (t.lastProductResults) { emit('product_results', { products: t.lastProductResults }); return true; }
            return false;
        case 'compare_products':
            if (t.lastComparison) { emit('comparison', { comparison: t.lastComparison }); return true; }
            return false;
        case 'check_ingredient_list':
            if (t.lastIngredientCheck) { emit('ingredient_check', { ingredientCheck: t.lastIngredientCheck }); return true; }
            return false;
        case 'product_contains':
            if (t.lastIngredientPresence) { emit('ingredient_presence', { presence: t.lastIngredientPresence }); return true; }
            return false;
        case 'check_compatibility':
            if (t.lastCompatibility) { emit('compatibility', { compatibility: t.lastCompatibility }); return true; }
            return false;
        default:
            return false;
    }
}

/** Clears a turn tracker (used when the fast lane aborts after executing a tool). */
export function resetTurnState(t: AgentStateTracker) {
    const x = t as any;
    t.lastProductResults = null;
    t.lastProduct = null;
    t.lastAnalysis = null;
    t.lastRoutine = null;
    t.lastBrandEvaluation = null;
    t.lastReviewData = null;
    t.lastComparison = null;
    t.lastIngredientCheck = null;
    t.lastCompatibility = null;
    t.lastIngredientPresence = null;
    x.lastBrandReviews = null;
    x.lastAlternativesReference = null;
}
