/**
 * Local (zero-network) ingredient knowledge shared by the new tools:
 *   - product_contains      → "does it have parfum / alcohol / retinol…?"
 *   - find_alternatives     → rank substitutes by SHARED ACTIVES
 *   - check_compatibility   → interaction rules + AM/PM placement
 *
 * ⚠️ REVIEW NOTICE: INTERACTION_RULES / PLACEMENT / the pregnancy note are
 * skincare-safety statements. They follow widely accepted dermatology
 * guidance, but they are deliberately conservative and should be reviewed by
 * someone qualified before shipping. Nothing here replaces medical advice.
 */
import { normalizeArabicText } from './taxonomy';

export type Lang = 'ar' | 'fr' | 'en';
export type L10n = { ar: string; fr: string; en: string };
export const pick = (t: L10n, lang: Lang | undefined): string => t[lang || 'ar'] || t.ar;

export interface IngredientConcept {
    key: string;
    label: L10n;
    /** user-facing names in any language (matched after Arabic normalization). */
    aliases: string[];
    /** True when an INCI entry (lowercased) belongs to this concept. */
    test: (inci: string) => boolean;
    /** true = counts as a "key active" for alternatives / compatibility. */
    active?: boolean;
}

const re = (r: RegExp) => (s: string) => r.test(s);
const FATTY_ALCOHOL = /(cetyl|stearyl|cetearyl|behenyl|arachidyl|myristyl|lauryl|isostearyl|benzyl|phenethyl|lanolin|coconut)\s*alcohol|alcohol\s*(cetyl)/i;

export const CONCEPTS: IngredientConcept[] = [
    { key: 'fragrance', label: { ar: 'العطر', fr: 'parfum', en: 'fragrance' },
      aliases: ['fragrance', 'parfum', 'perfume', 'عطر', 'عطور', 'رائحه', 'رائحة', 'معطر'],
      test: re(/\bparfum\b|fragrance|aroma\b/i) },
    { key: 'alcohol', label: { ar: 'الكحول المجفف', fr: 'alcool', en: 'drying alcohol' },
      aliases: ['alcohol', 'alcool', 'كحول', 'الكحول', 'ايثانول', 'إيثانول', 'ethanol'],
      test: s => !FATTY_ALCOHOL.test(s) && /\balcohol\b|ethanol|isopropyl alcohol|sd alcohol|alcohol denat/i.test(s) },
    { key: 'paraben', label: { ar: 'البارابين', fr: 'parabène', en: 'parabens' },
      aliases: ['paraben', 'parabens', 'parabène', 'بارابين', 'البارابين'],
      test: re(/paraben/i) },
    { key: 'sulfate', label: { ar: 'السلفات', fr: 'sulfates', en: 'sulfates' },
      aliases: ['sulfate', 'sulfates', 'sulphate', 'sls', 'sles', 'سلفات', 'كبريتات', 'السلفات'],
      test: re(/sodium (lauryl|laureth|coco) sulf|ammonium lauryl sulf|sulphate/i) },
    { key: 'silicone', label: { ar: 'السيليكون', fr: 'silicones', en: 'silicones' },
      aliases: ['silicone', 'silicones', 'سيليكون', 'السيليكون'],
      test: re(/dimethicone|siloxane|cyclomethicone|methicone|silicone/i) },
    { key: 'essential_oil', label: { ar: 'الزيوت العطرية', fr: 'huiles essentielles', en: 'essential oils' },
      aliases: ['essential oil', 'huile essentielle', 'زيت عطري', 'زيوت عطرية'],
      test: re(/essential oil|lavandula|mentha|eucalyptus|citrus (aurantium|limon)|rosmarinus.*oil|limonene|linalool|citral|eugenol|geraniol/i) },
    { key: 'coconut', label: { ar: 'زيت جوز الهند', fr: 'huile de coco', en: 'coconut oil' },
      aliases: ['coconut oil', 'huile de coco', 'زيت جوز الهند', 'زيت الكوكو', 'جوز الهند'],
      test: re(/cocos nucifera/i) },

    { key: 'retinoid', label: { ar: 'الريتينول/الريتينويد', fr: 'rétinoïde', en: 'retinoid' }, active: true,
      aliases: ['retinol', 'retinoid', 'retinal', 'tretinoin', 'adapalene', 'rétinol', 'ريتينول', 'الريتينول', 'ريتينويد', 'ريتينال'],
      test: re(/retinol|retinal\b|retinyl|retinoate|tretinoin|adapalene/i) },
    { key: 'vitc', label: { ar: 'فيتامين سي', fr: 'vitamine C', en: 'vitamin C' }, active: true,
      aliases: ['vitamin c', 'vit c', 'vitamine c', 'ascorbic', 'فيتامين سي', 'فيتامين c', 'فيتامين ج', 'حمض الاسكوربيك', 'اسكوربيك'],
      test: re(/ascorb/i) },
    { key: 'niacinamide', label: { ar: 'النياسيناميد', fr: 'niacinamide', en: 'niacinamide' }, active: true,
      aliases: ['niacinamide', 'nicotinamide', 'نياسيناميد', 'النياسيناميد', 'نياسينمايد', 'فيتامين b3', 'فيتامين ب3'],
      test: re(/niacinamide|nicotinamide/i) },
    { key: 'aha', label: { ar: 'أحماض AHA', fr: 'AHA', en: 'AHA acids' }, active: true,
      aliases: ['aha', 'glycolic', 'lactic acid', 'mandelic', 'malic acid', 'جليكوليك', 'حمض الجليكوليك', 'لاكتيك', 'حمض اللاكتيك', 'ماندليك', 'احماض الفا', 'أحماض ألفا'],
      test: re(/glycolic|lactic acid|mandelic|malic acid|tartaric acid/i) },
    { key: 'bha', label: { ar: 'حمض الساليسيليك BHA', fr: 'BHA / acide salicylique', en: 'BHA / salicylic acid' }, active: true,
      aliases: ['bha', 'salicylic', 'salicylic acid', 'acide salicylique', 'ساليسيليك', 'حمض الساليسيليك', 'سالسيليك', 'سالسيليك اسيد'],
      test: re(/salicylic|betaine salicylate|willow bark/i) },
    { key: 'pha', label: { ar: 'أحماض PHA', fr: 'PHA', en: 'PHA acids' }, active: true,
      aliases: ['pha', 'gluconolactone', 'lactobionic'],
      test: re(/gluconolactone|lactobionic/i) },
    { key: 'benzoyl', label: { ar: 'بنزويل بيروكسايد', fr: 'peroxyde de benzoyle', en: 'benzoyl peroxide' }, active: true,
      aliases: ['benzoyl peroxide', 'peroxyde de benzoyle', 'بنزويل', 'بنزويل بيروكسايد', 'بيروكسيد البنزويل'],
      test: re(/benzoyl peroxide/i) },
    { key: 'azelaic', label: { ar: 'حمض الأزيليك', fr: 'acide azélaïque', en: 'azelaic acid' }, active: true,
      aliases: ['azelaic', 'azelaic acid', 'acide azélaïque', 'ازيليك', 'أزيليك', 'حمض الازيليك'],
      test: re(/azelaic|azeloglycine/i) },
    { key: 'hyaluronic', label: { ar: 'حمض الهيالورونيك', fr: 'acide hyaluronique', en: 'hyaluronic acid' }, active: true,
      aliases: ['hyaluronic', 'hyaluronic acid', 'hyaluronate', 'acide hyaluronique', 'هيالورونيك', 'هيالورون', 'الهيالورونيك', 'هيالرونيك'],
      test: re(/hyaluron/i) },
    { key: 'ceramide', label: { ar: 'السيراميد', fr: 'céramides', en: 'ceramides' }, active: true,
      aliases: ['ceramide', 'ceramides', 'céramide', 'سيراميد', 'السيراميد', 'سيرامايد'],
      test: re(/ceramide/i) },
    { key: 'zinc', label: { ar: 'الزنك', fr: 'zinc', en: 'zinc' }, active: true,
      aliases: ['zinc', 'زنك', 'الزنك', 'زينك'],
      test: re(/zinc (pca|gluconate|sulfate)|\bzinc\b(?! oxide)/i) },
    { key: 'sulfur', label: { ar: 'الكبريت', fr: 'soufre', en: 'sulfur' }, active: true,
      aliases: ['sulfur', 'sulphur', 'soufre', 'كبريت', 'الكبريت'],
      test: re(/^sulfur$|^sulphur$|\bsulfur\b|\bsulphur\b/i) },
    { key: 'peptide', label: { ar: 'الببتيدات', fr: 'peptides', en: 'peptides' }, active: true,
      aliases: ['peptide', 'peptides', 'peptide', 'ببتيد', 'ببتيدات', 'الببتيدات'],
      test: re(/peptide|palmitoyl|matrixyl|argireline/i) },
    { key: 'panthenol', label: { ar: 'البانثينول', fr: 'panthénol', en: 'panthenol' }, active: true,
      aliases: ['panthenol', 'provitamin b5', 'panthénol', 'بانثينول', 'البانثينول', 'فيتامين b5'],
      test: re(/panthenol|pantothen/i) },
    { key: 'centella', label: { ar: 'السنتيلا (سيكا)', fr: 'centella (cica)', en: 'centella (cica)' }, active: true,
      aliases: ['centella', 'cica', 'madecassoside', 'سنتيلا', 'سيكا', 'سنتلا'],
      test: re(/centella|madecass|asiatic/i) },
    { key: 'tea_tree', label: { ar: 'شجرة الشاي', fr: 'arbre à thé', en: 'tea tree' }, active: true,
      aliases: ['tea tree', 'arbre à thé', 'melaleuca', 'شجرة الشاي', 'تي تري'],
      test: re(/melaleuca|tea tree/i) },
    { key: 'arbutin', label: { ar: 'الأربيوتين', fr: 'arbutine', en: 'arbutin' }, active: true,
      aliases: ['arbutin', 'arbutine', 'اربيوتين', 'أربيوتين'],
      test: re(/arbutin/i) },
    { key: 'kojic', label: { ar: 'حمض الكوجيك', fr: 'acide kojique', en: 'kojic acid' }, active: true,
      aliases: ['kojic', 'kojic acid', 'كوجيك', 'حمض الكوجيك'],
      test: re(/kojic/i) },
    { key: 'tranexamic', label: { ar: 'حمض الترانيكساميك', fr: 'acide tranexamique', en: 'tranexamic acid' }, active: true,
      aliases: ['tranexamic', 'tranexamic acid', 'ترانيكساميك', 'ترانكساميك'],
      test: re(/tranexamic/i) },
    { key: 'urea', label: { ar: 'اليوريا', fr: 'urée', en: 'urea' }, active: true,
      aliases: ['urea', 'urée', 'يوريا', 'اليوريا'],
      test: re(/\burea\b/i) },
    { key: 'squalane', label: { ar: 'السكوالين', fr: 'squalane', en: 'squalane' }, active: true,
      aliases: ['squalane', 'squalene', 'سكوالين', 'سكوالان'],
      test: re(/squalane|squalene/i) },
    { key: 'caffeine', label: { ar: 'الكافيين', fr: 'caféine', en: 'caffeine' }, active: true,
      aliases: ['caffeine', 'caféine', 'كافيين', 'الكافيين'],
      test: re(/caffeine/i) },
    { key: 'glycerin', label: { ar: 'الجليسرين', fr: 'glycérine', en: 'glycerin' },
      aliases: ['glycerin', 'glycerine', 'glycérine', 'جليسرين', 'الجليسرين', 'غليسرين'],
      test: re(/glycerin|glycerol/i) },
    { key: 'tocopherol', label: { ar: 'فيتامين E', fr: 'vitamine E', en: 'vitamin E' }, active: true,
      aliases: ['tocopherol', 'vitamin e', 'vitamine e', 'فيتامين e', 'فيتامين هاء', 'توكوفيرول'],
      test: re(/tocopher/i) },
    { key: 'uv_filter', label: { ar: 'فلاتر الشمس', fr: 'filtres UV', en: 'UV filters' }, active: true,
      aliases: ['uv filter', 'spf filter', 'فلتر شمس', 'فلاتر الشمس'],
      test: re(/avobenzone|octocrylene|octinoxate|ethylhexyl methoxycinnamate|homosalate|tinosorb|uvinul|zinc oxide|titanium dioxide|ensulizole|oxybenzone|bemotrizinol|bisoctrizole|ethylhexyl triazone|diethylamino hydroxybenzoyl/i) },
];

const CONCEPT_BY_KEY = new Map(CONCEPTS.map(c => [c.key, c]));
export const getConcept = (key: string) => CONCEPT_BY_KEY.get(key);

// ── user text → concept ──────────────────────────────────────────────────────
const ALIAS_INDEX: Array<{ alias: string; concept: IngredientConcept }> = CONCEPTS
    .flatMap(c => c.aliases.map(a => ({ alias: normalizeArabicText(a), concept: c })))
    .filter(x => x.alias.length >= 2)
    .sort((a, b) => b.alias.length - a.alias.length);   // longest alias wins

/** Short Latin aliases (aha, bha, sls, cica…) must match as whole words. */
function aliasHits(textNorm: string, alias: string): boolean {
    if (/^[a-z0-9 ]+$/.test(alias) && alias.length <= 4) {
        return new RegExp(`(^|[^a-z0-9])${alias}([^a-z0-9]|$)`).test(textNorm);
    }
    return textNorm.includes(alias);
}

export function resolveConcept(userText: string): IngredientConcept | null {
    const t = normalizeArabicText(userText || '');
    if (!t) return null;
    for (const { alias, concept } of ALIAS_INDEX) {
        if (aliasHits(t, alias)) return concept;
    }
    return null;
}

/** ALL concepts mentioned in free text (for "retinol with vitamin c"). */
export function resolveAllConcepts(userText: string): IngredientConcept[] {
    const t = normalizeArabicText(userText || '');
    const found = new Map<string, IngredientConcept>();
    for (const { alias, concept } of ALIAS_INDEX) {
        if (!found.has(concept.key) && aliasHits(t, alias)) found.set(concept.key, concept);
    }
    return [...found.values()];
}

// ── ingredient list → matches ────────────────────────────────────────────────
export interface IngredientMatch { name: string; position: number }

export function matchConceptInList(concept: IngredientConcept, list: string[]): IngredientMatch[] {
    const out: IngredientMatch[] = [];
    list.forEach((name, i) => {
        if (concept.test(String(name).toLowerCase())) out.push({ name, position: i + 1 });
    });
    return out;
}

/** Literal fallback when the asked ingredient is not a known concept. */
export function matchLiteralInList(needle: string, list: string[]): IngredientMatch[] {
    const n = normalizeArabicText(needle);
    if (n.length < 3) return [];
    const out: IngredientMatch[] = [];
    list.forEach((name, i) => {
        if (normalizeArabicText(name).includes(n)) out.push({ name, position: i + 1 });
    });
    return out;
}

/** concept key → matched INCI names, only for concepts flagged as actives. */
export function detectActives(list: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const c of CONCEPTS) {
        if (!c.active) continue;
        const hits = matchConceptInList(c, list).map(m => m.name);
        if (hits.length) out.set(c.key, hits);
    }
    return out;
}

/** Any concept (active or not) → names; used for compatibility scans. */
export function detectConcepts(list: string[], keys: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const k of keys) {
        const c = CONCEPT_BY_KEY.get(k);
        if (!c) continue;
        const hits = matchConceptInList(c, list).map(m => m.name);
        if (hits.length) out.set(k, hits);
    }
    return out;
}

// ── interaction rules ────────────────────────────────────────────────────────
export type Severity = 'avoid_together' | 'caution' | 'ok';

export interface InteractionRule {
    a: string;
    b: string;
    severity: Severity;
    advice: L10n;
}

export const INTERACTION_RULES: InteractionRule[] = [
    { a: 'retinoid', b: 'aha', severity: 'caution', advice: {
        ar: 'كلاهما مقشّر ومهيّج؛ لا تضعهما في نفس الليلة — بدّل الأيام (ليلة ريتينول وليلة أحماض).',
        fr: 'Deux actifs exfoliants/irritants : ne les utilisez pas le même soir, alternez les soirs.',
        en: 'Both exfoliate and can irritate — do not use them the same night; alternate nights.' } },
    { a: 'retinoid', b: 'bha', severity: 'caution', advice: {
        ar: 'خطر جفاف وتهيّج عند الجمع؛ استعملهما في ليالٍ مختلفة وابدأ بالتدريج.',
        fr: 'Risque de sécheresse/irritation : utilisez-les des soirs différents, progressivement.',
        en: 'Risk of dryness and irritation together — use on different nights and build up gradually.' } },
    { a: 'retinoid', b: 'benzoyl', severity: 'avoid_together', advice: {
        ar: 'بنزويل بيروكسايد قد يُتلف الريتينول ويزيد التهيّج؛ خصّص أحدهما للصباح والآخر للمساء.',
        fr: 'Le peroxyde de benzoyle peut dégrader le rétinol et irriter : un le matin, l\'autre le soir.',
        en: 'Benzoyl peroxide can degrade retinol and irritate — one in the morning, the other at night.' } },
    { a: 'retinoid', b: 'vitc', severity: 'caution', advice: {
        ar: 'الأفضل فيتامين سي صباحاً والريتينول مساءً بدل الجمع بينهما في نفس الروتين.',
        fr: 'Idéal : vitamine C le matin, rétinol le soir plutôt que dans la même routine.',
        en: 'Best split: vitamin C in the morning, retinol at night rather than in the same routine.' } },
    { a: 'vitc', b: 'aha', severity: 'caution', advice: {
        ar: 'قد يسبب تهيجاً عند الجمع؛ افصل بينهما (صباحاً/مساءً) أو بدّل الأيام.',
        fr: 'Peut irriter ensemble : séparez (matin/soir) ou alternez les jours.',
        en: 'May irritate together — separate (AM/PM) or alternate days.' } },
    { a: 'vitc', b: 'bha', severity: 'caution', advice: {
        ar: 'قد يسبب تهيجاً عند الجمع؛ افصل بينهما أو بدّل الأيام.',
        fr: 'Peut irriter ensemble : séparez-les ou alternez les jours.',
        en: 'May irritate together — separate them or alternate days.' } },
    { a: 'vitc', b: 'benzoyl', severity: 'avoid_together', advice: {
        ar: 'بنزويل بيروكسايد يؤكسد فيتامين سي ويُضعف مفعوله؛ لا تجمعهما في نفس الروتين.',
        fr: 'Le peroxyde de benzoyle oxyde la vitamine C et l\'affaiblit : pas dans la même routine.',
        en: 'Benzoyl peroxide oxidizes vitamin C and weakens it — keep them in separate routines.' } },
    { a: 'aha', b: 'bha', severity: 'caution', advice: {
        ar: 'الجمع بين حمضين مقشرين قد يؤدي لتقشير زائد؛ استعمل واحداً في المرة أو بدّل الأيام.',
        fr: 'Deux acides exfoliants = risque de sur-exfoliation : un seul à la fois ou alternez.',
        en: 'Two exfoliating acids risk over-exfoliation — use one at a time or alternate days.' } },
    { a: 'benzoyl', b: 'aha', severity: 'caution', advice: {
        ar: 'تهيّج وجفاف محتمل عند الجمع؛ لا تضعهما معاً في نفس الوقت.',
        fr: 'Sécheresse/irritation possibles : ne pas appliquer en même temps.',
        en: 'Possible dryness and irritation — do not apply at the same time.' } },
    { a: 'benzoyl', b: 'bha', severity: 'caution', advice: {
        ar: 'تهيّج وجفاف محتمل عند الجمع؛ استعملهما في أوقات مختلفة.',
        fr: 'Sécheresse/irritation possibles : à des moments différents.',
        en: 'Possible dryness and irritation — use at different times.' } },
    { a: 'niacinamide', b: 'vitc', severity: 'ok', advice: {
        ar: 'لا يوجد تعارض يُذكر — الاعتقاد القديم بأنهما يتعارضان غير دقيق مع التركيبات الحديثة.',
        fr: 'Aucun conflit notable — l\'ancienne croyance ne vaut pas pour les formules modernes.',
        en: 'No notable conflict — the old "they clash" claim does not hold for modern formulas.' } },
];

export function findRule(a: string, b: string): InteractionRule | undefined {
    return INTERACTION_RULES.find(r => (r.a === a && r.b === b) || (r.a === b && r.b === a));
}

// ── AM/PM placement ──────────────────────────────────────────────────────────
export type Placement = 'AM' | 'PM' | 'either';
export const PLACEMENT: Record<string, Placement> = {
    retinoid: 'PM', aha: 'PM', bha: 'PM', pha: 'PM',
    vitc: 'AM', uv_filter: 'AM',
};
export const placementOf = (key: string): Placement => PLACEMENT[key] || 'either';

/** Concepts that make daily sunscreen the following morning important. */
export const PHOTOSENSITIZING = ['retinoid', 'aha', 'bha'];

export const PREGNANCY_NOTE: L10n = {
    ar: 'الريتينويد يُنصح بتجنبه أثناء الحمل/الرضاعة — استشيري طبيبك قبل استعماله.',
    fr: 'Les rétinoïdes sont déconseillés pendant la grossesse/allaitement — demandez conseil à votre médecin.',
    en: 'Retinoids are generally advised against during pregnancy/breastfeeding — check with your doctor first.',
};
