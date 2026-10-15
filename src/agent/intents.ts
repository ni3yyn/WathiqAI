/**
 * Pure message parsers shared by the router (agent.ts) and the fast lane.
 * No I/O here — everything is unit-testable (see scripts/smoke.ts).
 */
import { detectCategoryInText } from './taxonomy';
import { resolveAllConcepts, POTENT_KEYS } from './ingredientKnowledge';
import { matchReference, parsePriceFromText, ReferenceFingerprint } from './references';
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
    // "do the products in my cabinet clash?" — no routine yet, but a cabinet
    if (CABINET_WORDS.test(m) && COMPAT_WORDS.test(m)) return { yes: true, routineMode: true };
    return { yes: false, routineMode: false };
}

// ── alternatives ─────────────────────────────────────────────────────────────
export const ALTERNATIVE_RE = /بديل|بدائل|alternativ|dupe|[ée]quivalent|similaire|similar|مشابه|شبيه|يشبه|نفس\s*(?:المفعول|التاثير|التأثير)|same\s*effect|like\s*this|comme\s*celui/i;
export const CHEAPER_RE = /ارخص|أرخص|اقل\s*سعر|cheaper|moins\s*cher|less\s*expensive|budget\s*option/i;


// ── induction schedule ("how do I start using retinol without burning?") ─────
const HOW_RE = /كيفاش|كيف|طريقه|طريقة|ابدا|أبدأ|ابدأ|بدايه|بداية|برنامج|جدول|تدرج|how\s*(?:do|to|should|can|often)|start|begin|schedule|comment|d[ée]buter|commencer|fr[ée]quence|ramp/i;
const USE_RE = /استعمل|استخدم|نستعمل|نستخدم|use\b|using|utilis|appliqu|apply|ابدا|ابدأ|أبدأ|start|begin|commenc|d[ée]but/i;

export function isScheduleQuestion(raw: string): { yes: boolean } {
    const m = foldMessage(raw);
    if (!m || SEARCH_VERBS.test(m) || isContainsQuestion(raw)) return { yes: false };
    const concepts = resolveAllConcepts(m).filter(c => POTENT_KEYS.includes(c.key));
    // two potent actives together is a COMPATIBILITY question, not an onboarding one
    if (concepts.length !== 1) return { yes: false };
    return { yes: HOW_RE.test(m) && USE_RE.test(m) };
}

// ── "local dupe of an imported product" ──────────────────────────────────────
const LOCAL_RE = /جزائر|محلي|محليه|محلية|local|algeri|alg[ée]rie|made\s*in\s*algeria|dz\b/i;
const EXPENSIVE_RE = /غالي|بزاف\s*غالي|expensive|trop\s*cher|\bcher\b|pharmac|فارماسي|صيدليه|صيدلية|parapharm/i;

export interface DupeRequest { reference: ReferenceFingerprint | null; price?: number; local: boolean }

export function parseDupeRequest(raw: string): DupeRequest | null {
    const m = foldMessage(raw);
    if (!m || !ALTERNATIVE_RE.test(m)) return null;
    const reference = matchReference(raw);
    const local = LOCAL_RE.test(m);
    const expensive = EXPENSIVE_RE.test(m);
    if (!reference && !local && !expensive) return null;
    return { reference, price: parsePriceFromText(raw), local };
}


// ── "my cabinet" commands ─────────────────────────────────────────────────────
export const CABINET_WORDS = /خزانتي|خزانة|دولابي|رفي|cabinet|my\s*shelf|my\s*collection|my\s*bathroom|ma\s*collection|mon\s*armoire|ma\s*salle\s*de\s*bain|اللي\s*عندي|ما\s*عندي\s*في/i;

export interface CabinetCommand {
    action: 'add' | 'list' | 'mark' | 'remove';
    status?: 'using' | 'finished' | 'wishlist' | 'stopped';
    verdict?: 'loved' | 'ok' | 'didnt_suit';
}

export function parseCabinetCommand(raw: string): CabinetCommand | null {
    const m = foldMessage(raw);
    if (!m || m.length > 200) return null;
    const cab = CABINET_WORDS.test(m);

    if (cab && /(?:حيد|حيّد|امسح|احذف|شيل|remove|delete|supprime|enl[eè]ve)/i.test(m)) return { action: 'remove' };
    if (cab && /(?:وريني|اعرض|شنو|واش\s*عندي|show|list|what|voir|montre|liste|quels|display)/i.test(m)) return { action: 'list' };

    if (/ما\s*ناسبنيش|مانسبنيش|ما\s*عجبنيش|ماعجبنيش|ما\s*رتاحش|didn'?t\s*(?:suit|work)|did\s*not\s*(?:suit|work)|ça\s*ne\s*m'?a\s*pas\s*(?:convenu|plu)|ne\s*me\s*convient\s*pas|irritated\s*my\s*skin/i.test(m)) {
        return { action: 'mark', status: 'stopped', verdict: 'didnt_suit' };
    }
    if (/خلصته|خلصتو|خلصت\s*منه|خلصت\s+(?:هذا|هذي|هاد|المنتج|منتج)|سالا|finished\s*(?:it|this)|i'?ve\s*finished|used\s*(?:it\s*)?up|je\s*l'ai\s*(?:fini|termin[ée])/i.test(m)) {
        return { action: 'mark', status: 'finished' };
    }
    if (/بزاف\s*عجبني|عجبني\s*بزاف|ناسبني|love[sd]?\s*(?:it|this)|works?\s*great\s*for\s*me|j'adore|ça\s*m'?a\s*beaucoup\s*plu/i.test(m)) {
        return { action: 'mark', status: 'using', verdict: 'loved' };
    }
    if (/(?:ضيف|زيد|سجل|احفظ|حط)\w*/i.test(m) && (cab || /هذا|هذي|هاد|this|\bit\b|ça|ce\s*produit/i.test(m))) return { action: 'add' };
    if (/شريته|اشتريته|شريتو|عندي\s*هذا|عندي\s*هاد|i\s*(?:already\s*)?(?:own|have|bought|got)\s*(?:this|it)|j'?ai\s*(?:d[ée]j[àa]\s*)?(?:achet[ée]\s*)?(?:ça|ce\s*produit)/i.test(m)) return { action: 'add' };
    if (/(?:add|save|put|ajoute|enregistre)\b.*(?:cabinet|collection|shelf|armoire)/i.test(m)) return { action: 'add' };
    return null;
}


// ── practical outputs: share / shopping list / gift ──────────────────────────
export type OutputCommand = 'share' | 'shopping' | 'gift';

export function parseOutputCommand(raw: string): { kind: OutputCommand; budget?: number } | null {
    const m = foldMessage(raw);
    if (!m || m.length > 200) return null;
    const budget = (() => { const b = m.match(/(\d{3,6})\s*(?:دج|دينار|da\b|dzd)?/i); return b ? parseInt(b[1], 10) : undefined; })();
    if (/هدي[ةه]|gift|cadeau|offrir|نهدي|نهديها|نهديه/i.test(m)) return { kind: 'gift', budget };
    if (/قائم[ةه]\s*(?:التسوق|المشتريات|الشراء)|ليست[ةه]|shopping\s*list|liste\s*de\s*courses|what\s*(?:do\s*i|should\s*i)\s*buy|شنو\s*نشري|ش(?:نو|حال)\s*لازم\s*نشري/i.test(m)) return { kind: 'shopping' };
    if (/شارك|شاركلي|ابعث|ابعثلي|ارسل|ارسلي|share|send\s*me|partage|envoie|whatsapp|واتساب|واتس/i.test(m) && /روتين|routine|قائم|list|الخطوات/i.test(m)) return { kind: 'share' };
    return null;
}


// ── "why did you pick this?" ──────────────────────────────────────────────────
export function isWhyQuestion(raw: string): boolean {
    const m = foldMessage(raw);
    if (!m || m.length > 140) return false;
    return /ليش\s*(?:اخترت|اقترحت|رشحت|نصحت)|علاش\s*(?:اخترت|اقترحت|رشحت|نصحت|هذا)|على\s*اي\s*اساس|على\s*أي\s*أساس|لماذا\s*(?:اخترت|اقترحت|رشحت)|why\s*(?:did\s*you\s*(?:pick|choose|recommend|suggest)|(?:is\s*)?(?:this|that)\s*(?:one|product|recommended))|how\s*did\s*you\s*(?:pick|choose|decide)|pourquoi\s*(?:celui|ce\s*produit|tu\s*(?:as\s*)?(?:choisi|recommand|propos))/i.test(m);
}
