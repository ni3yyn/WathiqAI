/**
 * Deterministic search follow-ups.
 *
 * "المزيد" / "فقط الجزائرية" / "تحت 2000" / "بدون كحول" / "الأرخص" are edits to
 * the PREVIOUS search, not new searches. Previously the model had to rebuild
 * every filter from memory (and often dropped some). Here they are merged into
 * the stored lastSearchArgs so nothing from the earlier query is lost.
 */
import { normalizeCountry, detectCategoryInText } from './taxonomy';

export interface SearchRefinement {
    kind: 'more' | 'refine' | 'no_more';
    args: any;
    changes: string[];
}

const MORE_RE = /^\s*(?:و\s*)?(?:المزيد|مزيد|غيرهم|غير\s*هؤلاء|وريني\s*غيرهم|عندك\s*غيرهم|وريني\s*اكثر|show\s*me\s*more|more(?:\s*(?:options|products|like\s*these|please))?|others?|autres?|plus\s*de\s*produits|encore|d['’]autres)\s*[.!?؟]*\s*$/i;

const CONTEXT_STOP = /قيم|تقييم|قارن|روتين|مكونات|تجارب|آراء|evaluate|compare|routine|ingredients|reviews|avis|analy[sz]e/i;

const COUNTRY_PATTERNS: Array<[RegExp, string]> = [
    [/جزائر|دزاير|algeri|algérie|\balgeria\b/i, 'Algeria'],
    [/كور|korea|corée|coree|korean|coréen/i, 'Korea'],
    [/فرنس|france|french|français|francais/i, 'France'],
    [/ترك|turk|turqu/i, 'Turkey'],
    [/امريك|أمريك|\busa\b|american|américain|united states/i, 'USA'],
    [/تونس|tunisi/i, 'Tunisia'],
    [/مصر|egypt|égypte/i, 'Egypt'],
    [/المان|ألمان|german|allemagne|allemand/i, 'Germany'],
    [/ايطال|إيطال|ital/i, 'Italy'],
];

function wordCount(s: string) { return s.trim().split(/\s+/).filter(Boolean).length; }

export function buildSearchRefinement(
    rawMessage: string,
    lastArgs: any | null | undefined,
    nextOffset: number | null | undefined
): SearchRefinement | null {
    if (!lastArgs) return null;
    const msg = String(rawMessage || '').trim();
    if (!msg || msg.length > 70 || wordCount(msg) > 9) return null;

    // 1. Pagination
    if (MORE_RE.test(msg)) {
        if (nextOffset === null || nextOffset === undefined) {
            return { kind: 'no_more', args: lastArgs, changes: [] };
        }
        return { kind: 'more', args: { ...lastArgs, offset: nextOffset }, changes: [`offset=${nextOffset}`] };
    }

    // 2. Refinements — only for short messages that carry no other intent.
    if (CONTEXT_STOP.test(msg)) return null;
    const newCategory = detectCategoryInText(msg);
    if (newCategory) return null;     // "and a cleanser?" is a NEW search, not a refinement

    const out: any = { ...lastArgs };
    delete out.offset;
    const changes: string[] = [];

    // Country
    for (const [re, country] of COUNTRY_PATTERNS) {
        if (re.test(msg)) {
            out.country = normalizeCountry(country) || country;
            changes.push(`country=${out.country}`);
            break;
        }
    }

    // Max price
    const maxM = msg.match(/(?:تحت|اقل\s*من|أقل\s*من|لا\s*يتجاوز|حتى|under|below|max(?:imum)?|up\s*to|moins\s*de|jusqu['’]?\s*[àa])\s*(\d{3,6})/i);
    if (maxM) {
        out.max_price = parseInt(maxM[1], 10);
        delete out.around_price;
        changes.push(`max_price=${out.max_price}`);
    }

    // Min price
    const minM = msg.match(/(?:فوق|اكثر\s*من|أكثر\s*من|over|above|at\s*least|plus\s*de|au-dessus\s*de)\s*(\d{3,6})/i);
    if (minM) {
        out.min_price = parseInt(minM[1], 10);
        changes.push(`min_price=${out.min_price}`);
    }

    // Sorting
    if (/الأرخص|الارخص|ارخص\s*شي|cheapest|le\s*moins\s*cher|lowest\s*price|moins\s*cher\b/i.test(msg) && !/من\s+\S+/.test(msg.replace(/الأرخص|الارخص/g, ''))) {
        out.sort_by = 'price_asc';
        changes.push('sort_by=price_asc');
    } else if (/الأغلى|الاغلى|most\s*expensive|le\s*plus\s*cher|highest\s*price/i.test(msg)) {
        out.sort_by = 'price_desc';
        changes.push('sort_by=price_desc');
    }

    // Exclusions: "بدون كحول", "sans parfum", "without alcohol", "fragrance-free"
    const exclusions: string[] = [];
    const exRe = /(?:بدون|من\s*غير|خالي\s*من|ما\s*فيهاش|sans|without|no)\s+([^\s،,.؟?!]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = exRe.exec(msg)) !== null) exclusions.push(m[1]);
    const freeRe = /([a-zA-Z]+)[-\s]free\b/gi;
    while ((m = freeRe.exec(msg)) !== null) exclusions.push(m[1]);
    if (exclusions.length > 0) {
        out.exclude_ingredients = Array.from(new Set([...(out.exclude_ingredients || []), ...exclusions]));
        changes.push(`exclude=${exclusions.join(',')}`);
    }

    if (changes.length === 0) return null;
    return { kind: 'refine', args: out, changes };
}
