/**
 * Active mission — goal memory on top of entity memory.
 *
 * Entity memory knows WHAT was shown (products, brands, profile). The mission
 * knows what the user is trying to ACHIEVE ("an acne routine under 4000 DZD"),
 * so a side question ("what does salicylic acid do?") is answered and then
 * bridged back instead of silently abandoning the goal.
 *
 * A mission is created/updated by goal-bearing turns (a routine was built, or a
 * concern/budget search ran), survives detours, is closed by a closing message
 * ("شكراً", "that's all") and silently expires after MISSION_TTL_TURNS turns.
 */
import type { SessionState, AgentStateTracker } from './sessionMemory';
import { foldMessage } from './intents';
import { findNegatedCategories } from './negation';

export interface Mission {
    kind: 'routine' | 'search';
    concern?: string;
    budget?: number;
    category?: string;
    country?: string;
    excluded?: string[];       // categories the user does NOT want
    summary: string;
    startedTurn: number;
    touchedTurn: number;
}

export const MISSION_TTL_TURNS = 8;

const CLOSING_RE = /^\s*(?:شكرا|شكراً|بارك\s*الله\s*فيك|يعطيك\s*الصحة|صح\s*عيدك|خلاص|يكفي|تمام\s*شكرا|merci|c'est\s*tout|ça\s*suffit|thanks?|thank\s*you|that'?s\s*all|that\s*is\s*all|no\s*more|i'?m\s*done)[\s.!،؟?]*(?:جزيلا|beaucoup|a\s*lot|so\s*much)?[\s.!،؟?]*$/i;

export function isClosingMessage(raw: string): boolean {
    const m = foldMessage(raw);
    return m.length > 0 && m.split(' ').length <= 5 && CLOSING_RE.test(m);
}

export function activeMission(state: SessionState): Mission | null {
    const m = state.mission;
    if (!m) return null;
    if (state.turnCount - m.touchedTurn > MISSION_TTL_TURNS) return null;
    return m;
}

function summarize(m: Omit<Mission, 'summary'>): string {
    const parts: string[] = [m.kind];
    if (m.concern) parts.push(m.concern);
    if (m.category) parts.push(`category=${m.category}`);
    if (m.budget) parts.push(`budget<=${m.budget}`);
    if (m.country) parts.push(`country=${m.country}`);
    if (m.excluded?.length) parts.push(`without ${m.excluded.join('/')}`);
    return parts.join(', ');
}

/**
 * Called once at the end of every turn (fast lane or LLM path).
 * `turn` is this turn's tracker — it tells us which goal-bearing tools ran.
 */
export function updateMissionAfterTurn(state: SessionState, message: string, turn: AgentStateTracker): void {
    if (isClosingMessage(message)) { state.mission = null; return; }

    const t = state.turnCount;
    const prev = activeMission(state);
    const negCats = findNegatedCategories(message);

    // 1. A routine was built or edited → routine mission (carries concern + budget).
    if (turn.lastRoutine) {
        const r = turn.lastRoutine;
        const base = {
            kind: 'routine' as const,
            concern: r.concern as string | undefined,
            budget: (r.maxBudget as number | undefined) || undefined,
            country: state.profile.country,
            excluded: Array.from(new Set([...(prev?.kind === 'routine' ? prev.excluded || [] : []), ...negCats])),
            startedTurn: prev && prev.kind === 'routine' && prev.concern === r.concern ? prev.startedTurn : t,
            touchedTurn: t,
        };
        state.mission = { ...base, summary: summarize(base) };
        return;
    }

    // 2. A fresh concern/budget search (not an alternatives lookup, not a single product).
    const isAlternatives = !!(turn as any).lastAlternativesReference;
    if (turn.lastProductResults && !turn.lastProduct && !turn.lastAnalysis && !isAlternatives && state.lastSearchArgs) {
        const a = state.lastSearchArgs;
        const concern = a.skin_type || a.hair_type || (Array.isArray(a.marketing_claims) ? a.marketing_claims.join('، ') : a.marketing_claims) || a.active_ingredient || undefined;
        const hasGoal = !!(concern || a.max_price || a.query);
        if (hasGoal) {
            // A routine mission outlives individual searches inside it.
            if (prev?.kind === 'routine') { prev.touchedTurn = t; return; }
            const base = {
                kind: 'search' as const,
                concern: concern || a.query,
                budget: a.max_price || prev?.budget,
                category: a.category,
                country: a.country || state.profile.country,
                excluded: negCats,
                startedTurn: prev?.kind === 'search' ? prev.startedTurn : t,
                touchedTurn: t,
            };
            state.mission = { ...base, summary: summarize(base) };
            return;
        }
    }

    // 3. Anything else (detour, evaluation, comparison…) leaves the mission untouched.
}

/**
 * The context line handed to the model. `detour` = this message has no tool
 * intent (a side question), so the model must bridge back after answering.
 */
export function buildMissionContext(state: SessionState, detour: boolean): string | null {
    const m = activeMission(state);
    if (!m) return null;
    const base = `[Context: Active mission — ${m.summary}.`;
    if (!detour) return `${base} Keep tool arguments consistent with it unless the user changes it.]`;
    return `${base} The current message looks like a SIDE QUESTION: answer it directly and concisely FIRST, then add ONE sentence that bridges back to the mission with a concrete, tool-backed next step. Never drop or restart the mission.]`;
}
