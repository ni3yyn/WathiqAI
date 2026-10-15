/**
 * triage_reaction — "my face is burning / red / peeling after X".
 *
 * Deterministic and safety-first. It never diagnoses. It:
 *   1. reads the symptoms (ar / Darija / fr / en) and checks RED FLAGS first;
 *   2. separates irritation / suspected allergy / purge by timing & symptoms;
 *   3. ranks likely culprits among the actives the user is actually using
 *      (potency, recency, layering overload);
 *   4. gives a stop-and-repair plan and a back-off plan;
 *   5. says when to see a doctor.
 */
import { resolveAllConcepts, L10n, PREGNANCY_NOTE, CONCEPTS, matchConceptInList } from '../ingredientKnowledge';
import { foldMessage } from '../intents';

export type Urgency = 'urgent' | 'doctor_soon' | 'self_care';
export type ReactionType = 'irritation' | 'allergy_suspect' | 'purge' | 'breakout_other' | 'dryness' | 'unclear';

export interface Candidate { label: string; keys: string[]; startedDaysAgo?: number }

export interface TriageArgs {
    /** the user's own words — symptoms/onset/timing are read from here */
    text: string;
    /** extra symptoms named by the caller (LLM) */
    symptoms?: string[];
    severity?: 'mild' | 'moderate' | 'severe';
    /** what the user is using / just started (products or active names resolved to concept keys) */
    candidates?: Candidate[];
    pregnant?: boolean;
    /** current induction stage, if a schedule is in progress — used for the back-off plan */
    scheduleActive?: string;
}

const SYMPTOM_RE: Record<string, RegExp> = {
    burning: /يحرق|حرقة|حرق|يلسع|لسع|حرقان|burn(?:ing|s|ed)?|sting(?:ing|s)?|\bhot\b|brûl|picote|pique/i,
    redness: /حمرة|حمراء|احمرار|يحمر|red(?:ness)?\b|flushed|rougeur|rouge/i,
    peeling: /يتقشر|تقشر(?!ير)|قشور|peel(?:ing)?|flak(?:ing|y)|desquam|pèle|qui\s*pèle/i,
    itching: /حكة|يهرش|هرش|يحك|itch(?:y|ing)?|démange|gratte/i,
    swelling: /تورم|انتفخ|ينتفخ|منتفخ|swell(?:ing|en)?|puffy|gonfl/i,
    hives: /طفح|حبوب\s*حمراء\s*كثيرة|hives|urticaire|welts|rash|éruption/i,
    blisters: /فقاقيع|بثور\s*مائية|blister|cloque/i,
    pus_fever: /صديد|حمى|سخانة|pus\b|fever|fièvre|infect(?:ed|ion)/i,
    breathing: /ما\s*نقدرش\s*نتنفس|مانقدرش\s*نتنفس|مانيش\s*نقدر\s*نتنفس|ضيق\s*(?:في\s*)?التنفس|صعوبة\s*(?:في\s*)?التنفس|مانقدرش\s*نتنفس|trouble\s*breathing|can'?t\s*breathe|short(?:ness)?\s*of\s*breath|difficulté\s*à\s*respirer/i,
    dryness: /جفاف|شد\b|مشدود|tight(?:ness)?|\bdry(?:ness)?\b|sec(?:heresse)?|tiraille/i,
    breakout: /حبوب\s*(?:جديدة|كثيرة|ظهرو|ظهرت)|ظهرو\s*(?:لي|ليا)?\s*حبوب|طلعو\s*(?:لي|ليا)?\s*حبوب|break(?:ing)?\s*out|breakout|purg(?:e|ing)|new\s*pimples|nouveaux\s*boutons|poussée\s*de\s*boutons/i,
};
const FACE_PARTS = /وجه|شفاه|شفايف|شفتي|شفة|عين|عيون|لسان|face|lips?|eyes?|eyelid|tongue|visage|lèvres|yeux|paupière/i;
const SEVERE_RE = /شديد|بزاف\s*بزاف|ما\s*نتحملش|لا\s*يطاق|unbearable|severe|extreme|terrible|intense|insupportable/i;
const SEARCH_VERBS = /اريد|أريد|ابحث|أبحث|اعطني|أعطني|عندك|اقترح|رشح|وصي|recommend|find|search|looking\s*for|je\s*cherche|show\s*me|suggest|cream\s*for|crème\s*pour|كريم\s*ل/i;

export function detectSymptoms(text: string): string[] {
    const t = text || '';
    const f = foldMessage(t);
    return Object.entries(SYMPTOM_RE).filter(([, re]) => re.test(f) || re.test(t)).map(([k]) => k);
}

/** Is this message a reaction report (vs. a normal product/ingredient question)? */
// Prospective / preventive phrasing ("how do I start retinol so it doesn't burn?") is NOT a reaction report.
const PREVENTION_RE = /باش\s*ما|حتى\s*ما|ما\s*يحرق(?:ليش|ني|ش)?\s*(?:وجهي)?\s*[؟?]?$|so\s*(?:that\s*)?it\s*(?:doesn'?t|won'?t|does\s*not|will\s*not)|without\s*(?:burning|irritat|stinging)|avoid\s*(?:burning|irritat)|prevent|pour\s*(?:ne\s*pas|éviter)|sans\s*(?:brûler|irrit)|how\s*(?:do|to|can|should)\s*i\s*(?:start|begin|use)|كيفاش\s*(?:نستعمل|نبدا|نبدأ)/i;

export function looksLikeReaction(text: string): boolean {
    const f = foldMessage(text || '');
    if (!f || SEARCH_VERBS.test(f) || PREVENTION_RE.test(f)) return false;
    const s = detectSymptoms(text);
    const strong = s.filter(x => !['dryness', 'breakout'].includes(x));
    if (strong.length > 0) return true;
    // dryness / breakouts only count with an explicit reaction cue
    const cue = /بعد|منذ|من\s*ملي|ملي\s*بديت|بديت|زدت|since|after|started|began|new\s|depuis|après|j'ai\s*commencé|commencé/i.test(f);
    return s.length > 0 && cue;
}

export function parseDaysAgo(text: string): number | undefined {
    const f = foldMessage(text || '');
    const num = f.match(/(\d+)\s*(?:يوم|ايام|أيام|days?|jours?|j\b)/i);
    if (num) return parseInt(num[1], 10);
    const wk = f.match(/(\d+)\s*(?:اسبوع|أسبوع|اسابيع|أسابيع|semaines?|weeks?)/i);
    if (wk) return parseInt(wk[1], 10) * 7;
    if (/اسبوعين|أسبوعين|two\s*weeks|deux\s*semaines/i.test(f)) return 14;
    if (/البارح|امس|أمس|yesterday|hier/i.test(f)) return 1;
    if (/اليوم|هاد\s*الليلة|الليلة|tonight|today|ce\s*soir|aujourd/i.test(f)) return 0;
    if (/شهر|month|mois/i.test(f)) return 30;
    return undefined;
}

const POTENCY: Record<string, number> = {
    retinoid: 5, aha: 4, bha: 4, benzoyl: 4, vitc: 3, azelaic: 2, fragrance: 2, alcohol: 2, essential_oil: 2, sulfate: 2, copper_peptide: 1,
};
const EXFOLIANT_CLASS = ['retinoid', 'aha', 'bha', 'benzoyl'];
const LABEL: Record<string, L10n> = Object.fromEntries(CONCEPTS.map(c => [c.key, c.label]));

interface Culprit { label: string; keys: string[]; score: number; reasons: L10n[] }

function rankCulprits(cands: Candidate[]): { culprits: Culprit[]; overload: boolean } {
    const out: Culprit[] = [];
    let exfoliantProducts = 0;
    for (const c of cands) {
        let score = 0;
        const reasons: L10n[] = [];
        for (const k of c.keys) {
            const p = POTENCY[k];
            if (!p) continue;
            score += p;
            reasons.push({ ar: `يحتوي ${LABEL[k]?.ar || k} وهو من أكثر المكونات تسبباً بالتهيج`, fr: `Contient ${LABEL[k]?.fr || k}, un actif souvent irritant`, en: `Contains ${LABEL[k]?.en || k}, a common irritant` });
        }
        if (c.keys.some(k => EXFOLIANT_CLASS.includes(k))) exfoliantProducts++;
        if (c.startedDaysAgo !== undefined) {
            if (c.startedDaysAgo <= 3) { score += 3; reasons.push({ ar: 'بدأته منذ أيام قليلة فقط', fr: 'Commencé il y a quelques jours seulement', en: 'Started only a few days ago' }); }
            else if (c.startedDaysAgo <= 14) { score += 2; reasons.push({ ar: 'بدأته خلال آخر أسبوعين', fr: 'Commencé dans les deux dernières semaines', en: 'Started within the last two weeks' }); }
        }
        if (score > 0) out.push({ label: c.label, keys: c.keys, score, reasons });
    }
    out.sort((a, b) => b.score - a.score);
    return { culprits: out.slice(0, 3), overload: exfoliantProducts >= 2 };
}

const T = (ar: string, fr: string, en: string): L10n => ({ ar, fr, en });

export function triageReaction(args: TriageArgs) {
    const text = args.text || '';
    const symptoms = Array.from(new Set([...detectSymptoms(text), ...(args.symptoms || [])]));
    const facePart = FACE_PARTS.test(foldMessage(text)) || FACE_PARTS.test(text);
    const sev = args.severity || (SEVERE_RE.test(foldMessage(text)) ? 'severe' : symptoms.some(s => ['burning', 'peeling', 'itching'].includes(s)) ? 'moderate' : 'mild');
    const days = parseDaysAgo(text);

    // ── 1. RED FLAGS first ───────────────────────────────────────────────────
    const redFlags: L10n[] = [];
    if (symptoms.includes('breathing')) redFlags.push(T('صعوبة في التنفس', 'difficulté à respirer', 'difficulty breathing'));
    if (symptoms.includes('swelling') && facePart && /شفاه|شفايف|شفتي|شفة|عين|عيون|لسان|lips?|eyes?|eyelid|tongue|lèvres|yeux|paupière/i.test(text)) redFlags.push(T('تورم الشفاه/العينين/اللسان', 'gonflement des lèvres/yeux/langue', 'swelling of lips/eyes/tongue'));
    if (symptoms.includes('hives')) redFlags.push(T('طفح جلدي منتشر', 'éruption/urticaire étendue', 'widespread rash/hives'));
    if (symptoms.includes('blisters')) redFlags.push(T('ظهور فقاقيع/بثور مائية', 'cloques', 'blistering'));
    if (symptoms.includes('pus_fever')) redFlags.push(T('صديد أو حمى', 'pus ou fièvre', 'pus or fever'));
    const urgent = redFlags.length > 0;

    // ── 2. Type of reaction ──────────────────────────────────────────────────
    const { culprits, overload } = rankCulprits(args.candidates || []);
    const breakoutOnly = symptoms.includes('breakout') && !symptoms.some(s => ['burning', 'redness', 'peeling', 'itching', 'swelling'].includes(s));
    const startedExfoliant = (args.candidates || []).some(c => c.keys.some(k => EXFOLIANT_CLASS.includes(k)) && c.startedDaysAgo !== undefined && c.startedDaysAgo >= 7 && c.startedDaysAgo <= 49);
    let type: ReactionType = 'unclear';
    if (symptoms.includes('itching') && (symptoms.includes('swelling') || symptoms.includes('hives') || symptoms.includes('redness'))) type = 'allergy_suspect';
    else if (breakoutOnly && startedExfoliant) type = 'purge';
    else if (breakoutOnly) type = 'breakout_other';
    else if (symptoms.some(s => ['burning', 'redness', 'peeling'].includes(s))) type = 'irritation';
    else if (symptoms.includes('dryness')) type = 'dryness';

    const urgency: Urgency = urgent ? 'urgent' : (sev === 'severe' || type === 'allergy_suspect') ? 'doctor_soon' : 'self_care';

    // ── 3. Plan ──────────────────────────────────────────────────────────────
    const steps: L10n[] = [];
    if (urgent) {
        steps.push(T('أوقف كل المنتجات فوراً واغسل وجهك بماء فاتر فقط', 'Arrêtez tous les produits et rincez à l\'eau tiède uniquement', 'Stop every product now and rinse with lukewarm water only'));
        steps.push(T('اطلب رعاية طبية عاجلة (طوارئ/طبيب) ولا تنتظر', 'Consultez en urgence (urgences/médecin), n\'attendez pas', 'Seek urgent medical care now — do not wait it out'));
    } else if (type === 'purge') {
        steps.push(T('استمر لكن خفّض التكرار إلى النصف (مثلاً ليلة بعد ليلتين)', 'Continuez mais réduisez la fréquence de moitié', 'Continue but cut the frequency in half'));
        steps.push(T('لا تعصر الحبوب؛ استعمل غسولاً لطيفاً ومرطباً خفيفاً', 'Ne percez pas les boutons ; nettoyant doux + hydratant léger', 'Do not pick; gentle cleanser + light moisturizer'));
        steps.push(T('التطهير يستمر عادة 4–6 أسابيع في أماكن الحبوب المعتادة؛ إن كانت مؤلمة/عميقة أو تجاوزت 6 أسابيع فاستشر طبيب جلدية', 'Une purge dure en général 4–6 semaines aux zones habituelles ; si douloureux/profond ou >6 semaines, voyez un dermatologue', 'A purge usually lasts 4–6 weeks in your usual breakout zones; if painful/deep or past 6 weeks, see a dermatologist'));
    } else if (type === 'allergy_suspect') {
        steps.push(T('أوقف المنتج الجديد فوراً ولا تعد استعماله', 'Arrêtez le produit récent et ne le réutilisez pas', 'Stop the new product and do not reuse it'));
        steps.push(T('اغسل المنطقة بماء بارد وتجنب العطور والمقشرات حتى تهدأ', 'Rincez à l\'eau fraîche, évitez parfums et exfoliants', 'Rinse with cool water; avoid fragrance and exfoliants'));
        steps.push(T('إن لم يتحسن خلال 48 ساعة أو انتشر، راجع الصيدلي/الطبيب', 'Sans amélioration en 48 h ou si ça s\'étend, voyez un pharmacien/médecin', 'If no improvement in 48 h or it spreads, see a pharmacist/doctor'));
    } else {
        steps.push(T('أوقف الريتينول والأحماض والمقشرات وفيتامين سي مؤقتاً (5–7 أيام على الأقل)', 'Pause rétinol, acides, exfoliants et vitamine C (5–7 jours minimum)', 'Pause retinol, acids, exfoliants and vitamin C (at least 5–7 days)'));
        steps.push(T('غسول لطيف + مرطب بالسيراميد أو البانثينول، وواقي شمس صباحاً', 'Nettoyant doux + hydratant céramides/panthénol, écran solaire le matin', 'Gentle cleanser + ceramide/panthenol moisturizer, sunscreen in the morning'));
        steps.push(T('بدون مقشرات فيزيائية أو ماء ساخن أو حك', 'Pas de gommage, d\'eau chaude ni de frottement', 'No scrubs, hot water or rubbing'));
        steps.push(T('أعد المنتج تدريجياً بعد أن تهدأ البشرة تماماً: تجربة على منطقة صغيرة، ثم مرة واحدة أسبوعياً', 'Réintroduisez progressivement une fois la peau calmée : test local puis 1×/semaine', 'Reintroduce gradually once calm: patch test, then once a week'));
    }

    const backOff: L10n | null = args.scheduleActive
        ? T(`ارجع إلى مرحلة أقل من جدول التدرّج الخاص بـ ${args.scheduleActive} (خفّض التكرار درجة واحدة وانتظر أسبوعاً بلا احمرار قبل التقدم).`,
            `Revenez à l'étape précédente du calendrier ${args.scheduleActive} (réduisez d'un cran, attendez une semaine sans rougeur).`,
            `Drop back one step in your ${args.scheduleActive} ramp-up (reduce a notch and wait a week with no redness before stepping up).`)
        : null;

    const whenDoctor = T(
        'راجع طبيباً إذا: تورم الوجه/الشفاه/العينين، صعوبة تنفس، فقاقيع، صديد أو حمى، انتشار سريع، ألم شديد، أو لم تتحسن خلال 48–72 ساعة من التوقف.',
        'Consultez si : gonflement du visage/lèvres/yeux, difficulté à respirer, cloques, pus ou fièvre, extension rapide, douleur intense, ou pas d\'amélioration 48–72 h après l\'arrêt.',
        'See a doctor if: swelling of face/lips/eyes, trouble breathing, blisters, pus or fever, fast spreading, severe pain, or no improvement 48–72 h after stopping.');

    const hasRetinoid = (args.candidates || []).some(c => c.keys.includes('retinoid'));
    return {
        urgency,
        type,
        severity: sev,
        symptoms,
        sinceDays: days ?? null,
        redFlags,
        culprits: culprits.map(c => ({ label: c.label, keys: c.keys, reasons: c.reasons })),
        layeringOverload: overload,
        steps,
        backOff,
        whenToSeeDoctor: whenDoctor,
        pregnancyNote: args.pregnant && hasRetinoid ? PREGNANCY_NOTE : undefined,
        needsMoreInfo: culprits.length === 0 && !urgent,
        disclaimer: 'إرشاد عام وليس تشخيصاً طبياً.',
    };
}

export { matchConceptInList, resolveAllConcepts };
