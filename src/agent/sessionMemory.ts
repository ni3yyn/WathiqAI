/**
 * Wathiq Intelligence — Session Memory (per-session ONLY)
 *
 * Replaces the old flat "last X" AgentStateTracker with a structured,
 * session-scoped memory that lives entirely in this process's RAM:
 *
 *   1. Rolling USER PROFILE for the session — skin type, hair type, concerns,
 *      allergies, ingredients to avoid, budget, country preference, preferred
 *      brands — extracted heuristically from each user message (Arabic /
 *      Darija / French / English) and injected into the model context so the
 *      agent personalizes without re-asking. NOTHING is written to disk and
 *      NOTHING survives past the session TTL — this is deliberately NOT a
 *      cross-session account profile.
 *
 *   2. ENTITY HISTORY — every product actually shown/built/evaluated, with the
 *      turn it appeared on, so references like "the third one", "المنتج الثاني",
 *      "le deuxième", "compare the first two" resolve against real catalog IDs
 *      instead of guesswork.
 *
 *   3. Backward-compatible AgentStateTracker fields (lastProductResults,
 *      lastProduct, lastAnalysis, lastRoutine, lastBrandEvaluation,
 *      lastReviewData) so the rest of the codebase keeps working unchanged.
 *
 * Eviction: TTL on inactivity + hard cap with LRU-style eviction. All data
 * dies with the process or the session — per the product requirement, there
 * is intentionally no persistence layer here.
 */

import { TARGET_TYPE_MAPPINGS, detectCategoryInText } from './taxonomy';

// ─── BACKWARD-COMPATIBLE STATE SHAPE ─────────────────────────────────────────
export interface AgentStateTracker {
    lastProductResults: any[] | null;
    lastProduct: any | null;
    lastAnalysis: any | null;
    lastRoutine: any | null;
    lastBrandEvaluation: any | null;
    lastReviewData: any | null;
    /** Set by compare_products — lets "why did the second one win?" resolve. */
    lastComparison?: any | null;
    /** Set by check_ingredient_list — lets "which ingredient is the problem?" resolve. */
    lastIngredientCheck?: any | null;
    /** Set by check_compatibility — the last interaction report shown. */
    lastCompatibility?: any | null;
    /** Set by product_contains — the last "does it contain X?" answer shown. */
    lastIngredientPresence?: any | null;
    /**
     * The model-facing args of the last FRESH search (offset stripped) plus the
     * nextOffset it reported. Lets "المزيد", "فقط الجزائرية", "تحت 2000",
     * "بدون كحول" be applied deterministically instead of hoping the model
     * rebuilds every filter from memory.
     */
    lastSearchArgs?: any | null;
    lastSearchNextOffset?: number | null;
}

/** A one-turn "yes" shortcut: the fast lane offered this next step last turn. */
export interface PendingOffer {
    tool: 'find_alternatives' | 'compare_products' | 'check_compatibility';
    args: any;
    turn: number;                // turnCount of the reply that made the offer
}

export interface UserProfile {
    skinType?: string;            // canonical catalog tag, e.g. 'بشرة دهنية'
    hairType?: string;            // canonical catalog tag, e.g. 'شعر تالف'
    concerns: string[];           // e.g. ['حب الشباب', 'تفتيح']
    allergies: string[];          // substances the user is allergic to
    avoidIngredients: string[];   // substances the user asked to exclude
    budgetMin?: number;           // DZD
    budgetMax?: number;           // DZD
    country?: string;             // preferred country of origin
    preferredBrands: string[];    // brands the user expressed liking for
    language?: 'ar' | 'fr' | 'en';
}

export interface DiscussedProduct {
    id: string;
    brand?: string;
    name?: string;
    price?: string;
    currency?: string;
    turn: number;                 // session-relative turn it was discussed on
    source: 'search' | 'product' | 'routine' | 'analysis' | 'reviews' | 'comparison';
}

/**
 * A brand the session engaged with, plus WHICH categories of that brand the
 * user asked about ("Venus — sunscreen, cleanser"). This is what makes
 * follow-ups like "and their cleanser?" / "و الغسول تاعهم؟" resolvable
 * without asking the user to repeat the brand.
 */
export interface BrandInterest {
    brand: string;                // resolved display name
    categories: string[];         // canonical categories asked about this session
    turn: number;                 // last turn this brand was touched
    source: 'brand_evaluation' | 'brand_search' | 'brand_reviews';
}

export interface SessionState extends AgentStateTracker {
    profile: UserProfile;
    /** Goal memory (see goals.ts): what the user is trying to achieve. */
    mission?: import('./goals').Mission | null;
    /** Offer made by the previous fast-lane reply, executed on a bare "yes". */
    pendingOffer?: PendingOffer | null;
    /** Opt-in cross-session memory (see longterm.ts). */
    longtermLoaded?: boolean;
    returningFacts?: import('./longterm').LongtermFacts | null;
    returningNoteDue?: boolean;
    longtermForgotTurn?: number;
    /** Newest last. Deduped by product id, capped at MAX_HISTORY. */
    productHistory: DiscussedProduct[];
    /** Newest last. Deduped by normalized brand name, capped at MAX_BRANDS. */
    brandHistory: BrandInterest[];
    /**
     * The most recent (brand, category?) pair the user engaged with — the
     * anchor for possessive follow-ups ("their cleanser", "منتجاتهم للشعر").
     */
    lastBrandFocus?: { brand: string; category?: string; turn: number } | null;
    /** Recent free-text search queries, for "show me more like this". */
    recentQueries: string[];
    turnCount: number;
    createdAt: number;
}

// ─── TUNING ──────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 1000 * 60 * 45;   // 45 min of inactivity
const MAX_SESSIONS = 500;                // hard cap; LRU eviction beyond this
const MAX_HISTORY = 16;                  // discussed products kept per session
const MAX_BRANDS = 6;                    // brand interests kept per session
const MAX_QUERIES = 6;
const SWEEP_INTERVAL_MS = 1000 * 60 * 5; // background sweep every 5 min

// ─── TEXT NORMALIZATION (LOCAL, DEPENDENCY-FREE) ─────────────────────────────
// A light version of taxonomy.normalizeArabicText so sessionMemory stays
// import-safe from anywhere (taxonomy imports fs/path; we don't want a hard
// dependency chain here). Keep semantics in sync with that function.
function lightNormalize(text: string): string {
    return String(text || '')
        .normalize('NFKC')
        .normalize('NFD')
        .replace(/[\u0300-\u036F]/g, '')   // Latin accents (é→e, è→e)
        .normalize('NFKC')
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // Arabic diacritics + tatweel
        .replace(/[أإآٱ]/g, 'ا')                    // alef variants
        .replace(/ة/g, 'ه')                         // taa marbuta -> haa
        .replace(/[ىئ]/g, 'ي')                      // alef maqsura / hamza-on-yaa
        .replace(/ؤ/g, 'و')                         // hamza-on-waw
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

// ─── ORDINAL REFERENCE TABLES (AR / DARIJA / FR / EN) ────────────────────────
const ORDINALS: Array<{ index: number | 'last'; patterns: RegExp }> = [
    { index: 0, patterns: /(?:^|\s)(الاول|الاولى|اول(?:\s+واحد|\s+منتج)?|first|1st|premier|premiere)(?:\s|$|[.,!?؟])/ },
    { index: 1, patterns: /(?:^|\s)(الثاني|الثانيه|ثاني(?:\s+واحد|\s+منتج)?|second|2nd|deuxieme)(?:\s|$|[.,!?؟])/ },
    { index: 2, patterns: /(?:^|\s)(الثالث|الثالثه|ثالث(?:\s+واحد|\s+منتج)?|third|3rd|troisieme)(?:\s|$|[.,!?؟])/ },
    { index: 3, patterns: /(?:^|\s)(الرابع|الرابعه|رابع(?:\s+واحد|\s+منتج)?|fourth|4th|quatrieme)(?:\s|$|[.,!?؟])/ },
    { index: 4, patterns: /(?:^|\s)(الخامس|الخامسه|خامس(?:\s+واحد|\s+منتج)?|fifth|5th|cinquieme)(?:\s|$|[.,!?؟])/ },
    { index: 'last', patterns: /(?:^|\s)(الاخير|الاخيره|اخر\s+واحد|اخر\s+منتج|last|dernier|derniere)(?:\s|$|[.,!?؟])/ },
];

// ─── INGREDIENT-AVOID VOCABULARY ─────────────────────────────────────────────
// Maps common user phrasings to a canonical token the tools can filter on.
const AVOID_SYNONYMS: Array<{ token: string; patterns: RegExp }> = [
    { token: 'fragrance', patterns: /عطر|عطور|بارفان|parfum|fragrance|parfum[- ]?free|fragrance[- ]?free/i },
    { token: 'alcohol',   patterns: /كحول|الكحول|alcohol|alcool/i },
    { token: 'paraben',   patterns: /بارابين|paraben/i },
    { token: 'sulfate',   patterns: /كبريتات|سلفات|sulfate|sulphate|sls\b/i },
    { token: 'silicone',  patterns: /سيليكون|silicone/i },
    { token: 'essential_oil', patterns: /زيوت عطريه|huiles? essentielles?|essential oils?/i },
];

// ─── PROFILE EXTRACTION ──────────────────────────────────────────────────────

/** Pulls a canonical skin/hair type out of free user text, if present. */
function detectTargetType(msgNorm: string, msgRaw: string): string | undefined {
    // Possessive forms carry the strongest signal: "بشرتي دهنية", "شعري جاف".
    const possessive = /(?:بشرتي|بشرة\s+عندي|شعري|شعر\s+عندي|ma\s+peau|mes\s+cheveux|my\s+(?:skin|hair))/i;
    const hasPossessive = possessive.test(msgRaw);

    for (const mapping of TARGET_TYPE_MAPPINGS) {
        const hit = mapping.aliases.some(alias => {
            const a = lightNormalize(alias);
            return a.length > 1 && msgNorm.includes(a);
        });
        if (!hit) continue;
        // Without a possessive or explicit type word, "جافة" alone could be a
        // product claim ("مرطب للبشرة الجافة") — require a stronger anchor.
        if (hasPossessive || /نوع\s*بشر|نوع\s*شعر|skin\s*type|type\s*de\s*peau/i.test(msgRaw)) {
            return mapping.catalogTags[0];
        }
    }
    return undefined;
}

/**
 * Removes NEGATED type phrases before extraction runs, so a correction like
 * "بشرتي مو دهنية، بشرتي جافة" / "my skin is NOT oily, it's dry" doesn't
 * record the exact opposite of what the user said. Old code matched "دهنية"
 * and happily stored skin=oily.
 */
function stripNegatedTypes(text: string): string {
    return text.replace(
        /(?:مو|مش|ماشي|ليس(?:ت)?|لا|ما\s*هي(?:ش)?|not|n't|pas)\s+(?:دهنية|دهني|جافة|جاف|حساسة|حساس|مختلطة|عادية|oily|dry|sensitive|combination|combo|normal|grasse?|s[eè]che?s?|sensible|mixte|normale?)/gi,
        ' '
    );
}

/** Budget phrases: "ميزانيتي 5000 دج", "budget 4000 da", "ما يفوتش 3000", centimes. */
export function extractBudget(msgRaw: string): { min?: number; max?: number } {
    const out: { min?: number; max?: number } = {};
    const msg = msgRaw.toLowerCase();

    const direct = msg.match(/(\d{3,6})\s*(?:دج|دينار|dzd|da\b)/);
    if (direct) {
        const v = parseInt(direct[1], 10);
        if (/من\s*\d|ابتداء|starting|at least|على\s*الاقل/.test(msg)) out.min = v;
        else out.max = v;
    }

    // Algerian centimes: "400 ألف سنتيم" = 4000 DZD
    const centimes = msg.match(/(\d+)\s*(?:ألف|الف|alef)\s*(?:سنتيم|سنتيمات|centimes?)?/);
    if (centimes && !direct) {
        out.max = parseInt(centimes[1], 10) * 10;
    }

    // Range: "بين 2000 و 4000"
    const range = msg.match(/(?:بين|between|entre)\s*(\d{3,6})\s*(?:و|and|et)\s*(\d{3,6})/);
    if (range) {
        out.min = Math.min(parseInt(range[1], 10), parseInt(range[2], 10));
        out.max = Math.max(parseInt(range[1], 10), parseInt(range[2], 10));
    }

    return out;
}

/**
 * Merges whatever profile facts a single user message reveals into the
 * session profile. Called once per user turn, before routing, so downstream
 * tool-arg autofill sees the freshest facts.
 */
export function updateProfileFromMessage(state: SessionState, rawMessage: string): void {
    const raw = String(rawMessage || '');
    if (!raw.trim()) return;
    // Negation cleaning happens BEFORE normalization/extraction so "مو دهنية"
    // can't be recorded as skin=oily. Corrections then win naturally because
    // the surviving affirmative phrase is what gets extracted.
    const rawClean = stripNegatedTypes(raw);
    const msgNorm = lightNormalize(rawClean);
    const profile = state.profile;

    // ── Language ──
    if (/[\u0600-\u06FF]/.test(raw)) profile.language = 'ar';
    else if (/\b(bonjour|merci|peau|cheveux|crème|sérum|je\s|est-ce|quelle?s?\b)/i.test(raw)) profile.language = 'fr';
    else profile.language = profile.language || 'en';

    // ── Skin / hair type ──
    const target = detectTargetType(msgNorm, rawClean);
    if (target) {
        if (target.startsWith('شعر') || target.startsWith('فروة')) profile.hairType = target;
        else profile.skinType = target;
    }

    // ── Concerns (claims-flavored words remembered as interests) ──
    const concernPatterns: Array<[RegExp, string]> = [
        [/حب\s*الشباب|حبوب|بثور|acne|boutons/i, 'حب الشباب'],
        [/تفتيح|تبييض|بقع\s*داكنه|تصبغات|كلف|dark spots?|hyperpigmentation|taches/i, 'تفتيح'],
        [/تجاعيد|شيخوخه|wrinkles?|anti[- ]?age|anti-rides/i, 'مكافحة التجاعيد'],
        [/ترطيب|جفاف|hydrat|dry\b/i, 'ترطيب'],
        [/قشره|pellicules?|dandruff/i, 'القشرة'],
        [/تساقط|chute de cheveux|hair loss/i, 'تساقط الشعر'],
        [/هالات|dark circles?|cernes/i, 'الهالات السوداء'],
    ];
    for (const [re, label] of concernPatterns) {
        if (re.test(raw) && !profile.concerns.includes(label)) {
            if (profile.concerns.length < 6) profile.concerns.push(label);
        }
    }

    // ── Allergies ("عندي حساسية من العطور", "allergic to fragrance", "allergie au parfum") ──
    const allergyMatch = raw.match(/(?:حساسية\s*(?:من|ل|عندي\s*حساسية\s*من)?|allerg(?:ic|y)\s*to|allergie\s*(?:au|aux|à la|a))\s*([^.,!؟?\n]{2,40})/i);
    if (allergyMatch) {
        const substance = allergyMatch[1].trim();
        const canonical = canonicalizeSubstance(substance);
        if (canonical && !profile.allergies.includes(canonical)) {
            profile.allergies.push(canonical);
        }
    }

    // ── Avoid ingredients ("بدون كحول", "sans parfum", "fragrance-free", "no sulfates") ──
    const avoidMatch = raw.match(/(?:بدون|من\s*غير|خالي(?:ة)?\s*من|without|free[- ]of|no\s+\w+|sans)\s+([^.,!؟?\n]{2,40})/i);
    if (avoidMatch) {
        const substance = avoidMatch[1].trim();
        const canonical = canonicalizeSubstance(substance);
        if (canonical && !profile.avoidIngredients.includes(canonical)) {
            profile.avoidIngredients.push(canonical);
        }
    }
    // Bare "fragrance-free / خالية من العطور" style tokens
    for (const { token, patterns } of AVOID_SYNONYMS) {
        if (patterns.test(raw) && /بدون|خالي|without|free|sans/i.test(raw)) {
            if (!profile.avoidIngredients.includes(token)) profile.avoidIngredients.push(token);
        }
    }

    // ── Budget ──
    const budget = extractBudget(raw);
    if (budget.max !== undefined) profile.budgetMax = budget.max;
    if (budget.min !== undefined) profile.budgetMin = budget.min;

    // ── Country preference ("أفضل الماركات الجزائرية", "je préfère les produits coréens") ──
    const countryPref = raw.match(/(?:أفضل|أحب|أريد\s*فقط|فقط|only|préfère|prefer|preference)\s+[^.,!؟?\n]{0,25}?(الجزائر|الجزائري[ةه]?|كوريا|كوري[ةه]?|فرنسا|فرنسي[ةه]?|تركيا|تركي[ةه]?|algerian|algeria|korea|korean|france|french|turkey|turkish)/i);
    if (countryPref) {
        const c = countryPref[1].toLowerCase();
        if (/جزائر|alger/i.test(c)) profile.country = 'Algeria';
        else if (/كوريا|كوري|korea/i.test(c)) profile.country = 'Korea';
        else if (/فرنسا|فرنسي|fran/i.test(c)) profile.country = 'France';
        else if (/تركيا|تركي|turk/i.test(c)) profile.country = 'Turkey';
    }

    // ── Preferred brands ("أحب ماركة فينوس", "I love COSRX", "j'aime la roche-posay") ──
    const brandPref = raw.match(/(?:أحب|أفضل|عجبتني|love|like|j'aime|préfère)\s+(?:ماركة\s*|brand\s*|la\s*marque\s*)?([A-Za-z][\w'’-]{2,20}|[\u0600-\u06FF]{3,20})/);
    if (brandPref) {
        const b = brandPref[1].trim();
        if (!profile.preferredBrands.some(x => x.toLowerCase() === b.toLowerCase())
            && profile.preferredBrands.length < 5) {
            profile.preferredBrands.push(b);
        }
    }
}

function canonicalizeSubstance(substance: string): string | undefined {
    for (const { token, patterns } of AVOID_SYNONYMS) {
        if (patterns.test(substance)) return token;
    }
    // Unknown substance: keep the raw words (trimmed, short) so the model at
    // least sees what the user said, but skip pure stop-words.
    const cleaned = substance.replace(/^(ال)/, '').trim();
    if (cleaned.length >= 3 && cleaned.length <= 30) return cleaned;
    return undefined;
}

// ─── ENTITY HISTORY ──────────────────────────────────────────────────────────

/**
 * Records a brand the session engaged with (brand evaluation, brand-scoped
 * search, brand reviews) plus the category involved, if any. Deduped by
 * normalized brand name; most recent engagement wins its position at the end
 * and updates lastBrandFocus — the anchor for "their cleanser?"-style
 * follow-ups.
 */
export function recordBrandInterest(
    state: SessionState,
    brand: string | undefined,
    category: string | undefined,
    source: BrandInterest['source']
): void {
    if (!brand || !brand.trim()) return;
    const key = lightNormalize(brand);
    const existing = state.brandHistory.findIndex(b => lightNormalize(b.brand) === key);
    let entry: BrandInterest;
    if (existing >= 0) {
        entry = state.brandHistory[existing];
        state.brandHistory.splice(existing, 1);
    } else {
        entry = { brand: brand.trim(), categories: [], turn: state.turnCount, source };
    }
    if (category && !entry.categories.includes(category)) entry.categories.push(category);
    entry.turn = state.turnCount;
    entry.source = source;
    state.brandHistory.push(entry);
    while (state.brandHistory.length > MAX_BRANDS) state.brandHistory.shift();
    state.lastBrandFocus = { brand: entry.brand, category, turn: state.turnCount };
}

/**
 * Resolves possessive brand follow-ups: the message mentions a CATEGORY but
 * no brand name, and refers to "their / them" — "and their cleanser?",
 * "و الغسول تاعهم؟", "et leur sérum?" — against the most recent brand this
 * session engaged with. Returns null when there's no brand anchor or no
 * category mention (caller lets the model ask).
 */
export function resolveBrandCategoryReference(
    rawMessage: string,
    state: SessionState
): { brand: string; category?: string } | null {
    const msg = lightNormalize(rawMessage);
    const category = detectCategoryInText(rawMessage);
    if (!category) return null;

    const hasPossessive = /(?:^|\s)(their|theirs|them|تاعهم|حقهم|ديالهم|ليهم|عندهم|منتجاتهم|الخاصه\s+بهم|leur|leurs)(?:\s|$|[.,!?؟])/.test(msg);
    if (!hasPossessive) return null;

    const anchor = state.lastBrandFocus?.brand || state.lastBrandEvaluation?.brand;
    if (!anchor) return null;
    return { brand: anchor, category };
}

/**
 * Records products that were actually surfaced to the user this turn
 * (search results, a single product card, routine steps, an analysis).
 * Deduped by id; most recent discussion wins its position at the end.
 */
export function recordDiscussedProducts(
    state: SessionState,
    products: Array<{ id?: string; brand?: string; name?: string; price?: any; currency?: string }>,
    source: DiscussedProduct['source']
): void {
    if (!Array.isArray(products)) return;
    for (const p of products) {
        if (!p || !p.id) continue;
        const price = typeof p.price === 'object' && p.price !== null
            ? String((p.price as any).min ?? (p.price as any).amount ?? '')
            : (p.price !== undefined ? String(p.price) : undefined);
        const entry: DiscussedProduct = {
            id: p.id,
            brand: p.brand,
            name: p.name,
            price,
            currency: p.currency,
            turn: state.turnCount,
            source,
        };
        const existing = state.productHistory.findIndex(h => h.id === p.id);
        if (existing >= 0) state.productHistory.splice(existing, 1);
        state.productHistory.push(entry);
    }
    while (state.productHistory.length > MAX_HISTORY) state.productHistory.shift();
}

/**
 * Resolves ordinal / demonstrative references in the user's message against
 * what was actually shown this session.
 *
 * Priority:
 *   1. Explicit ordinal ("الثاني", "the third", "le premier") → index into the
 *      currently visible list (last search results, else routine steps).
 *   2. "الأخير / last" → most recent entry of the visible list.
 *   3. Bare demonstrative ("هذا", "this one", "celui-ci") with no ordinal →
 *      state.lastProduct (most recently focused single product).
 *
 * Returns null when nothing resolvable — the caller then lets the model ask.
 */
export function resolveProductReference(
    rawMessage: string,
    state: SessionState
): { product: DiscussedProduct; index: number; listSize: number } | { product: DiscussedProduct } | null {
    const msg = lightNormalize(rawMessage);

    // The "visible list" the user is most likely pointing at.
    const visibleList: DiscussedProduct[] =
        state.lastProductResults && state.lastProductResults.length > 0
            ? state.lastProductResults.map((p: any) => ({
                id: p.id, brand: p.brand, name: p.name,
                price: p.price !== undefined ? String(p.price) : undefined,
                currency: p.currency, turn: state.turnCount, source: 'search' as const,
            }))
        : state.lastRoutine?.steps?.length
            ? state.lastRoutine.steps.map((s: any) => ({
                id: s.product?.id, brand: s.product?.brand, name: s.product?.name,
                price: s.product?.price !== undefined ? String(s.product.price) : undefined,
                currency: s.product?.currency, turn: state.turnCount, source: 'routine' as const,
            })).filter((d: DiscussedProduct) => d.id)
            : [];

    for (const { index, patterns } of ORDINALS) {
        if (patterns.test(msg)) {
            if (visibleList.length === 0) return null;
            const idx = index === 'last' ? visibleList.length - 1 : index;
            if (idx >= 0 && idx < visibleList.length) {
                return { product: visibleList[idx], index: idx, listSize: visibleList.length };
            }
            return null; // ordinal out of range — let the model ask, don't guess
        }
    }

    // Demonstrative without ordinal
    if (/(?:^|\s)(هذا|هذه|هاد|ذاك|تاع|this|that|celui|celle|ce\s+produit)(?:\s|$|[.,!?؟])/.test(msg)) {
        if (state.lastProduct?.id) {
            return {
                product: {
                    id: state.lastProduct.id,
                    brand: state.lastProduct.brand,
                    name: state.lastProduct.name,
                    price: state.lastProduct.price !== undefined ? String(state.lastProduct.price) : undefined,
                    currency: state.lastProduct.currency,
                    turn: state.turnCount,
                    source: 'product',
                },
            };
        }
        if (state.lastAnalysis?.productId) {
            return {
                product: {
                    id: state.lastAnalysis.productId,
                    brand: state.lastAnalysis.brand,
                    name: state.lastAnalysis.name,
                    turn: state.turnCount,
                    source: 'analysis',
                },
            };
        }
    }

    return null;
}

// ─── CONTEXT DIGEST ──────────────────────────────────────────────────────────

/**
 * Builds the [Context: ...] lines injected into the model's message. Includes
 * the classic last-X hints (kept byte-compatible with what prompt.ts Section 3
 * teaches the model to expect) PLUS the new session profile digest and the
 * product-history list.
 */
export function buildContextDigest(state: SessionState): string[] {
    const hints: string[] = [];

    // 1. Session profile (NEW)
    const p = state.profile;
    const profileParts: string[] = [];
    if (p.skinType) profileParts.push(`skin=${p.skinType}`);
    if (p.hairType) profileParts.push(`hair=${p.hairType}`);
    if (p.concerns.length) profileParts.push(`concerns=[${p.concerns.join(', ')}]`);
    if (p.allergies.length) profileParts.push(`ALLERGIES=[${p.allergies.join(', ')}]`);
    if (p.avoidIngredients.length) profileParts.push(`avoid=[${p.avoidIngredients.join(', ')}]`);
    if (p.budgetMax !== undefined) profileParts.push(`budget≤${p.budgetMax} DZD`);
    if (p.budgetMin !== undefined) profileParts.push(`budget≥${p.budgetMin} DZD`);
    if (p.country) profileParts.push(`prefers=${p.country}`);
    if (p.preferredBrands.length) profileParts.push(`likes brands=[${p.preferredBrands.join(', ')}]`);
    if (profileParts.length > 0) {
        hints.push(`[Context: User profile (this session only): ${profileParts.join(' | ')}]`);
    }

    // 2. Routine (classic)
    if (state.lastRoutine) {
        const stepList = (state.lastRoutine.steps || [])
            .map((s: any) => `${s.stepNumber}) ${s.product.brand} ${s.product.name} [ID: ${s.product.id}, Price: ${s.product.price} ${s.product.currency}]`)
            .join('، ');
        hints.push(`[Context: Built routine "${state.lastRoutine.title}" with ${state.lastRoutine.stepsCount} steps, total ${state.lastRoutine.totalCost} DZD — products: ${stepList}]`);
    }

    // 3. Visible product list (classic)
    if (state.lastProductResults && state.lastProductResults.length > 0) {
        const list = state.lastProductResults
            .map((p: any, i: number) => `${i + 1}) ${p.brand} ${p.name} [ID: ${p.id}, Price: ${p.price} ${p.currency}]`)
            .join('، ');
        hints.push(`[Context: Products shown to user (numbered — "the second one" = #2): ${list}]`);
    }

    // 4. Last single product (classic)
    if (state.lastProduct) {
        hints.push(`[Context: Last product discussed = "${state.lastProduct.brand} ${state.lastProduct.name}" [ID: ${state.lastProduct.id}]]`);
    }

    // 5. Last analysis (classic)
    if (state.lastAnalysis) {
        const score = state.lastAnalysis.evaluation?.oilGuardScore;
        const verdict = state.lastAnalysis.evaluation?.finalVerdict;
        hints.push(`[Context: Evaluated ${state.lastAnalysis.name} [ID: ${state.lastAnalysis.productId}] (Score: ${score}/100, Verdict: ${verdict})]`);
    }

    // 6. Last brand evaluation (classic, aligned with prompt.ts wording)
    if (state.lastBrandEvaluation) {
        const b = state.lastBrandEvaluation;
        hints.push(`[Context: Brand Review shown for "${b.brand}" (Sample: ${b.sampleSize} products, Avg Score: ${b.verdict?.avgScore}/100, Verdict: ${b.verdict?.tier})]`);
    }

    // 7. Community reviews (NEW — was never hinted before)
    if (state.lastReviewData) {
        hints.push(`[Context: Community reviews shown for "${state.lastReviewData.productName}" (satisfaction: ${state.lastReviewData.satisfactionRate ?? 'n/a'})]`);
    }

    // 7b. Brand interest history (NEW) — every brand the session engaged with
    //     and WHICH categories of it were asked about. This is what lets the
    //     model answer "and their cleanser?" without re-asking the brand.
    if (state.brandHistory.length > 0) {
        const list = state.brandHistory
            .map(b => `${b.brand}${b.categories.length ? ` (asked about: ${b.categories.join(', ')})` : ''}`)
            .join(' | ');
        hints.push(`[Context: Brand interests this session (oldest→newest): ${list} — "their X" / "تاعهم" refers to the most recent one${state.lastBrandFocus?.brand ? ` (currently: "${state.lastBrandFocus.brand}")` : ''}]`);
    }

    // 7c. Last comparison (NEW) — for "why did the second one win?" follow-ups.
    if (state.lastComparison?.entries?.length) {
        const names = state.lastComparison.entries.map((e: any) => `${e.brand} ${e.name}`).join(' vs. ');
        const winner = state.lastComparison.winners?.overall?.label;
        hints.push(`[Context: Comparison shown: ${names}${winner ? ` — overall winner: ${winner}` : ''}]`);
    }

    // 7d. Last raw ingredient check (NEW) — for "which ingredient is the problem?".
    if (state.lastIngredientCheck) {
        const c = state.lastIngredientCheck;
        hints.push(`[Context: Raw ingredient list checked ("${c.label}", ${c.ingredientCount} ingredients, Score: ${c.score ?? 'n/a'}/100)${c.allergenHits?.length ? ` — allergen hits: ${c.allergenHits.join(', ')}` : ''}]`);
    }

    // 8. Entity history tail (NEW) — only when it adds information beyond the
    //    last-X hints (i.e. more than one distinct discussion).
    if (state.productHistory.length > 1) {
        const tail = state.productHistory.slice(-6)
            .map(h => `${h.brand || ''} ${h.name || ''} [${h.id}]`.trim())
            .join(' | ');
        hints.push(`[Context: Product discussion history (oldest→newest): ${tail}]`);
    }

    return hints;
}

// ─── THE STORE ───────────────────────────────────────────────────────────────

interface StoreEntry {
    state: SessionState;
    updatedAt: number;
}

export class SessionMemory {
    private store = new Map<string, StoreEntry>();
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        // Background sweep so expired sessions die even under low traffic
        // (the old code only cleaned up past 1000 sessions, letting stale
        // entries sit forever on a quiet server).
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        // Never keep the Node process alive just for the sweeper.
        const timer = this.sweepTimer as any;
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    private freshState(): SessionState {
        return {
            lastProductResults: null,
            lastProduct: null,
            lastAnalysis: null,
            lastRoutine: null,
            lastBrandEvaluation: null,
            lastReviewData: null,
            lastComparison: null,
            lastIngredientCheck: null,
            profile: {
                concerns: [],
                allergies: [],
                avoidIngredients: [],
                preferredBrands: [],
            },
            productHistory: [],
            brandHistory: [],
            lastBrandFocus: null,
            recentQueries: [],
            turnCount: 0,
            createdAt: Date.now(),
        };
    }

    getOrCreate(sessionId: string): SessionState {
        const now = Date.now();
        const existing = this.store.get(sessionId);
        if (existing && now - existing.updatedAt < SESSION_TTL_MS) {
            // Touch on READ as well as write — an active reader shouldn't see
            // their session expire between two rapid turns.
            existing.updatedAt = now;
            // Refresh LRU position.
            this.store.delete(sessionId);
            this.store.set(sessionId, existing);
            return existing.state;
        }
        if (existing) this.store.delete(sessionId);
        const state = this.freshState();
        this.store.set(sessionId, { state, updatedAt: now });
        this.evictIfNeeded();
        return state;
    }

    touch(sessionId: string): void {
        const entry = this.store.get(sessionId);
        if (entry) entry.updatedAt = Date.now();
    }

    /** Hard cap: evict least-recently-used sessions beyond MAX_SESSIONS. */
    private evictIfNeeded(): void {
        if (this.store.size <= MAX_SESSIONS) return;
        const excess = this.store.size - MAX_SESSIONS;
        let removed = 0;
        for (const key of this.store.keys()) { // Map iteration = insertion order (LRU first)
            if (removed >= excess) break;
            this.store.delete(key);
            removed++;
        }
        if (removed > 0) console.log(`[SESSION] Evicted ${removed} LRU sessions (cap ${MAX_SESSIONS})`);
    }

    /** TTL sweep: drop sessions idle longer than SESSION_TTL_MS. */
    private sweep(): void {
        const cutoff = Date.now() - SESSION_TTL_MS;
        let removed = 0;
        for (const [key, val] of this.store) {
            if (val.updatedAt < cutoff) {
                this.store.delete(key);
                removed++;
            }
        }
        if (removed > 0) console.log(`[SESSION] Swept ${removed} expired sessions`);
    }

    /** Diagnostics for /health-style endpoints. */
    stats() {
        return { activeSessions: this.store.size, maxSessions: MAX_SESSIONS, ttlMs: SESSION_TTL_MS };
    }

    destroy(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.store.clear();
    }
}

// ─── SINGLETON ───────────────────────────────────────────────────────────────
// Single shared instance for the process — same semantics as the old
// module-level sessionStore, but with the richer state shape.
export const sessionMemory = new SessionMemory();
