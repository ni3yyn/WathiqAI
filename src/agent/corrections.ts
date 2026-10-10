/**
 * Graceful corrections — "لا، قصدي الغسول تاعهم مش السيروم!" / "no, I meant their
 * cleanser". The latest statement wins unconditionally: no defending the
 * previous answer, no long apology, no clarifying question when the context
 * already pins the target down.
 */
import { foldMessage } from './intents';
import { positiveText } from './negation';
import { detectCategoryInText } from './taxonomy';
import type { SessionState } from './sessionMemory';

export interface Correction {
    isCorrection: true;
    /** Category the user says they meant (negated categories excluded). */
    category?: string;
}

const STRONG_RE = /قصدي|كنت\s*اقصد|اقصد|مقصدي|مش\s*هذا|ماشي\s*هذا|ليس\s*هذا|لم\s*اقصد|i\s*meant|i\s*mean\b|what\s*i\s*meant|not\s*(?:this|that)\s*one|i\s*was\s*(?:talking|asking)\s*about|je\s*voulais\s*dire|je\s*parlais\s*(?:du|de|des)|pas\s*(?:celui|[cç]a)|plut[oô]t\s*(?:le|la|les|l')|wrong\s*(?:product|one)/i;

export function detectCorrection(rawMessage: string, state: SessionState): Correction | null {
    if (state.turnCount <= 1) return null;                       // nothing to correct yet
    const hasContext = !!(state.lastAnalysis || state.lastProduct || state.lastBrandEvaluation
        || state.lastProductResults?.length || state.lastBrandFocus || state.productHistory?.length);
    if (!hasContext) return null;

    const folded = foldMessage(rawMessage);
    if (!STRONG_RE.test(folded)) return null;

    const category = detectCategoryInText(positiveText(rawMessage)) || undefined;
    return { isCorrection: true, category };
}

/** Brand the user was last engaged with (analysis > product > brand eval > focus > history). */
export function lastEngagedBrand(state: SessionState): string | undefined {
    return state.lastAnalysis?.brand
        || state.lastProduct?.brand
        || state.lastBrandEvaluation?.brand
        || state.lastBrandFocus?.brand
        || [...(state.productHistory || [])].reverse().find(p => p.brand)?.brand;
}

/** True when the previous turn's main action was evaluating ONE product. */
export function lastActionWasEvaluation(state: SessionState): boolean {
    const last = state.productHistory?.[state.productHistory.length - 1];
    return !!last && last.source === 'analysis' && last.turn >= state.turnCount - 1;
}
