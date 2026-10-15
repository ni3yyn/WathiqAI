/**
 * Life-stage modes: pregnancy / breastfeeding, and teens.
 *
 * Deterministic effects (not just prompt text):
 *   pregnancy / breastfeeding → retinoids and hydroquinone are added to the
 *       session's avoid list, so search, routines, dupes, alternatives and
 *       cabinet suggestions all exclude them automatically.
 *   teen → gentler guidance + induction schedules forced to the gentle ramp.
 * The stage lives in the SESSION only (it is health-adjacent and temporary —
 * never written to long-term memory).
 */
import { foldMessage } from './intents';
import { isPhraseNegated } from './negation';
import type { UserProfile } from './sessionMemory';

export type LifeStage = 'pregnancy' | 'teen';

const PREGNANT_RE = /حامل|حاملة|حمل\b|أرضع|ارضع|رضاعة|ترضيع|pregnan|enceinte|grossesse|breastfeed|breast-feed|allait|allaite|nursing\s*mother/;
const NOT_PREGNANT_RE = /ما\s*عدتش\s*حامل|ولدت|خلصت\s*الرضاعة|not\s*pregnant\s*anymore|no\s*longer\s*pregnant|plus\s*enceinte|j'ai\s*accouch|stopped\s*breastfeeding/;
const AGE_RE = /(?:عمري|عندي)\s*(\d{1,2})\s*(?:سنة|عام|سنوات)?|i'?m\s*(\d{1,2})(?:\s*(?:years?\s*old|yo|y\/o))?|i\s*am\s*(\d{1,2})|j'?ai\s*(\d{1,2})\s*ans/;
const TEEN_WORD = /مراهق|مراهقة|teen(?:ager)?|adolescent/;

export interface StageDetection { stage: LifeStage | null; clear?: boolean; age?: number }

export function detectLifeStage(message: string): StageDetection {
    const f = foldMessage(message);
    if (!f) return { stage: null };
    if (NOT_PREGNANT_RE.test(f)) return { stage: null, clear: true };
    if (PREGNANT_RE.test(f) && !isPhraseNegated(message, /حامل|pregnan|enceinte/)) return { stage: 'pregnancy' };
    const m = f.match(AGE_RE);
    const age = m ? parseInt(m[1] || m[2] || m[3] || m[4], 10) : undefined;
    if (age !== undefined && age >= 8 && age < 18) return { stage: 'teen', age };
    if (TEEN_WORD.test(f)) return { stage: 'teen' };
    return { stage: null };
}

/** Tokens added to the avoid list while pregnant/breastfeeding (resolved by the concept matcher). */
export const PREGNANCY_AVOID = ['retinol', 'hydroquinone'];

export function applyLifeStage(profile: UserProfile & { lifeStage?: LifeStage; autoAvoid?: string[] }, det: StageDetection): boolean {
    let changed = false;
    if (det.clear) {
        if (profile.lifeStage === 'pregnancy') {
            profile.avoidIngredients = profile.avoidIngredients.filter(a => !(profile.autoAvoid || []).includes(a));
            profile.autoAvoid = [];
            profile.lifeStage = undefined;
            changed = true;
        }
        return changed;
    }
    if (det.stage === 'pregnancy' && profile.lifeStage !== 'pregnancy') {
        profile.lifeStage = 'pregnancy';
        const add = PREGNANCY_AVOID.filter(a => !profile.avoidIngredients.includes(a));
        profile.avoidIngredients = [...profile.avoidIngredients, ...add];
        profile.autoAvoid = [...(profile.autoAvoid || []), ...add];
        changed = true;
    } else if (det.stage === 'teen' && profile.lifeStage !== 'teen' && profile.lifeStage !== 'pregnancy') {
        profile.lifeStage = 'teen';
        changed = true;
    }
    return changed;
}

export function buildLifeStageContext(profile: { lifeStage?: LifeStage }): string | null {
    if (profile.lifeStage === 'pregnancy') {
        return '[Context: Life stage=PREGNANCY/BREASTFEEDING. Retinoids and hydroquinone are already excluded from every tool. Prefer gentle, fragrance-free products and mineral sunscreen; avoid high-strength peels and essential-oil-heavy products; never recommend a retinoid; end skincare-active advice with a short "confirm with your doctor" line.]';
    }
    if (profile.lifeStage === 'teen') {
        return '[Context: Life stage=TEEN (under 18). Keep routines to 3 simple steps (gentle cleanser, light moisturizer, daily sunscreen), no anti-aging products or retinoids unless a doctor advised them, strong acids only with caution and low frequency; for persistent or painful acne suggest seeing a dermatologist; be encouraging and non-judgmental.]';
    }
    return null;
}
