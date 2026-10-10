/**
 * FAST LANE — answer high-confidence, fully-resolvable requests WITHOUT any
 * model round-trips.
 *
 * The normal path is: LLM call #1 (pick a tool) → tool → LLM call #2 (write 2–3
 * sentences about a card the user already sees). For requests where the router
 * is decisive AND every entity resolves deterministically (a product the user
 * named or pointed at, the last search, the current routine…), we:
 *   1. run the tool directly,
 *   2. stream its card immediately,
 *   3. write the short reply from a template (ar / fr / en).
 *
 * Anything uncertain returns null and the untouched LLM path takes over:
 * compound questions, ambiguous product names, tool errors, relaxed filters…
 * (The hybrid policy: templates for simple single-tool answers, the LLM for
 * everything with nuance.)
 *
 * Disable with FAST_LANE=false.
 */
import { resolveProductReference, resolveBrandCategoryReference, SessionState, AgentStateTracker } from './sessionMemory';
import { getProduct, norm } from './tools/getProduct';
import { buildSearchRefinement } from './followups';
import { emitCardForTool, resetTurnState } from './cards';
import {
    detectLang, Lang, foldMessage, parseRoutineEdit, isContainsQuestion, isCompatQuestion,
    ALTERNATIVE_RE, CHEAPER_RE,
} from './intents';
import { resolveAllConcepts, resolveConcept } from './ingredientKnowledge';
import { lastEngagedBrand, lastActionWasEvaluation } from './corrections';
import { welcomeBackNote } from './longterm';
import { getProducts } from '../wathiq/backendClient';
import { getSearchEntry } from './tools/searchIndex';
import { normalizeArabicText } from './taxonomy';

export const FAST_LANE_ENABLED = process.env.FAST_LANE !== 'false';

export interface FastIntent {
    likelyTools: string[];
    confidence: 'high' | 'medium' | 'low';
    compound?: boolean;
    entities: { brand?: string; category?: string; budget?: number; country?: string };
    /** Set by the router for "no, I meant X" messages. */
    correction?: { isCorrection: true; category?: string } | null;
}

/** PROACTIVE=false disables the appended next-step offers. */
const PROACTIVE = process.env.PROACTIVE !== 'false';

export interface NextStep {
    text: { ar: string; fr: string; en: string };
    offer: { tool: 'find_alternatives' | 'compare_products' | 'check_compatibility'; args: any };
}

const AFFIRM_RE = /^(?:نعم|ايوه|أيوه|اه|آه|اي|ايه|أجل|طيب|يلا|موافق|باهي|اكيد|أكيد|ياريت|من\s*فضلك|ok(?:ay)?|yes|yep|yeah|sure|please|go\s*ahead|do\s*it|oui|ouais|d'accord|bien\s*s[uû]r|volontiers)(?:\s*(?:من\s*فضلك|please|s'il\s*(?:te|vous)\s*pla[iî]t))?$/i;

export function isAffirmative(raw: string): boolean {
    const m = foldMessage(raw).replace(/[.!،؟?]+/g, '').trim();
    return m.length > 0 && m.split(' ').length <= 4 && AFFIRM_RE.test(m);
}

/**
 * Proactive guidance: ONE concrete, tool-backed next step per fast-lane answer
 * (never a generic "anything else?"). The offer is remembered for exactly one
 * turn, so a bare "yes / نعم" executes it with no model round-trip.
 */
export function nextStepFor(tool: string, ctx: { out?: any; state: SessionState; productId?: string; products?: any[] | null }): NextStep | null {
    const { out, state } = ctx;
    switch (tool) {
        case 'evaluate_product': {
            const id = ctx.productId || out?.productId;
            if (!id) return null;
            return {
                text: { ar: 'تريد أن أبحث لك عن بدائل تشاركه المكونات الفعالة؟', fr: 'Voulez-vous des alternatives qui partagent ses actifs ?', en: 'Want alternatives that share its key actives?' },
                offer: { tool: 'find_alternatives', args: { productId: id } },
            };
        }
        case 'compare_products': {
            const winner = out?.winners?.overall?.id;
            if (!winner) return null;
            const routineIds: string[] = (state.lastRoutine?.steps || []).map((s: any) => s.product?.id).filter(Boolean);
            if (routineIds.length > 0) {
                return {
                    text: { ar: 'إن أردت، أفحص توافق الفائز مع منتجات روتينك الحالي.', fr: 'Si vous voulez, je vérifie la compatibilité du gagnant avec votre routine.', en: 'If you like, I can check how the winner fits with your current routine.' },
                    offer: { tool: 'check_compatibility', args: { productIds: Array.from(new Set([winner, ...routineIds])) } },
                };
            }
            return {
                text: { ar: 'أبحث لك عن بديل أرخص للفائز؟', fr: 'Je cherche une alternative moins chère au gagnant ?', en: 'Shall I look for a cheaper alternative to the winner?' },
                offer: { tool: 'find_alternatives', args: { productId: winner, cheaper_only: true } },
            };
        }
        case 'modify_routine': {
            const ids: string[] = (out?.stepsSummary ? (state.lastRoutine?.steps || []) : (state.lastRoutine?.steps || [])).map((s: any) => s.product?.id).filter(Boolean);
            if (ids.length < 2) return null;
            return {
                text: { ar: 'أفحص لك توافق منتجات الروتين مع بعضها؟', fr: 'Je vérifie la compatibilité des produits de la routine ?', en: 'Shall I check that the routine products work well together?' },
                offer: { tool: 'check_compatibility', args: { productIds: ids } },
            };
        }
        case 'find_alternatives': {
            const refId = out?.reference?.id;
            const topId = (ctx.products as any[] | null | undefined)?.[0]?.id ?? (ctx.state.lastProductResults as any[] | null)?.[0]?.id;
            if (!refId || !topId) return null;
            return {
                text: { ar: 'أقارن لك بين الأصلي وأقرب بديل؟', fr: 'Je compare l\'original et l\'alternative la plus proche ?', en: 'Shall I compare the original with the closest alternative?' },
                offer: { tool: 'compare_products', args: { products: [{ id: refId }, { id: topId }] } },
            };
        }
        case 'product_contains': {
            if (!out?.anyAvoidHit || !out?.productId) return null;
            return {
                text: { ar: 'أبحث لك عن بدائل خالية منه؟', fr: 'Je cherche des alternatives sans cet ingrédient ?', en: 'Shall I look for alternatives without it?' },
                offer: { tool: 'find_alternatives', args: { productId: out.productId } },
            };
        }
        default:
            return null;
    }
}

export interface FastLaneInput {
    message: string;
    state: SessionState;
    turnState: AgentStateTracker;
    tools: Record<string, any>;
    intent: FastIntent;
    emitCard?: (type: string, data: any) => void;
    emitText?: (delta: string) => void;
    emitStatus?: (status: string) => void;
}

export interface FastLaneResult {
    text: string;
    tool: string;
    lang: Lang;
}

const tr = (lang: Lang, t: { ar: string; fr: string; en: string }) => t[lang] || t.ar;
const dn = (brand?: string, name?: string) => {
    const b = (brand || '').trim(), n = (name || '').trim();
    if (!b) return n;
    return n.toLowerCase().startsWith(b.toLowerCase()) ? n : `${b} ${n}`.trim();
};

async function run(tools: Record<string, any>, name: string, args: any): Promise<any | null> {
    const t = tools[name];
    if (!t?.execute) return null;
    try {
        const out = await t.execute(args, { toolCallId: `fast_${name}`, messages: [] });
        if (!out || out.error || out.status === 'ambiguous') return null;
        return out;
    } catch (e: any) {
        console.warn(`[FAST] ${name} threw: ${e?.message}`);
        return null;
    }
}

// ── product target resolution (deterministic only) ───────────────────────────
// Words that never name a product: question/verb glue, "this one", "cheaper",
// "alternative", evaluation verbs… in Arabic/Darija, French and English.
const STOP_WORDS = new Set((
    'هل فيه فيها يحتوي تحتوي يوجد به بها على عن في من الى إلى هذا هذه هذي هاد هادا لهذا لهذه منه منها عندك عندكم ' +
    'بديل بدائل ارخص أرخص اقل أقل سعر نفس المفعول التأثير مشابه شبيه يشبه المنتج منتج المنتجات تقييم قيم قيمي قيمو حلل حللي فحص ' +
    'ممكن يمكنك من فضلك لو سمحت مع ما هو هي ليه لماذا اريد أريد ابغي نبغي بغيت واش راك كيفاش ' +
    'does do did it its this that one the a an of for to is are there any have has contain contains containing ' +
    'alternative alternatives dupe dupes cheaper cheap similar like same effect product products please can you could ' +
    'evaluate rate score analyze analyse check tell me about what whats how ' +
    'est ce que qu il y a contient contient-il avec sans du de des la le les un une ce cette celui celle moins cher ' +
    'equivalent équivalent pour produit évalue evalue analyse peux tu s\'il te plait plait'
).split(/\s+/).filter(Boolean));

function leftoverTokens(message: string): string[] {
    return foldMessage(message)
        .replace(/['’]/g, ' ')
        .split(/[\s،,.؟?!:;()"…]+/)
        .filter(t => t.length > 1 && !STOP_WORDS.has(t) && !resolveConcept(t));
}

async function resolveProductTarget(message: string, state: SessionState): Promise<{ id: string } | null> {
    const ref = resolveProductReference(message, state);
    if (ref?.product?.id) return { id: ref.product.id };

    const tokens = leftoverTokens(message);
    if (tokens.length === 0) {
        // "قيمه" / "does it contain alcohol?" / "بديل لهذا" — talks about the product in context.
        const last = state.lastProduct || (state.lastAnalysis ? { id: state.lastAnalysis.productId } : null);
        return last?.id ? { id: last.id } : null;
    }

    // The user typed something that may be a product name → resolve it strictly.
    const query = tokens.join(' ');
    const res = await getProduct({ productName: query, query });
    if (!res.found || !res.product) return null;

    const strategy = res.matchStrategy || '';
    const strong = /^(exact_id|partial_id|exact_name|unique_substring)/.test(strategy);
    const brandInQuery = norm(query).includes(norm(res.product.brand));
    if (strong || brandInQuery) return { id: res.product.id };
    return null;
}

// ── templates ────────────────────────────────────────────────────────────────
function changesHuman(lang: Lang, args: any, kind: string): string {
    const parts: string[] = [];
    if (kind === 'refine') {
        if (args.country) parts.push(tr(lang, { ar: `البلد: ${args.country}`, fr: `pays : ${args.country}`, en: `country: ${args.country}` }));
        if (args.max_price) parts.push(tr(lang, { ar: `تحت ${args.max_price} دج`, fr: `moins de ${args.max_price} DA`, en: `under ${args.max_price} DZD` }));
        if (args.min_price) parts.push(tr(lang, { ar: `فوق ${args.min_price} دج`, fr: `plus de ${args.min_price} DA`, en: `over ${args.min_price} DZD` }));
        if (args.sort_by === 'price_asc') parts.push(tr(lang, { ar: 'الأرخص أولاً', fr: 'moins cher d\'abord', en: 'cheapest first' }));
        if (args.sort_by === 'price_desc') parts.push(tr(lang, { ar: 'الأغلى أولاً', fr: 'plus cher d\'abord', en: 'priciest first' }));
        if (args.exclude_ingredients?.length) parts.push(tr(lang, { ar: `بدون ${args.exclude_ingredients.join('، ')}`, fr: `sans ${args.exclude_ingredients.join(', ')}`, en: `without ${args.exclude_ingredients.join(', ')}` }));
    }
    return parts.join(' · ');
}

function fmtEvaluate(lang: Lang, out: any, turn: AgentStateTracker, state: SessionState): string {
    const name = dn(out.brand, out.name);
    const claims: any[] = out.claimsSummary || [];
    const verified = claims.filter(c => /verified|supported|مؤكد|مدعوم/i.test(String(c.status || ''))).length;
    const flagsRaw = (turn.lastAnalysis as any)?.evaluation?.safety?.flags || (turn.lastAnalysis as any)?.evaluation?.safety?.alerts || [];
    const flags: string[] = flagsRaw.map((f: any) => (typeof f === 'string' ? f : f?.message || f?.ingredient || '')).filter(Boolean);
    const hasAvoid = state.profile.allergies.length + state.profile.avoidIngredients.length > 0;

    let s = tr(lang, {
        ar: `${name}: ${out.oilGuardScore}/100${out.finalVerdict ? ` — ${out.finalVerdict}` : ''}.`,
        fr: `${name} : ${out.oilGuardScore}/100${out.finalVerdict ? ` — ${out.finalVerdict}` : ''}.`,
        en: `${name}: ${out.oilGuardScore}/100${out.finalVerdict ? ` — ${out.finalVerdict}` : ''}.`,
    });
    if (typeof out.safetyScore === 'number' && typeof out.efficacyScore === 'number') {
        s += ' ' + tr(lang, {
            ar: `السلامة ${out.safetyScore}/100 والفعالية ${out.efficacyScore}/100.`,
            fr: `Sécurité ${out.safetyScore}/100, efficacité ${out.efficacyScore}/100.`,
            en: `Safety ${out.safetyScore}/100, efficacy ${out.efficacyScore}/100.`,
        });
    }
    if (claims.length > 0) {
        s += ' ' + tr(lang, {
            ar: `الادعاءات المؤكدة: ${verified}/${claims.length}.`,
            fr: `Allégations confirmées : ${verified}/${claims.length}.`,
            en: `Claims verified: ${verified}/${claims.length}.`,
        });
    }
    if (hasAvoid && flags.length > 0) s += ` ⚠️ ${flags.slice(0, 2).join(' · ')}.`;
    return s + ' ' + tr(lang, { ar: 'التفاصيل في البطاقة 👇', fr: 'Détails dans la carte 👇', en: 'Details in the card 👇' });
}

function fmtBrand(lang: Lang, out: any): string {
    const avg = out.verdict?.avgScore;
    const tier = out.verdict?.tier;
    const n = out.sampleSize;
    if (avg === undefined && !tier) {
        return tr(lang, {
            ar: `حلّلت ${n ?? ''} منتجاً من ${out.brand} — التفاصيل في البطاقة 👇`,
            fr: `${n ?? ''} produits de ${out.brand} analysés — détails dans la carte 👇`,
            en: `Analyzed ${n ?? ''} products from ${out.brand} — details in the card 👇`,
        });
    }
    return tr(lang, {
        ar: `${out.brand}: متوسط ${avg}/100${tier ? ` (${tier})` : ''} على ${n} منتج. التفاصيل في البطاقة 👇`,
        fr: `${out.brand} : moyenne ${avg}/100${tier ? ` (${tier})` : ''} sur ${n} produits. Détails dans la carte 👇`,
        en: `${out.brand}: average ${avg}/100${tier ? ` (${tier})` : ''} across ${n} products. Details in the card 👇`,
    });
}

function fmtCompare(lang: Lang, out: any): string {
    const scores = (out.entries || []).filter((e: any) => typeof e.score === 'number')
        .map((e: any) => `${e.product} ${e.score}`).join(' · ');
    let s = '';
    if (lang === 'ar' && out.summary) s = out.summary;
    else if (out.winners?.overall) {
        s = tr(lang, {
            ar: `الأفضل إجمالاً: ${out.winners.overall.label}.`,
            fr: `Meilleur global : ${out.winners.overall.label}.`,
            en: `Best overall: ${out.winners.overall.label}.`,
        });
    }
    if (scores) s += ` ${scores}.`;
    if (out.winners?.cheapest) {
        s += ' ' + tr(lang, {
            ar: `الأرخص: ${out.winners.cheapest.label}.`,
            fr: `Le moins cher : ${out.winners.cheapest.label}.`,
            en: `Cheapest: ${out.winners.cheapest.label}.`,
        });
    }
    const allergen = (out.entries || []).filter((e: any) => e.allergenHits?.length);
    if (allergen.length) s += ' ' + allergen.map((e: any) => `⚠️ ${e.product}: ${e.allergenHits.join(', ')}`).join(' · ');
    return (s.trim() || tr(lang, { ar: 'المقارنة جاهزة', fr: 'Comparaison prête', en: 'Comparison ready' })) + ' 👇';
}

function fmtInci(lang: Lang, out: any): string {
    let s = tr(lang, {
        ar: `${out.label}: ${out.score}/100${out.verdict ? ` — ${out.verdict}` : ''}.`,
        fr: `${out.label} : ${out.score}/100${out.verdict ? ` — ${out.verdict}` : ''}.`,
        en: `${out.label}: ${out.score}/100${out.verdict ? ` — ${out.verdict}` : ''}.`,
    });
    if (out.allergenHits?.length) {
        s += ' ' + tr(lang, {
            ar: `⚠️ تحتوي على: ${out.allergenHits.join('، ')} (مما تتجنبه).`,
            fr: `⚠️ Contient : ${out.allergenHits.join(', ')} (que vous évitez).`,
            en: `⚠️ Contains: ${out.allergenHits.join(', ')} (on your avoid list).`,
        });
    } else if (out.personalizedNote && lang === 'ar') {
        s += ' ' + out.personalizedNote;
    }
    if (out.safetyFlags?.length) s += ' ' + out.safetyFlags.slice(0, 2).join(' · ') + '.';
    return s + ' ' + tr(lang, { ar: 'التفاصيل في البطاقة 👇', fr: 'Détails dans la carte 👇', en: 'Details in the card 👇' });
}

function fmtSearch(lang: Lang, out: any, kind: string, args: any): string {
    const more = out.hasMore;
    const tail = more
        ? tr(lang, { ar: ' اكتب "المزيد" لرؤية غيرها.', fr: ' Écrivez « plus » pour en voir d\'autres.', en: ' Say "more" to see others.' })
        : tr(lang, { ar: ' هذه آخر النتائج المطابقة.', fr: ' Ce sont les derniers résultats.', en: ' That is every match.' });
    if (kind === 'more') {
        return tr(lang, {
            ar: `إليك ${out.returnedCount} منتجاً إضافياً.`,
            fr: `Voici ${out.returnedCount} produits de plus.`,
            en: `Here are ${out.returnedCount} more products.`,
        }) + tail;
    }
    const ch = changesHuman(lang, args, 'refine');
    return tr(lang, {
        ar: `حدّثت البحث (${ch}) — ${out.foundCount} نتيجة، هذه أفضل ${out.returnedCount}.`,
        fr: `Recherche mise à jour (${ch}) — ${out.foundCount} résultats, voici les ${out.returnedCount} meilleurs.`,
        en: `Search updated (${ch}) — ${out.foundCount} results, here are the top ${out.returnedCount}.`,
    }) + tail;
}

function fmtContains(lang: Lang, out: any): string {
    const who = dn(out.brand, out.name);
    const lines: string[] = out.checks.map((c: any) => {
        const label = c.conceptLabel || c.query;
        if (c.present) {
            const m = c.matches[0];
            const extra = c.matches.length > 1 ? ` (+${c.matches.length - 1})` : '';
            return tr(lang, {
                ar: `✅ يحتوي على ${label}: ${m.name} (رقم ${m.position} من ${out.ingredientCount})${extra}${c.onAvoidList ? ' ⚠️ ضمن ما تتجنبه' : ''}`,
                fr: `✅ Contient ${label} : ${m.name} (n°${m.position}/${out.ingredientCount})${extra}${c.onAvoidList ? ' ⚠️ sur votre liste à éviter' : ''}`,
                en: `✅ Contains ${label}: ${m.name} (#${m.position} of ${out.ingredientCount})${extra}${c.onAvoidList ? ' ⚠️ on your avoid list' : ''}`,
            });
        }
        return tr(lang, { ar: `❌ لا يحتوي على ${label}`, fr: `❌ Ne contient pas ${label}`, en: `❌ No ${label}` });
    });
    return `${who}: ${lines.join(' · ')}`;
}

function fmtAlternatives(lang: Lang, out: any, products: any[]): string {
    const top = products[0];
    const ref = dn(out.reference.brand, out.reference.name);
    const best = dn(top.brand, top.name);
    const shared = (top.sharedActives || []).slice(0, 3).join(lang === 'ar' ? '، ' : ', ');
    const diff = top.priceDiffPct;
    let s = tr(lang, {
        ar: products.length === 1 ? `وجدت بديلاً واحداً لـ ${ref}: ${best}` : `وجدت ${products.length} بدائل لـ ${ref}؛ الأقرب: ${best}`,
        fr: `${products.length} alternatives à ${ref} ; la plus proche : ${best}`,
        en: `${products.length} alternatives to ${ref}; closest: ${best}`,
    });
    if (shared) s += tr(lang, { ar: ` — يشاركه ${shared}`, fr: ` — partage ${shared}`, en: ` — shares ${shared}` });
    if (typeof diff === 'number' && diff > 0) s += tr(lang, { ar: ` وأرخص بحوالي ${diff}%`, fr: ` et ~${diff}% moins cher`, en: ` and ~${diff}% cheaper` });
    s += '.';
    if (out.weakMatch) s += ' ' + tr(lang, { ar: 'ملاحظة: التشابه هنا بالادعاءات لا بالمكونات الفعالة.', fr: 'Note : similitude par allégations, pas par actifs.', en: 'Note: similarity is by claims, not shared actives.' });
    return s + ' 👇';
}

function fmtCompat(lang: Lang, out: any): string {
    const pickAdvice = (a: any) => a?.[lang] || a?.ar || '';
    let s = '';
    if (out.overall === 'ok') {
        s = tr(lang, {
            ar: 'لا يوجد تعارض يُذكر بينها.',
            fr: 'Aucun conflit notable entre eux.',
            en: 'No notable conflict between them.',
        });
        if (out.compatibleNotes?.[0]) s += ' ' + pickAdvice(out.compatibleNotes[0].advice);
    } else {
        s = out.conflicts.slice(0, 2).map((c: any) =>
            `${c.severity === 'avoid_together' ? '⛔' : '⚠️'} ${c.concepts[0]} + ${c.concepts[1]}: ${pickAdvice(c.advice)}`
        ).join(' ');
    }
    const am = out.placement?.AM?.length ? out.placement.AM.join(lang === 'ar' ? '، ' : ', ') : '';
    const pm = out.placement?.PM?.length ? out.placement.PM.join(lang === 'ar' ? '، ' : ', ') : '';
    if (am || pm) {
        s += ' ' + tr(lang, {
            ar: `الأنسب: ${am ? `صباحاً (${am})` : ''}${am && pm ? ' · ' : ''}${pm ? `مساءً (${pm})` : ''}.`,
            fr: `Idéal : ${am ? `matin (${am})` : ''}${am && pm ? ' · ' : ''}${pm ? `soir (${pm})` : ''}.`,
            en: `Best: ${am ? `morning (${am})` : ''}${am && pm ? ' · ' : ''}${pm ? `night (${pm})` : ''}.`,
        });
    }
    if (out.needsSunscreen) s += ' ' + tr(lang, { ar: 'ولا تنسَ واقي الشمس صباحاً.', fr: 'N\'oubliez pas la crème solaire le matin.', en: 'Don\'t skip sunscreen in the morning.' });
    if (out.pregnancyNote) s += ' ' + pickAdvice(out.pregnancyNote);
    return s.trim();
}

function fmtRoutineEdit(lang: Lang, out: any): string {
    const mod = out.modification || {};
    const total = out.totalCost;
    const n = (p: any) => dn(p?.brand, p?.name);
    switch (mod.action) {
        case 'swap':
            return tr(lang, {
                ar: `بدّلت الخطوة ${mod.after.stepNumber}: ${n(mod.before.product)} ← ${n(mod.after.product)} (${mod.after.product.price} دج). المجموع الجديد ${total} دج.`,
                fr: `Étape ${mod.after.stepNumber} remplacée : ${n(mod.before.product)} → ${n(mod.after.product)} (${mod.after.product.price} DA). Nouveau total : ${total} DA.`,
                en: `Swapped step ${mod.after.stepNumber}: ${n(mod.before.product)} → ${n(mod.after.product)} (${mod.after.product.price} DZD). New total: ${total} DZD.`,
            });
        case 'remove':
            return tr(lang, {
                ar: `حذفت الخطوة ${mod.before.stepNumber} (${n(mod.before.product)}). المجموع الآن ${total} دج.`,
                fr: `Étape ${mod.before.stepNumber} supprimée (${n(mod.before.product)}). Total : ${total} DA.`,
                en: `Removed step ${mod.before.stepNumber} (${n(mod.before.product)}). Total: ${total} DZD.`,
            });
        case 'add':
            return tr(lang, {
                ar: `أضفت ${n(mod.after.product)} كخطوة ${mod.after.stepNumber} (${mod.after.product.price} دج). المجموع ${total} دج.`,
                fr: `Ajouté ${n(mod.after.product)} en étape ${mod.after.stepNumber} (${mod.after.product.price} DA). Total : ${total} DA.`,
                en: `Added ${n(mod.after.product)} as step ${mod.after.stepNumber} (${mod.after.product.price} DZD). Total: ${total} DZD.`,
            });
        default:
            return tr(lang, {
                ar: mod.summary || `عدّلت الروتين (المجموع ${total} دج).`,
                fr: `Routine ajustée (total ${total} DA)${mod.stillOverBudget ? ' — encore au-dessus du budget' : ''}.`,
                en: `Routine adjusted (total ${total} DZD)${mod.stillOverBudget ? ' — still over budget' : ''}.`,
            });
    }
}

// ── the dispatcher ───────────────────────────────────────────────────────────
export async function tryFastLane(input: FastLaneInput): Promise<FastLaneResult | null> {
    if (!FAST_LANE_ENABLED) return null;
    const { message, state, turnState, tools, intent } = input;
    if (!message || message.length > 600) return null;

    const lang = detectLang(message, state.profile.language);
    const folded = foldMessage(message);

    /** Streams the final text; appends ONE next-step offer and the welcome-back note. */
    const finish = (text: string, tool: string, next?: NextStep | null): FastLaneResult => {
        let out = text;
        if (PROACTIVE && next) {
            if (!/[.!؟?👇]\s*$/.test(out)) out += '.';
            out += ' ' + tr(lang, next.text);
            state.pendingOffer = { tool: next.offer.tool, args: next.offer.args, turn: state.turnCount };
        } else {
            state.pendingOffer = null;
        }
        if (state.returningNoteDue && state.returningFacts) {
            const note = welcomeBackNote(lang, state.returningFacts);
            if (note) out = `${note}\n${out}`;
        }
        input.emitText?.(out);
        return { text: out, tool, lang };
    };

    // ── 0a. A bare "yes" accepting the offer made by the previous reply ─────
    const offer = state.pendingOffer;
    if (offer && offer.turn === state.turnCount - 1 && isAffirmative(message)) {
        state.pendingOffer = null;
        input.emitStatus?.('✨ ...');
        const out = await run(tools, offer.tool, offer.args);
        const products = turnState.lastProductResults as any[] | null;
        if (out) {
            if (offer.tool === 'find_alternatives' && products && products.length > 0) {
                emitCardForTool('find_alternatives', turnState, input.emitCard);
                return finish(fmtAlternatives(lang, out, products), 'find_alternatives', nextStepFor('find_alternatives', { out, state, products }));
            }
            if (offer.tool === 'compare_products') {
                emitCardForTool('compare_products', turnState, input.emitCard);
                return finish(fmtCompare(lang, out), 'compare_products', nextStepFor('compare_products', { out, state }));
            }
            if (offer.tool === 'check_compatibility') {
                emitCardForTool('check_compatibility', turnState, input.emitCard);
                return finish(fmtCompat(lang, out), 'check_compatibility');
            }
        }
        resetTurnState(turnState);
        return null;
    }

    // ── 0b. Graceful correction: "لا، قصدي الغسول تاعهم مش السيروم" ──────────
    if (intent.correction?.category) {
        const brand = lastEngagedBrand(state);
        if (brand) {
            const cat = intent.correction.category.toLowerCase();
            const brandNorm = normalizeArabicText(brand);
            const catalog = await getProducts();
            const cands = catalog.filter((p: any) => {
                const e = getSearchEntry(p);
                return e.pBrand === brandNorm && (e.catCanon === cat || e.catCanon.includes(cat) || cat.includes(e.catCanon));
            });
            const sorry = tr(lang, { ar: 'عذراً — ', fr: 'Pardon — ', en: 'Got it — ' });
            if (cands.length === 1 && lastActionWasEvaluation(state)) {
                const out = await run(tools, 'evaluate_product', { productId: cands[0].id });
                if (out && typeof out.oilGuardScore === 'number') {
                    emitCardForTool('evaluate_product', turnState, input.emitCard);
                    return finish(sorry + fmtEvaluate(lang, out, turnState, state), 'evaluate_product', nextStepFor('evaluate_product', { out, state, productId: cands[0].id }));
                }
            } else if (cands.length >= 1) {
                const out = await run(tools, 'search_products', { brand: cands[0].brand, category: cat });
                if (out && out.returnedCount > 0 && !(out.relaxedFilters || []).length) {
                    emitCardForTool('search_products', turnState, input.emitCard);
                    const evalHint = lastActionWasEvaluation(state)
                        ? tr(lang, { ar: ' اختر واحداً وأقيّمه لك فوراً.', fr: ' Choisissez-en un et je l\'évalue tout de suite.', en: ' Pick one and I\'ll evaluate it right away.' })
                        : '';
                    return finish(sorry + tr(lang, {
                        ar: `إليك ${out.returnedCount} من منتجات ${cands[0].brand} في هذه الفئة.`,
                        fr: `Voici ${out.returnedCount} produits ${cands[0].brand} dans cette catégorie.`,
                        en: `Here are ${out.returnedCount} ${cands[0].brand} products in that category.`,
                    }) + evalHint, 'search_products');
                }
            }
            resetTurnState(turnState);
        }
        return null;     // anything else → LLM path (with the CORRECTION hint)
    }

    // ── 0. Deterministic search follow-ups (no router signal needed) ─────────
    const refinement = state.lastSearchArgs
        ? buildSearchRefinement(message, state.lastSearchArgs, state.lastSearchNextOffset)
        : null;
    if (refinement) {
        if (refinement.kind === 'no_more') {
            const text = tr(lang, {
                ar: 'هذه كانت كل النتائج المطابقة لبحثك. يمكنني توسيع البحث إن أردت.',
                fr: 'C\'étaient tous les résultats correspondants. Je peux élargir la recherche si vous voulez.',
                en: 'That was every match for your search. I can broaden it if you like.',
            });
            return finish(text, 'search_products');
        }
        input.emitStatus?.('🔍 ...');
        const out = await run(tools, 'search_products', refinement.args);
        if (out && out.returnedCount > 0 && !(out.relaxedFilters || []).length) {
            emitCardForTool('search_products', turnState, input.emitCard);
            return finish(fmtSearch(lang, out, refinement.kind, refinement.args), 'search_products');
        }
        resetTurnState(turnState);
        return null;
    }

    // Beyond this point the router must be decisive and non-compound.
    if (intent.compound || intent.confidence !== 'high' || intent.likelyTools.length === 0) return null;
    const top = intent.likelyTools[0];

    try {
        switch (top) {
            // ── evaluate one product ─────────────────────────────────────────
            case 'evaluate_product': {
                const target = await resolveProductTarget(message, state);
                if (!target) return null;
                const out = await run(tools, 'evaluate_product', { productId: target.id });
                if (!out || typeof out.oilGuardScore !== 'number') break;
                emitCardForTool('evaluate_product', turnState, input.emitCard);
                return finish(fmtEvaluate(lang, out, turnState, state), 'evaluate_product', nextStepFor('evaluate_product', { out, state, productId: target.id }));
            }

            // ── brand verdict (single-brand, non-compound) ───────────────────
            case 'evaluate_brand': {
                const possessive = resolveBrandCategoryReference(message, state);
                const brandName = possessive?.brand || intent.entities.brand;
                if (!brandName) return null;
                const out = await run(tools, 'evaluate_brand', {
                    brandName,
                    ...(possessive?.category ? { focusCategory: possessive.category } : {}),
                });
                if (!out) break;
                emitCardForTool('evaluate_brand', turnState, input.emitCard);
                let text = fmtBrand(lang, out);
                const cf = out.categoryFocus;
                if (cf && cf.best) {
                    text += ' ' + tr(lang, {
                        ar: `الأفضل في فئة ${cf.category}: ${cf.best.name} (${cf.best.score}/100).`,
                        fr: `Meilleur en ${cf.category} : ${cf.best.name} (${cf.best.score}/100).`,
                        en: `Best ${cf.category}: ${cf.best.name} (${cf.best.score}/100).`,
                    });
                }
                return finish(text, 'evaluate_brand');
            }

            // ── compare the last discussed products ──────────────────────────
            case 'compare_products': {
                const pronounOnly = /(بينهما|بين\s*(?:هذين|هذان|هؤلاء|الاثنين|الإثنين)|الاثنين|them\b|these\s*two|the\s*two|both|les\s*deux|ces\s*deux|entre\s*eux)/i.test(folded);
                if (!pronounOnly) return null;
                if (state.productHistory.length < 2 && !((state.lastProductResults?.length || 0) >= 2)) return null;
                const out = await run(tools, 'compare_products', { products: [] });
                if (!out) break;
                emitCardForTool('compare_products', turnState, input.emitCard);
                return finish(fmtCompare(lang, out), 'compare_products', nextStepFor('compare_products', { out, state }));
            }

            // ── raw INCI paste ───────────────────────────────────────────────
            case 'check_ingredient_list': {
                const idx = message.search(/[A-Za-z]{3,}/);
                if (idx < 0) return null;
                const text = message.slice(idx).replace(/^[A-Za-z ]{0,20}:\s*(?=[A-Za-z])/, (m) => (/ingredients?|inci|composition/i.test(m) ? '' : m));
                const out = await run(tools, 'check_ingredient_list', { ingredients_text: text });
                if (!out || typeof out.score !== 'number') break;
                emitCardForTool('check_ingredient_list', turnState, input.emitCard);
                return finish(fmtInci(lang, out), 'check_ingredient_list');
            }

            // ── "does it contain X?" ─────────────────────────────────────────
            case 'product_contains': {
                if (!isContainsQuestion(message)) return null;
                const target = await resolveProductTarget(message, state);
                if (!target) return null;
                const concepts = resolveAllConcepts(folded).map(c => c.label.en);
                // Use the user's own words (the tool resolves aliases itself).
                const out = await run(tools, 'product_contains', { productId: target.id, ingredient: message });
                if (!out || !out.checks) break;
                void concepts;
                emitCardForTool('product_contains', turnState, input.emitCard);
                return finish(fmtContains(lang, out), 'product_contains', nextStepFor('product_contains', { out, state }));
            }

            // ── alternatives / "cheaper one like this" ───────────────────────
            case 'find_alternatives': {
                const target = await resolveProductTarget(message, state);
                if (!target) return null;
                const out = await run(tools, 'find_alternatives', {
                    productId: target.id,
                    cheaper_only: CHEAPER_RE.test(folded) || undefined,
                });
                const products = turnState.lastProductResults as any[] | null;
                if (!out || !products || products.length === 0) break;
                emitCardForTool('find_alternatives', turnState, input.emitCard);
                return finish(fmtAlternatives(lang, out, products), 'find_alternatives', nextStepFor('find_alternatives', { out, state, products }));
            }

            // ── compatibility ────────────────────────────────────────────────
            case 'check_compatibility': {
                const q = isCompatQuestion(message, !!state.lastRoutine);
                if (!q.yes) return null;
                const args = q.routineMode
                    ? { productIds: (state.lastRoutine?.steps || []).map((s: any) => s.product?.id).filter(Boolean) }
                    : { actives: [message] };
                const out = await run(tools, 'check_compatibility', args);
                if (!out) break;
                emitCardForTool('check_compatibility', turnState, input.emitCard);
                return finish(fmtCompat(lang, out), 'check_compatibility');
            }

            // ── routine edits ────────────────────────────────────────────────
            case 'modify_routine': {
                if (!state.lastRoutine) return null;
                const edit = parseRoutineEdit(message);
                if (!edit) return null;
                const out = await run(tools, 'modify_routine', edit);
                if (!out || !out.modification) break;
                emitCardForTool('modify_routine', turnState, input.emitCard);
                return finish(fmtRoutineEdit(lang, out), 'modify_routine', nextStepFor('modify_routine', { out, state }));
            }

            default:
                return null;
        }
    } catch (e: any) {
        console.warn('[FAST] unexpected failure, falling back to LLM path:', e?.message);
    }

    // A tool ran but we could not answer with a template → undo this turn's
    // tracker so the LLM path starts clean (it will re-run the tool itself).
    resetTurnState(turnState);
    return null;
}

// Re-exported so the router and tests share one definition.
export { ALTERNATIVE_RE, CHEAPER_RE };
