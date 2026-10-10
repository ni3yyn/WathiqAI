/**
 * Pure message parsers shared by the router (agent.ts) and the fast lane.
 * No I/O here — everything is unit-testable (see scripts/smoke.ts).
 */
import { detectCategoryInText } from './taxonomy';
import { resolveAllConcepts } from './ingredientKnowledge';
import type { RoutineAction } from './tools/modifyRoutine';

export function foldMessage(raw: string): string {
    return String(raw || '')
        .normalize('NFKC')
        .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// ── language ─────────────────────────────────────────────────────────────────
export type Lang = 'ar' | 'fr' | 'en';
export function detectLang(msg: string, profileLang?: string): Lang {
    if (/[\u0600-\u06FF]/.test(msg)) return 'ar';
    if (/[éèêàùçôîâœ]|\b(le|la|les|des|est-ce|quel|quelle|je|mon|ma|pour|avec|sans|moins|cher|produit|marque|peau|merci|contient|bonjour)\b/i.test(msg)) return 'fr';
    if (profileLang === 'ar' || profileLang === 'fr' || profileLang === 'en') return profileLang;
    return 'en';
}

// ── routine editing ──────────────────────────────────────────────────────────
const ORDINALS: Array<[RegExp, number]> = [
    [/(?:^|\s)(?:الاولي|الاولى|اولى|first|premi[eè]re?|1(?:st)?)(?=\s|$)/i, 1],
    [/(?:^|\s)(?:الثانيه|الثانية|ثانيه|ثانية|second|deuxi[eè]me|2(?:nd)?)(?=\s|$)/i, 2],
    [/(?:^|\s)(?:الثالثه|الثالثة|ثالثه|ثالثة|third|troisi[eè]me|3(?:rd)?)(?=\s|$)/i, 3],
    [/(?:^|\s)(?:الرابعه|الرابعة|رابعه|رابعة|fourth|quatri[eè]me|4(?:th)?)(?=\s|$)/i, 4],
    [/(?:^|\s)(?:الخامسه|الخامسة|fifth|cinqui[eè]me|5(?:th)?)(?=\s|$)/i, 5],
];

export function parseStepNumber(msg: string): number | undefined {
    const m = foldMessage(msg);
    const direct = m.match(/(?:الخطو[ةه]|خطو[ةه]|step|[ée]tape)\s*(?:رقم|n[°o]?|number|#)?\s*(\d)/i);
    if (direct) return parseInt(direct[1], 10);
    const stepWord = /(?:الخطو[ةه]|خطو[ةه]|step|[ée]tape)/i;
    if (stepWord.test(m)) {
        for (const [re, n] of ORDINALS) if (re.test(m)) return n;
    }
    return undefined;
}

export interface RoutineEdit {
    action: RoutineAction;
    step_number?: number;
    category?: string;
    cheaper?: boolean;
    max_budget?: number;
}

export function parseRoutineEdit(rawMsg: string): RoutineEdit | null {
    const m = foldMessage(rawMsg);
    if (!m || m.length > 160) return null;

    const stepNo = parseStepNumber(m);
    const cat = detectCategoryInText(m);
    const cheaper = /ارخص|أرخص|اقل\s*سعر|cheaper|moins\s*cher|less\s*expensive/.test(m);
    const budgetM = m.match(/(?:تحت|اقل\s*من|أقل\s*من|under|below|moins\s*de|بميزانيه|بميزانية|ميزانيتي|ميزانيه|ميزانية|budget|حتي|حتى)\s*(?:ال)?\s*(\d{3,6})/i);
    const routineWord = /روتين|routine|الخطوات|steps|[ée]tapes/.test(m);

    const removeRe = /(?:^|\s)(?:احذف\w*|ازل\w*|أزل\w*|شيل\w*|امسح\w*|remove|delete|drop|supprime\w*|enl[eè]ve\w*|retire\w*)(?=\s|$)|بدون\s+(?:الخطو|خطو)/i;
    const addRe = /(?:^|\s)(?:اضف\w*|أضف\w*|ضيف\w*|زيد\w*|add|ajoute\w*|rajoute\w*|include)(?=\s|$)/i;
    const swapRe = /(?:^|\s)(?:بدل\w*|بدّل\w*|غير|غيّر|غيري|استبدل\w*|swap|replace|change|remplace\w*|chang\w+)(?=\s|$)/i;

    let action: RoutineAction | undefined;
    if (removeRe.test(m) && (stepNo || cat)) action = 'remove';
    else if (addRe.test(m) && cat && !stepNo) action = 'add';
    else if (swapRe.test(m) && (stepNo || cat)) action = 'swap';
    else if (cheaper && stepNo) action = 'swap';
    else if (budgetM && routineWord) action = 'refit';

    if (!action) return null;
    const edit: RoutineEdit = { action };
    if (stepNo) edit.step_number = stepNo;
    if (cat) edit.category = cat;
    if (cheaper) edit.cheaper = true;
    if (budgetM) edit.max_budget = parseInt(budgetM[1], 10);
    if (action === 'refit' && !edit.max_budget) return null;
    return edit;
}

// ── "does it contain X?" ─────────────────────────────────────────────────────
const SEARCH_VERBS = /اريد|أريد|ابحث|أبحث|اعطني|أعطني|عندك|اقترح|رشح|وصي|recommend|find|search|looking\s*for|je\s*cherche|show\s*me|suggest/i;
const QUESTION_MARK = /هل\s|؟|\?|does\s|is\s*there|do\s*(?:they|you)|est-ce|y\s*a-t-il|contient-il/i;
const CONTAIN_VERB = /فيه|فيها|يحتوي|تحتوي|يوجد|به\s|بها\s|contains?|containing|have|has\b|contient|y\s*a\b|avec/i;

export function isContainsQuestion(raw: string): boolean {
    const m = foldMessage(raw);
    if (!m || SEARCH_VERBS.test(m)) return false;
    if (!QUESTION_MARK.test(raw) || !CONTAIN_VERB.test(m)) return false;
    return resolveAllConcepts(m).length >= 1;
}

// ── compatibility ────────────────────────────────────────────────────────────
const COMPAT_WORDS = /تعارض|يتعارض|تتعارض|مع\s*بعض|معا|سوا|اجمع|أجمع|الجمع|هل\s*(?:يمكن|ينفع|ممكن|اقدر|أقدر|اقدر)|together|combine|mix|clash|compatible|same\s*time|ensemble|en\s*m[eê]me\s*temps|m[eé]langer|associer|layer/i;

const USE_WORDS = /استعمل|استخدم|use\b|using|utilis|appliqu|apply|اضع|أضع|مع\s/i;

export function compatConceptCount(raw: string): number {
    return resolveAllConcepts(foldMessage(raw)).length;
}

export function isCompatQuestion(raw: string, hasRoutine: boolean): { yes: boolean; routineMode: boolean } {
    const m = foldMessage(raw);
    if (!m || SEARCH_VERBS.test(m)) return { yes: false, routineMode: false };
    const n = compatConceptCount(m);
    // "هل أستعمل الريتينول مع فيتامين سي؟" — a question about USING two actives
    // together, without an explicit "clash/together" word.
    const useQuestion = n >= 2 && QUESTION_MARK.test(raw) && USE_WORDS.test(m) && !CONTAIN_VERB.test(m);
    if (!COMPAT_WORDS.test(m) && !useQuestion) return { yes: false, routineMode: false };
    if (n >= 2) return { yes: true, routineMode: false };
    if (hasRoutine && /روتين|routine|منتجات|products|produits/i.test(m)) return { yes: true, routineMode: true };
    return { yes: false, routineMode: false };
}

// ── alternatives ─────────────────────────────────────────────────────────────
export const ALTERNATIVE_RE = /بديل|بدائل|alternativ|dupe|[ée]quivalent|similaire|similar|مشابه|شبيه|يشبه|نفس\s*(?:المفعول|التاثير|التأثير)|same\s*effect|like\s*this|comme\s*celui/i;
export const CHEAPER_RE = /ارخص|أرخص|اقل\s*سعر|cheaper|moins\s*cher|less\s*expensive|budget\s*option/i;
