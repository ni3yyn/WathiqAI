/**
 * "Why this one?" — honest, deterministic explanation of a recommendation, plus a
 * calibrated statement of how much we actually know about the product.
 *
 * Everything here comes from data we hold (filters that matched, shared actives,
 * the OilGuard evaluation if one was run, price on file, the user's avoid list…).
 * Nothing is invented; missing data becomes an explicit caveat.
 */
import { detectActives, getConcept, resolveConcept, matchConceptInList, L10n } from './ingredientKnowledge';
import { normalizeArabicText } from './taxonomy';

export interface ExplainContext {
    searchArgs?: any;
    evaluation?: { score?: number; safety?: number; efficacy?: number; claimsVerified?: number; claimsTotal?: number };
    ownedByUser?: boolean;
    avoid?: string[];
    profile?: { skinType?: string; country?: string; budgetMax?: number };
    rank?: { index: number; total: number };
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface DataConfidence {
    level: ConfidenceLevel;
    flags: { hasIngredients: boolean; hasPrice: boolean; hasClaims: boolean; hasTargetTypes: boolean; communitySubmitted: boolean };
}

const T = (ar: string, fr: string, en: string): L10n => ({ ar, fr, en });

export function dataConfidence(p: any): DataConfidence {
    const flags = {
        hasIngredients: (p.ingredientList?.length || 0) >= 3,
        hasPrice: p.priceMin !== undefined && p.priceMin !== null || p.priceMax !== undefined && p.priceMax !== null,
        hasClaims: (p.marketingClaims?.length || 0) > 0,
        hasTargetTypes: (p.targetTypes?.length || 0) > 0,
        communitySubmitted: !!p.communitySubmitted,
    };
    const level: ConfidenceLevel = flags.hasIngredients && flags.hasPrice && flags.hasClaims ? 'high' : flags.hasIngredients ? 'medium' : 'low';
    return { level, flags };
}

const norm = (s: string) => normalizeArabicText(String(s || ''));

export function explainPick(p: any, ctx: ExplainContext = {}) {
    const reasons: L10n[] = [];
    const caveats: L10n[] = [];
    const a = ctx.searchArgs || {};
    const name = `${p.brand} ${p.name}`.trim();

    // 1. target skin/hair type
    const wanted = a.skin_type || a.hair_type || ctx.profile?.skinType;
    if (wanted && (p.targetTypes || []).some((t: string) => norm(t).includes(norm(wanted)) || norm(wanted).includes(norm(t)))) {
        reasons.push(T(`موجّه لـ«${wanted}» حسب ما تذكره الشركة`, `Destiné à « ${wanted} » selon la marque`, `Aimed at "${wanted}" according to the brand`));
    }
    // 2. claims requested
    const claims: string[] = Array.isArray(a.marketing_claims) ? a.marketing_claims : a.marketing_claims ? [a.marketing_claims] : [];
    const matchedClaims = claims.filter(c => (p.marketingClaims || []).some((m: string) => norm(m).includes(norm(c)) || norm(c).includes(norm(m))));
    if (matchedClaims.length) reasons.push(T(`يطابق ما طلبت: ${matchedClaims.join('، ')}`, `Correspond à votre demande : ${matchedClaims.join(', ')}`, `Matches what you asked for: ${matchedClaims.join(', ')}`));
    // 3. requested active ingredient
    if (a.active_ingredient) {
        const c = resolveConcept(String(a.active_ingredient));
        const hits = c ? matchConceptInList(c, p.ingredientList || []) : [];
        if (c && hits.length) reasons.push(T(`يحتوي ${c.label.ar} (رقم ${hits[0].position} في القائمة)`, `Contient ${c.label.fr} (n°${hits[0].position})`, `Contains ${c.label.en} (#${hits[0].position} in the list)`));
    }
    // 4. category / country
    if (a.category && p.category) reasons.push(T(`من الفئة المطلوبة (${p.categoryLabel || p.category})`, `Dans la catégorie demandée (${p.categoryLabel || p.category})`, `In the category you wanted (${p.categoryLabel || p.category})`));
    if (a.country && p.country) reasons.push(T(`صنع في ${p.country}`, `Fabriqué : ${p.country}`, `Made in ${p.country}`));
    // 5. price vs budget
    const price = p.priceMin ?? p.priceMax;
    const budget = a.max_price || ctx.profile?.budgetMax;
    if (price && budget && (p.priceMax ?? price) <= budget) reasons.push(T(`سعره ${p.price} ${p.currency || 'دج'} ضمن ميزانيتك (${budget})`, `Son prix (${p.price}) entre dans votre budget (${budget})`, `Its price (${p.price}) fits your budget (${budget})`));
    // 6. evaluation
    if (ctx.evaluation?.score !== undefined) {
        reasons.push(T(`تقييم OilGuard: ${ctx.evaluation.score}/100${ctx.evaluation.safety !== undefined ? ` (السلامة ${ctx.evaluation.safety}، الفعالية ${ctx.evaluation.efficacy})` : ''}`, `Score OilGuard : ${ctx.evaluation.score}/100`, `OilGuard score: ${ctx.evaluation.score}/100`));
    }
    // 7. avoid list respected
    if ((ctx.avoid || []).length && (p.ingredientList || []).length >= 3) {
        const clean = (ctx.avoid || []).filter(x => { const c = resolveConcept(x); return c && matchConceptInList(c, p.ingredientList).length === 0; });
        if (clean.length) reasons.push(T(`خالٍ مما تتجنبه: ${clean.join('، ')}`, `Sans ce que vous évitez : ${clean.join(', ')}`, `Free of what you avoid: ${clean.join(', ')}`));
    }
    // 8. rank
    if (ctx.rank && ctx.rank.total > 1) reasons.push(T(`جاء رقم ${ctx.rank.index + 1} من ${ctx.rank.total} نتائج مطابقة`, `Classé n°${ctx.rank.index + 1} sur ${ctx.rank.total} résultats`, `Ranked #${ctx.rank.index + 1} of ${ctx.rank.total} matches`));
    // 9. shared actives, if nothing else explains it
    if (reasons.length === 0 && (p.ingredientList || []).length) {
        const act = [...detectActives(p.ingredientList).keys()].slice(0, 3).map(k => getConcept(k)?.label);
        if (act.length) reasons.push(T(`مكوناته الفعالة: ${act.map(x => x!.ar).join('، ')}`, `Actifs : ${act.map(x => x!.fr).join(', ')}`, `Key actives: ${act.map(x => x!.en).join(', ')}`));
    }

    // ── caveats (honesty) ────────────────────────────────────────────────────
    const conf = dataConfidence(p);
    if (conf.flags.hasTargetTypes || conf.flags.hasClaims) caveats.push(T('أنواع البشرة والادعاءات هي ما تذكره الشركة، وليست إثباتاً سريرياً.', 'Types de peau et allégations viennent de la marque, pas d\'une preuve clinique.', 'Skin types and claims come from the brand, not clinical proof.'));
    if (!conf.flags.hasPrice) caveats.push(T('السعر غير متوفر عندنا لهذا المنتج.', 'Le prix de ce produit n\'est pas disponible chez nous.', 'We do not have a price on file for this product.'));
    if (!conf.flags.hasIngredients) caveats.push(T('قائمة المكونات غير متوفرة، لذا لا أستطيع تحليل التركيبة.', 'La liste d\'ingrédients est indisponible : impossible d\'analyser la formule.', 'The ingredient list is missing, so I cannot analyze the formula.'));
    if (conf.flags.communitySubmitted) caveats.push(T('أُضيف هذا المنتج من مساهمة مستخدم بعد مراجعة، وقد تكون بياناته أقل اكتمالاً.', 'Ce produit vient d\'une contribution d\'utilisateur validée ; données peut-être moins complètes.', 'This product came from a moderated user contribution; its data may be less complete.'));
    if (ctx.ownedByUser) caveats.push(T('هذا المنتج موجود أصلاً في خزانتك.', 'Ce produit est déjà dans votre armoire.', 'You already own this product.'));

    return { product: { id: p.id, name }, reasons, caveats, confidence: conf };
}
