/**
 * Voice: which language/register the user writes in, and how they feel.
 *
 *  - language: ar | fr | en (Arabizi counts as Arabic)
 *  - register: Darija vs Modern Standard Arabic — sticky across short messages
 *  - mood:     distressed (burning, swelling, panic…) → calm, short, no emoji
 *
 * Templates are keyed by `TLang` = ar | fr | en | dz (Darija). `tr()` picks the
 * explicit `dz` string if a template has one, otherwise runs the MSA text
 * through darija.ts.
 */
import { darijaize } from './darija';
import { foldMessage } from './intents';

export type Lang = 'ar' | 'fr' | 'en';
export type TLang = Lang | 'dz';
export type Register = 'darija' | 'msa';
export type Mood = 'distressed' | 'neutral';

export interface Tr { ar: string; fr: string; en: string; dz?: string }

export function tr(lang: TLang, t: Tr): string {
    if (lang === 'dz') return t.dz ?? darijaize(t.ar);
    return t[lang] || t.ar;
}

/** Pick the right language from an {ar, fr, en, dz?} object of unknown shape (tool output). */
export function pickL(obj: any, lang: TLang): string {
    if (!obj) return '';
    if (lang === 'dz') return obj.dz ?? darijaize(obj.ar || '');
    return obj[lang] || obj.ar || '';
}

// Words that are (almost) only said in Algerian Darija — Arabic script.
const DARIJA_AR = /(?:^|\s)(?:راني|رانا|راك|راكي|راه|راها|نبغي|نحب|نحوس|نشري|نشريه|نستعمل|نستعملو|نقدر|نديرو?|ندير|واش|كيفاش|كيما|علاش|فين|شحال|شكون|بزاف|ديجا|دروك|تاع|تاعي|تاعك|تاعو|تاعها|تاعهم|ماشي|مانيش|ماراني|مارانيش|ما\s*رانيش|بصح|والو|مليح|ملاح|خاطر|برك|صح|هاذ|هادا|هاذي|هادي|هاد|كاين|كاينة|ماكاش|ماكانش|يحرقني|يحرقلي|يحرقليش|يقشر|يتقشر|وجهي\s*راه|حاب|حابة|بغيت|بغيتو|نخدم|يخدم|يسوى|يسواش|فالفارماسي|فلفارماسي|زعما|تاع\s*ذا|قريب)(?=\s|$|[؟?!.,،])/;
// Latin-script Darija (Arabizi).
const ARABIZI = /\b(?:wach|wesh|rani|rah|rak|kifach|kifah|kifech|bezzaf|bzaf|bzzaf|nbghi|nebghi|n7eb|nhab|3andi|3andek|chhal|chhal|mlih|mliha|dork|drok|ndir|nesta3mel|nestaamel|bessah|bsah|sahbi|khouya|khoya|3lach|alach|fin|dja|deja|ta3|tae|machi|ma3lich|wellah|ya3tik|saha|hadi|hada|had|kayen|makach|y7re9|yhre9|yehrek|wejhi|wejhek)\b/i;
const ARABIZI_DIGITS = /\b\w*[a-z][37][a-z]\w*\b/i;     // n3awnek, 7abit, 9bel

export function hasDarijaMarkers(message: string): boolean {
    const m = foldMessage(message);
    return DARIJA_AR.test(m) || ARABIZI.test(message) || (ARABIZI_DIGITS.test(message) && !/[0-9]{2,}/.test(message));
}

const ARABIZI_STRONG = /\b(?:wach|wesh|rani|kifach|bezzaf|bzaf|nbghi|nebghi|3andi|chhal|mlih|bessah|3lach|machi|kayen|makach)\b/i;

const DISTRESS = /يحرق|حرقة|حرق|يلسع|لسع|حمرة|حمراء|احمرار|تورم|انتفخ|ينتفخ|منتفخ|يوجع|يوجعني|ألم|حكة|يهرش|تهيج|طفح|حساسية\s*شديدة|تعبت|خايف|خايفة|مرعوب|panic|burn(?:ing|s|ed)?|sting|painful|\bpain\b|swollen|swelling|itch|rash|hives|allergic\s*reaction|inflamed|brûl|picote|douleur|gonfl|démange|rougeur|irrit|urticaire|réaction\s*allergique|y7re9|yhre9|yehrek|ydjrah/i;

export interface Voice {
    lang: Lang;
    register: Register | null;       // null for non-Arabic
    mood: Mood;
    tlang: TLang;
}

export function detectMood(message: string): Mood {
    return DISTRESS.test(foldMessage(message)) || DISTRESS.test(message) ? 'distressed' : 'neutral';
}

export function detectVoice(message: string, profile?: { language?: Lang; register?: Register }): Voice {
    const arabicScript = /[\u0600-\u06FF]/.test(message);
    const arabizi = !arabicScript && (ARABIZI_STRONG.test(message) || (ARABIZI.test(message) && ARABIZI_DIGITS.test(message)));
    const darijaHit = hasDarijaMarkers(message);

    let lang: Lang;
    if (arabicScript || arabizi) lang = 'ar';
    else if (/[éèêàùçôîâœ]|\b(le|la|les|des|est-ce|quel|quelle|je|mon|ma|pour|avec|sans|moins|cher|produit|marque|peau|merci|contient|bonjour)\b/i.test(message)) lang = 'fr';
    else if (profile?.language === 'ar' || profile?.language === 'fr' || profile?.language === 'en') lang = profile.language;
    else lang = 'en';

    let register: Register | null = null;
    if (lang === 'ar') {
        if (darijaHit) register = 'darija';
        else if (arabicScript && foldMessage(message).split(' ').length >= 6) register = 'msa';   // a long clean-MSA message is a real signal
        else register = profile?.register || 'msa';                                                // short messages keep the previous register
    }
    const mood = detectMood(message);
    return { lang, register, mood, tlang: lang === 'ar' && register === 'darija' ? 'dz' : lang };
}

/** Emojis are removed for distressed users (⚠️ is kept — it carries safety meaning). */
export function calm(text: string): string {
    return text
        .replace(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, m => (m === '⚠' ? m : ''))
        .replace(/⚠(?!\uFE0F)/g, '⚠️')
        .replace(/\s{2,}/g, ' ')
        .replace(/ \n/g, '\n')
        .trim();
}

/** Context line for the LLM path. Only emitted when it changes how the model should write. */
export function buildVoiceContext(v: Voice): string | null {
    const parts: string[] = [];
    if (v.register === 'darija') {
        parts.push('Reply in natural Algerian Darija written in Arabic script (mirror Arabizi/Latin only if the user wrote Arabizi), like a warm, knowledgeable friend — short sentences, everyday words, no stiff MSA; keep product names and INCI names in Latin; gender-neutral phrasing; at most ONE emoji');
    } else if (v.lang === 'ar' && v.register === 'msa') {
        parts.push('Reply in clear, warm Modern Standard Arabic (not stiff, not Darija)');
    }
    if (v.mood === 'distressed') {
        parts.push('The user may be in discomfort: stay calm and brief, acknowledge it in one short sentence, put safety/stop-using advice FIRST, no emojis, no jokes, no upsell; if there are red flags (swelling of face/lips/eyes, hives, trouble breathing, blistering, spreading rash, fever) tell them to seek medical care promptly');
    }
    return parts.length ? `[Voice: ${parts.join('. ')}.]` : null;
}

/** Deterministic pick so the same message gets the same opener, but replies vary across messages. */
export function pickVariant<T>(options: T[], seed: string): T {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return options[h % options.length];
}

const OPENERS: Record<string, Tr[]> = {
    eval: [
        { ar: 'إليك التقييم.', fr: 'Voici l\'évaluation.', en: 'Here\'s the evaluation.', dz: 'هاك التقييم.' },
        { ar: 'فحصته لك.', fr: 'Je l\'ai analysé.', en: 'I checked it for you.', dz: 'شفتو ليك.' },
    ],
    alt: [
        { ar: 'هذه بدائل مناسبة.', fr: 'Voici de bonnes alternatives.', en: 'Here are some good alternatives.', dz: 'هاك بدائل مليحة.' },
        { ar: 'بحثت لك.', fr: 'J\'ai cherché pour vous.', en: 'I looked for you.', dz: 'قلّبتلك.' },
    ],
    dupe: [
        { ar: 'أخبار جيدة!', fr: 'Bonne nouvelle !', en: 'Good news!', dz: 'خبر مليح!' },
        { ar: 'وجدت لك خيارات.', fr: 'J\'ai trouvé des options.', en: 'I found options for you.', dz: 'لقيتلك خيارات.' },
    ],
};

export function opener(lang: TLang, kind: keyof typeof OPENERS | string, seed: string): string {
    const pool = OPENERS[kind];
    return pool ? tr(lang, pickVariant(pool, seed)) : '';
}
