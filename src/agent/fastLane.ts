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
    foldMessage, parseRoutineEdit, isContainsQuestion, isCompatQuestion,
    ALTERNATIVE_RE, CHEAPER_RE,
} from './intents';
import { tr, pickL, detectVoice, detectMood, calm, TLang as Lang } from './voice';
import { darijaize } from './darija';
import { resolveAllConcepts, resolveConcept, POTENT_KEYS } from './ingredientKnowledge';
import { dayNamesFor } from './tools/generateUsageSchedule';
import { parseDupeRequest, isScheduleQuestion } from './intents';
import { matchReference } from './references';
import { submitContribution } from './contributions';
import { parseCabinetCommand, parseOutputCommand, isWhyQuestion } from './intents';
import { findShelfAnalysis } from './userContext';
import { parseVersionCommand } from './routineHistory';
import { listItems, ownsProduct, overlapWithCabinet } from './cabinet';
import { detectActives, getConcept } from './ingredientKnowledge';
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
    offer: { tool: 'find_alternatives' | 'compare_products' | 'check_compatibility' | 'generate_usage_schedule' | 'manage_cabinet' | 'submit_contribution'; args: any };
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
export function nextStepFor(tool: string, ctx: { out?: any; state: SessionState; productId?: string; products?: any[] | null; potentActive?: { key: string; label: string; arg?: string } }): NextStep | null {
    const { out, state } = ctx;
    switch (tool) {
        case 'evaluate_product': {
            const id = ctx.productId || out?.productId;
            if (!id) return null;
            // A potent active in the formula matters more than "alternatives":
            // offer the safe-start calendar instead.
            if (ctx.potentActive) {
                const lbl = ctx.potentActive.label;
                return {
                    text: { ar: `يحتوي على ${lbl} فعّال؛ أعدّ لك جدول تدرّج آمن لبدء استعماله دون تهيّج؟`, fr: `Il contient un actif puissant (${lbl}) ; je prépare un calendrier de démarrage progressif ?`, en: `It contains a potent active (${lbl}); shall I prepare a safe ramp-up calendar?` },
                    offer: { tool: 'generate_usage_schedule', args: { active: ctx.potentActive.arg || lbl } },
                };
            }
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

const dn = (brand?: string, name?: string) => {
    const b = (brand || '').trim(), n = (name || '').trim();
    if (!b) return n;
    return n.toLowerCase().startsWith(b.toLowerCase()) ? n : `${b} ${n}`.trim();
};

async function run(tools: Record<string, any>, name: string, args: any): Promise<any | null> {
    const t = tools[name];
    if (!t?.execute) return null;
    const startedAt = Date.now();
    const debug = process.env.AGENT_DEBUG !== 'false';
    if (debug) console.log(`[FAST][TOOL_START] ${name}`);
    try {
        const out = await t.execute(args, { toolCallId: `fast_${name}`, messages: [] });
        if (debug) console.log(`[FAST][TOOL_DONE] ${name} durationMs=${Date.now() - startedAt} result=${out?.error ? 'error' : out?.status === 'ambiguous' ? 'ambiguous' : 'ok'}`);
        if (!out || out.error || out.status === 'ambiguous') return null;
        return out;
    } catch (e: any) {
        console.warn(`[FAST][TOOL_ERROR] ${name} durationMs=${Date.now() - startedAt} message=${e?.message}`);
        return null;
    }
}

// ── product target resolution (deterministic only) ───────────────────────────
// Words that never name a product: question/verb glue, "this one", "cheaper",
// "alternative", evaluation verbs… in Arabic/Darija, French and English.
const STOP_WORDS = new Set((
    'هل فيه فيها يحتوي تحتوي يوجد به بها على عن في من الى إلى هذا هذه هذي هاد هادا لهذا لهذه منه منها عندك عندكم ' +
    'بديل بدائل ارخص أرخص اقل أقل سعر نفس المفعول التأثير مشابه شبيه يشبه المنتج منتج المنتجات تقييم قيم قيمي قيمو حلل حللي فحص ' +
    'ممكن يمكنك من فضلك لو سمحت مع ما هو هي ليه لماذا اريد أريد ابغي نبغي بغيت واش راك كيفاش وجهي وجهك بشرتي بشرتك جلدي وجه بشرة أنا انا نحن i am im je suis tu you my face skin ma peau mon visage ' +
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
        .filter(t => t.length > 1 && !STOP_WORDS.has(t) && !resolveConcept(t) && detectMood(t) !== 'distressed');
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
    if (out.price === '' || out.price === undefined || out.price === null) {
        s += ' ' + tr(lang, { ar: 'ملاحظة: السعر غير متوفر عندنا لهذا المنتج.', fr: 'Note : prix indisponible chez nous.', en: 'Note: no price on file for this product.' });
    }
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
    const pickAdvice = (a: any) => pickL(a, lang) || '';
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
    if (out.bufferingTip && out.overall !== 'ok') s += ' ' + (pickL(out.bufferingTip, lang));
    if (out.needsSunscreen) s += ' ' + tr(lang, { ar: 'ولا تنسَ واقي الشمس صباحاً.', fr: 'N\'oubliez pas la crème solaire le matin.', en: 'Don\'t skip sunscreen in the morning.' });
    if (out.pregnancyNote) s += ' ' + pickAdvice(out.pregnancyNote);
    return s.trim();
}

function fmtDupe(lang: Lang, out: any, products: any[]): string {
    const ref = out.reference || {};
    const j = lang === 'ar' ? '، ' : ', ';
    const head = tr(lang, {
        ar: `وجدت ${products.length === 1 ? 'بديلاً واحداً' : `${products.length} بدائل`} تشارك المكونات الفعالة لـ ${ref.label} (${(ref.actives || []).join(j)}):`,
        fr: `${products.length} alternative(s) partageant les actifs clés de ${ref.label} (${(ref.actives || []).join(j)}) :`,
        en: `${products.length} option(s) sharing the key actives of ${ref.label} (${(ref.actives || []).join(j)}):`,
    });
    const lines = products.slice(0, 3).map((p: any) => {
        const price = p.price !== undefined ? ` — ${p.price} ${p.currency || ''}`.trimEnd() : '';
        const shared = (p.sharedActives || []).join(j);
        const saving = typeof p.priceSavingPct === 'number' && p.priceSavingPct > 0
            ? tr(lang, { ar: ` — توفير ${p.priceSavingPct}%`, fr: ` — ${p.priceSavingPct}% moins cher`, en: ` — ${p.priceSavingPct}% cheaper` }) : '';
        return `• ${dn(p.brand, p.name)}${price} (${tr(lang, { ar: 'يشارك', fr: 'partage', en: 'shares' })}: ${shared})${saving}`;
    });
    const unpriced = (out.unpricedMatches || []).slice(0, 2).map((p: any) => dn(p.brand, p.name));
    const unpricedNote = unpriced.length
        ? ' ' + tr(lang, {
            ar: `وهناك أيضاً (${unpriced.join('، ')}) يشاركون نفس المكونات لكن سعرهم غير متوفر عندنا.`,
            fr: `Aussi (${unpriced.join(', ')}) avec les mêmes actifs, mais sans prix chez nous.`,
            en: `Also (${unpriced.join(', ')}) share the actives, but we have no price for them.`,
        })
        : '';
    const note = ref.approximate
        ? ' ' + tr(lang, { ar: '(المقارنة بالمكونات المشتركة لا بالتركيزات.)', fr: '(Comparaison sur les actifs communs, pas les concentrations.)', en: '(Compared on shared actives, not concentrations.)' })
        : '';
    return `${head}\n${lines.join('\n')}${note}${unpricedNote} 👇`;
}

function fmtSchedule(lang: Lang, out: any): string {
    const when = out.applyTime === 'PM'
        ? tr(lang, { ar: 'ليلاً', fr: 'le soir', en: 'at night' })
        : tr(lang, { ar: 'صباحاً', fr: 'le matin', en: 'in the morning' });
    const head = tr(lang, {
        ar: `بروتوكول التدرّج لـ ${out.active} (${when}${out.concentration ? `، ${out.concentration}%` : ''}):`,
        fr: `Calendrier de démarrage — ${out.active} (${when}${out.concentration ? `, ${out.concentration}%` : ''}) :`,
        en: `Ramp-up plan — ${out.active} (${when}${out.concentration ? `, ${out.concentration}%` : ''}):`,
    });
    const weekWord = tr(lang, { ar: 'الأسبوع', fr: 'Semaine', en: 'Week' });
    const lines = (out.weeks || []).map((w: any) => {
        const days = dayNamesFor(lang, w.exampleDays);
        return `• ${weekWord} ${w.weeks}: ${pickL(w.frequency, lang)}${days ? ` (${days})` : ''}${w.note ? ` — ${pickL(w.note, lang)}` : ''}`;
    });
    const rules = (out.rules || []).slice(0, 3).map((r: any) => `• ${pickL(r, lang)}`);
    const stop = out.stopSigns ? `⚠️ ${pickL(out.stopSigns, lang)}` : '';
    const preg = out.pregnancyNote ? `\n${pickL(out.pregnancyNote, lang)}` : '';
    return `${head}\n${lines.join('\n')}\n${rules.join('\n')}\n${stop}${preg}`;
}

const GAP_LABEL: Record<string, { ar: string; fr: string; en: string }> = {
    cleanser: { ar: 'غسول', fr: 'nettoyant', en: 'a cleanser' },
    lotion_cream: { ar: 'مرطب', fr: 'hydratant', en: 'a moisturizer' },
    sunscreen: { ar: 'واقي شمس', fr: 'écran solaire', en: 'sunscreen' },
};

function gapsText(lang: Lang, gaps: string[]): string {
    if (!gaps || gaps.length === 0) return tr(lang, { ar: 'الأساسيات (غسول، مرطب، واقي شمس) كاملة عندك.', fr: 'Les essentiels (nettoyant, hydratant, écran solaire) sont couverts.', en: 'Your essentials (cleanser, moisturizer, sunscreen) are covered.' });
    const names = gaps.map(g => tr(lang, GAP_LABEL[g] || { ar: g, fr: g, en: g })).join(lang === 'en' || lang === 'fr' ? ', ' : '، ');
    return tr(lang, { ar: `ينقصك: ${names}.`, fr: `Il vous manque : ${names}.`, en: `You are missing: ${names}.` });
}

function fmtCabinet(lang: Lang, cmd: string, out: any): string {
    const j = lang === 'ar' || lang === 'dz' ? '، ' : ', ';
    if (cmd === 'list') {
        const using = (out.items || []).filter((i: any) => i.status === 'using');
        const names = using.slice(0, 5).map((i: any) => dn(i.brand, i.name)).join(j);
        let s = tr(lang, {
            ar: `في خزانتك ${out.count} منتج${using.length ? ` (${using.length} قيد الاستعمال: ${names}${using.length > 5 ? '…' : ''})` : ''}.`,
            fr: `Votre armoire contient ${out.count} produit(s)${using.length ? ` (${using.length} en cours : ${names}${using.length > 5 ? '…' : ''})` : ''}.`,
            en: `Your cabinet has ${out.count} product(s)${using.length ? ` (${using.length} in use: ${names}${using.length > 5 ? '…' : ''})` : ''}.`,
        });
        s += ' ' + gapsText(lang, out.gaps);
        const v = out.valueInUse;
        if (v && v.max > 0) {
            const range = v.min === v.max ? `${v.min}` : `${v.min}–${v.max}`;
            s += ' ' + tr(lang, {
                ar: `قيمة ما تستعمله تقريباً ${range} دج${v.unpriced ? ` (+ ${v.unpriced} منتج بلا سعر عندنا)` : ''}.`,
                fr: `Valeur de ce que vous utilisez : ~${range} DA${v.unpriced ? ` (+ ${v.unpriced} sans prix)` : ''}.`,
                en: `Value of what you use: ~${range} DZD${v.unpriced ? ` (+ ${v.unpriced} with no price on file)` : ''}.`,
            });
        }
        if (out.dislikeInsights?.length) {
            const labels = out.dislikeInsights.map((k: string) => getConcept(k)?.label[lang === 'dz' ? 'ar' : lang] || k).join(j);
            s += ' ' + tr(lang, { ar: `لاحظت أن منتجاتك اللي ما ناسبتك تشترك في: ${labels}.`, fr: `Les produits qui ne vous ont pas convenu ont en commun : ${labels}.`, en: `The products that did not suit you share: ${labels}.` });
        }
        return s;
    }
    if (cmd === 'add' && out.added) {
        const who = dn(out.added.brand, out.added.name);
        let s = out.alreadyHadIt
            ? tr(lang, { ar: `${who} موجود أصلاً في خزانتك، حدّثته.`, fr: `${who} était déjà dans votre armoire, mis à jour.`, en: `${who} was already in your cabinet — updated.` })
            : tr(lang, { ar: `أضفت ${who} إلى خزانتك.`, fr: `${who} ajouté à votre armoire.`, en: `Added ${who} to your cabinet.` });
        const o = out.overlap?.[0];
        if (o) {
            s += ' ' + tr(lang, {
                ar: `ملاحظة: عندك ${o.with} فيه نفس المكونات الفعالة (${o.sharedActives.join('، ')}) — غالباً لا تحتاج الاثنين معاً.`,
                fr: `Note : vous avez déjà ${o.with} avec les mêmes actifs (${o.sharedActives.join(', ')}) — les deux ne sont sans doute pas nécessaires.`,
                en: `Note: you already have ${o.with} with the same actives (${o.sharedActives.join(', ')}) — you probably don't need both.`,
            });
        }
        return s;
    }
    if (cmd === 'update' && out.updated) {
        const who = dn(out.updated.brand, out.updated.name);
        let s: string;
        if (out.updated.verdict === 'didnt_suit') s = tr(lang, { ar: `سجلت أن ${who} ما ناسبك — وسأتجنب المنتجات المشابهة له في اقتراحاتي.`, fr: `Noté : ${who} ne vous a pas convenu — j'éviterai les produits similaires.`, en: `Noted: ${who} didn't suit you — I'll steer clear of similar products.` });
        else if (out.updated.verdict === 'loved') s = tr(lang, { ar: `سجلت أن ${who} أعجبك 👌`, fr: `Noté : vous avez adoré ${who} 👌`, en: `Noted: you loved ${who} 👌` });
        else if (out.updated.status === 'finished') s = tr(lang, { ar: `سجلت ${who} كمنتهي.`, fr: `${who} marqué comme terminé.`, en: `Marked ${who} as finished.` });
        else s = tr(lang, { ar: `حدّثت ${who}.`, fr: `${who} mis à jour.`, en: `Updated ${who}.` });
        if (out.dislikeInsights?.length) {
            const labels = out.dislikeInsights.map((k: string) => getConcept(k)?.label[lang === 'dz' ? 'ar' : lang] || k).join(j);
            s += ' ' + tr(lang, { ar: `لاحظت نمطاً: المنتجات اللي ما ناسبتك فيها ${labels}.`, fr: `Un point commun : les produits qui ne vous ont pas convenu contiennent ${labels}.`, en: `Pattern spotted: the products that didn't suit you contain ${labels}.` });
        }
        return s;
    }
    if (cmd === 'remove' && out.removed) {
        return tr(lang, { ar: `حذفت ${dn(out.removed.brand, out.removed.name)} من خزانتك.`, fr: `${dn(out.removed.brand, out.removed.name)} retiré de votre armoire.`, en: `Removed ${dn(out.removed.brand, out.removed.name)} from your cabinet.` });
    }
    return tr(lang, { ar: 'تم.', fr: 'C\'est fait.', en: 'Done.' });
}

/** What the user's cabinet says about a product that was just evaluated (owned? duplicate actives? disliked?). */
function cabinetNote(lang: Lang, state: SessionState, turn: AgentStateTracker, productId?: string): string {
    if (!state.userId) return '';
    const items = listItems(state.userId);
    if (items.length === 0) return '';
    if (productId) {
        const own = ownsProduct(items, productId);
        if (own?.verdict === 'didnt_suit') return tr(lang, { ar: 'تذكير: سجلت سابقاً أن هذا المنتج ما ناسبك.', fr: 'Rappel : vous aviez noté que ce produit ne vous convenait pas.', en: 'Reminder: you noted before that this product didn\'t suit you.' });
        if (own) return tr(lang, { ar: 'هذا المنتج موجود أصلاً في خزانتك.', fr: 'Ce produit est déjà dans votre armoire.', en: 'This product is already in your cabinet.' });
    }
    const names: string[] = ((turn.lastAnalysis as any)?.evaluation?.detected_ingredients || []).map((i: any) => i?.name || i?.id).filter(Boolean);
    if (names.length === 0) return '';
    const keys = [...detectActives(names).keys()];
    const o = overlapWithCabinet(items, keys, { exceptProductId: productId })[0];
    if (!o) return '';
    const shared = o.sharedActives.map(k => getConcept(k)?.label[lang === 'dz' ? 'ar' : lang] || k).join(lang === 'en' || lang === 'fr' ? ', ' : '، ');
    return tr(lang, {
        ar: `ملاحظة: عندك في خزانتك ${dn(o.item.brand, o.item.name)} فيه نفس المكونات الفعالة (${shared}).`,
        fr: `Note : vous avez déjà ${dn(o.item.brand, o.item.name)} avec les mêmes actifs (${shared}).`,
        en: `Note: you already have ${dn(o.item.brand, o.item.name)} with the same actives (${shared}).`,
    });
}

function fmtTriage(lang: Lang, out: any): string {
    const j = lang === 'ar' || lang === 'dz' ? '، ' : ', ';
    const flags = (out.redFlags || []).map((f: any) => pickL(f, lang)).join(j);
    const steps: string[] = (out.steps || []).map((x: any, i: number) => `${i + 1}) ${pickL(x, lang)}`);
    if (out.urgency === 'urgent') {
        return `⚠️ ${tr(lang, { ar: `هذه علامات تستدعي رعاية طبية عاجلة: ${flags}.`, fr: `Ces signes demandent des soins urgents : ${flags}.`, en: `These signs need urgent medical care: ${flags}.` })}\n${steps.join('\n')}`;
    }
    const typeLine: Record<string, { ar: string; fr: string; en: string }> = {
        irritation: { ar: 'يبدو أنه تهيّج للبشرة (ليس تشخيصاً طبياً).', fr: 'Cela ressemble à une irritation (pas un diagnostic).', en: 'This looks like skin irritation (not a diagnosis).' },
        allergy_suspect: { ar: 'قد تكون حساسية تجاه منتج جديد — خذها بجدية.', fr: 'Possible allergie à un produit récent — à prendre au sérieux.', en: 'This could be an allergic reaction to something new — take it seriously.' },
        purge: { ar: 'قد يكون "تطهيراً" (purge) مع بدء مقشر/ريتينول وليس تهيجاً.', fr: 'Cela peut être une « purge » due à un exfoliant/rétinol récent, pas une irritation.', en: 'This may be a "purge" from a recent exfoliant/retinoid rather than irritation.' },
        breakout_other: { ar: 'حبوب جديدة — قد يكون منتجاً مسدّاً للمسام.', fr: 'Nouveaux boutons — possiblement un produit comédogène.', en: 'New breakouts — possibly a pore-clogging product.' },
        dryness: { ar: 'جفاف وشدّ في البشرة — غالباً حاجز الجلد مرهق.', fr: 'Peau sèche et tiraillée — barrière cutanée probablement fragilisée.', en: 'Dry, tight skin — your skin barrier is probably stressed.' },
        unclear: { ar: 'ما نقدرش نحدد السبب بدقة، لكن هذه خطوات آمنة تبدأ بها.', fr: 'Difficile de préciser la cause, mais voici des étapes sûres pour commencer.', en: 'I can\'t pin down the cause, but here are safe first steps.' },
    };
    let s = tr(lang, typeLine[out.type] || typeLine.unclear);
    const top = (out.culprits || []).slice(0, 2);
    if (top.length) {
        s += ' ' + tr(lang, {
            ar: `الأرجح بحسب ما تستعمله: ${top.map((c: any) => `${c.label}${c.reasons?.[0] ? ` (${pickL(c.reasons[0], lang)})` : ''}`).join(' · ')}.`,
            fr: `Suspects les plus probables : ${top.map((c: any) => `${c.label}${c.reasons?.[0] ? ` (${pickL(c.reasons[0], lang)})` : ''}`).join(' · ')}.`,
            en: `Most likely given what you use: ${top.map((c: any) => `${c.label}${c.reasons?.[0] ? ` (${pickL(c.reasons[0], lang)})` : ''}`).join(' · ')}.`,
        });
    }
    if (out.layeringOverload) s += ' ' + tr(lang, { ar: 'استعمال أكثر من مقشر/ريتينول معاً يضاعف التهيج.', fr: 'Cumuler plusieurs exfoliants/rétinoïdes multiplie l\'irritation.', en: 'Stacking several exfoliants/retinoids multiplies irritation.' });
    s += `\n${steps.join('\n')}`;
    if (out.backOff) s += `\n${pickL(out.backOff, lang)}`;
    if (out.pregnancyNote) s += `\n${pickL(out.pregnancyNote, lang)}`;
    if (out.needsMoreInfo) s += '\n' + tr(lang, { ar: 'شنو المنتجات أو المكونات الجديدة اللي بديتها مؤخراً؟ قولي أسماءها ونحدد المتهم الأرجح.', fr: 'Quels produits ou actifs avez-vous commencés récemment ? Donnez-moi leurs noms et je cible le suspect.', en: 'What products or actives did you start recently? Tell me their names and I\'ll narrow down the likely culprit.' });
    s += `\n${pickL(out.whenToSeeDoctor, lang)}`;
    return s;
}

function fmtExplain(lang: Lang, out: any): string {
    const bullets = (out.reasons || []).slice(0, 4).map((r: any) => `• ${pickL(r, lang)}`);
    const caveats = (out.caveats || []).slice(0, 2).map((r: any) => `• ${pickL(r, lang)}`);
    const lvl: Record<string, { ar: string; fr: string; en: string }> = {
        high: { ar: 'ثقتي في بيانات هذا المنتج عالية.', fr: 'Ma confiance dans les données de ce produit est élevée.', en: 'I\'m fairly confident in this product\'s data.' },
        medium: { ar: 'ثقتي متوسطة: بعض البيانات ناقصة.', fr: 'Confiance moyenne : certaines données manquent.', en: 'Medium confidence: some data is missing.' },
        low: { ar: 'ثقتي ضعيفة: بيانات هذا المنتج ناقصة.', fr: 'Confiance faible : données incomplètes.', en: 'Low confidence: this product\'s data is incomplete.' },
    };
    const head = tr(lang, { ar: `ليش اخترت ${out.product.name}؟`, fr: `Pourquoi ${out.product.name} ?`, en: `Why ${out.product.name}?`, dz: `علاش اخترت ${out.product.name}؟` });
    const body = bullets.length ? bullets.join('\n') : '• ' + tr(lang, { ar: 'لا أملك سبباً محدداً مسجلاً لهذا الاختيار.', fr: 'Je n\'ai pas de raison précise enregistrée.', en: 'I have no specific recorded reason for this pick.' });
    return `${head}\n${body}\n${caveats.join('\n')}\n${tr(lang, lvl[out.confidence.level])}`.replace(/\n\n+/g, '\n');
}

/** "How is my X?" answered from the OilGuard analysis already stored in the user's own shelf. */
function fmtShelfAnalysis(lang: Lang, e: any): string {
    let s = tr(lang, {
        ar: `${e.name} (في رفّك): ${e.score}/100${e.verdict ? ` — ${e.verdict}` : ''}.`,
        fr: `${e.name} (dans votre étagère) : ${e.score}/100${e.verdict ? ` — ${e.verdict}` : ''}.`,
        en: `${e.name} (on your shelf): ${e.score}/100${e.verdict ? ` — ${e.verdict}` : ''}.`,
    });
    if (typeof e.safety === 'number' && typeof e.efficacy === 'number') {
        s += ' ' + tr(lang, { ar: `السلامة ${e.safety}/100 والفعالية ${e.efficacy}/100.`, fr: `Sécurité ${e.safety}/100, efficacité ${e.efficacy}/100.`, en: `Safety ${e.safety}/100, efficacy ${e.efficacy}/100.` });
    }
    if (e.alerts?.length) s += ' ⚠️ ' + e.alerts.slice(0, 2).join(' · ');
    return s + ' ' + tr(lang, { ar: '(محسوب على ملفك الشخصي وقت حفظ المنتج.)', fr: '(Calculé pour votre profil au moment de l\'enregistrement.)', en: '(Computed for your profile when you saved it.)' });
}

function fmtVersions(lang: Lang, cmd: string, out: any): string {
    if (cmd === 'compare' && out.diff) {
        const d = out.diff;
        const parts: string[] = [];
        d.swapped.forEach((x: any) => parts.push(`• ${x.step}: ${x.from} ← ${x.to}`));
        d.added.forEach((x: any) => parts.push(`• ${tr(lang, { ar: 'إضافة', fr: 'ajout', en: 'added' })}: ${x.step} (${x.product})`));
        d.removed.forEach((x: any) => parts.push(`• ${tr(lang, { ar: 'حذف', fr: 'retiré', en: 'removed' })}: ${x.step} (${x.product})`));
        const delta = d.totalDelta === 0
            ? tr(lang, { ar: 'نفس التكلفة', fr: 'même coût', en: 'same cost' })
            : tr(lang, { ar: `${d.totalDelta > 0 ? '+' : ''}${d.totalDelta} دج`, fr: `${d.totalDelta > 0 ? '+' : ''}${d.totalDelta} DA`, en: `${d.totalDelta > 0 ? '+' : ''}${d.totalDelta} DZD` });
        return `${tr(lang, { ar: `الفرق بين النسخة ${d.from} والنسخة ${d.to}:`, fr: `Différences entre la version ${d.from} et ${d.to} :`, en: `Differences between version ${d.from} and ${d.to}:` })}\n${parts.join('\n') || '—'}\n${tr(lang, { ar: 'التكلفة', fr: 'Coût', en: 'Cost' })}: ${d.totalFrom} → ${d.totalTo} (${delta})`;
    }
    if (out.restored) {
        const r = out.restored;
        return tr(lang, {
            ar: `رجّعتك للنسخة ${r.version} من الروتين (${r.label}) — المجموع ${r.totalCost} دج.`,
            fr: `Retour à la version ${r.version} de la routine (${r.label}) — total ${r.totalCost} DA.`,
            en: `Went back to routine version ${r.version} (${r.label}) — total ${r.totalCost} DZD.`,
        });
    }
    const items = (out.versions || []).map((v: any) => `${v.version}) ${v.label} — ${v.totalCost} ${tr(lang, { ar: 'دج', fr: 'DA', en: 'DZD' })}`);
    return `${tr(lang, { ar: 'نسخ الروتين:', fr: 'Versions de la routine :', en: 'Routine versions:' })}\n${items.join('\n')}`;
}

function fmtShopping(lang: Lang, out: any): string {
    const t = out.total || { min: 0, max: 0, unpriced: 0 };
    const range = t.min === t.max ? `${t.min}` : `${t.min}–${t.max}`;
    let s = tr(lang, {
        ar: `عندك ${out.toBuy.length} منتج تشريه بـ ${range} دج${t.unpriced ? ` (+ ${t.unpriced} بلا سعر عندنا)` : ''}.`,
        fr: `${out.toBuy.length} produit(s) à acheter pour ${range} DA${t.unpriced ? ` (+ ${t.unpriced} sans prix)` : ''}.`,
        en: `${out.toBuy.length} product(s) to buy for ${range} DZD${t.unpriced ? ` (+ ${t.unpriced} with no price on file)` : ''}.`,
    });
    if (out.alreadyOwned?.length) s += ' ' + tr(lang, { ar: `(${out.alreadyOwned.length} عندك أصلاً، حذفتهم من المجموع)`, fr: `(${out.alreadyOwned.length} déjà chez vous, retirés du total)`, en: `(${out.alreadyOwned.length} already owned, removed from the total)` });
    if (out.buyFirst?.length) s += ' ' + tr(lang, { ar: `ابدأ بـ: ${out.buyFirst.join('، ')}.`, fr: `Commencez par : ${out.buyFirst.join(', ')}.`, en: `Start with: ${out.buyFirst.join(', ')}.` });
    if (out.overBudget) s += ' ⚠️ ' + tr(lang, { ar: 'المجموع يتجاوز ميزانيتك.', fr: 'Le total dépasse votre budget.', en: 'The total is over your budget.' });
    return s + ' 👇';
}

function fmtGift(lang: Lang, out: any): string {
    const items = (out.items || []).map((i: any) => `• ${i.name}: ${i.product} — ${i.price} ${tr(lang, { ar: 'دج', fr: 'DA', en: 'DZD' })}`);
    return `${tr(lang, { ar: `مجموعة هدية لطيفة (${out.totalCost} دج من ${out.maxBudget}):`, fr: `Coffret cadeau doux (${out.totalCost} DA sur ${out.maxBudget}) :`, en: `Gentle gift set (${out.totalCost} of ${out.maxBudget} DZD):` })}\n${items.join('\n')}\n${tr(lang, { ar: 'بلا عطور ولا مكونات قوية، تناسب معظم البشرات.', fr: 'Sans parfum ni actifs puissants — convient à la plupart des peaux.', en: 'Fragrance-free with no strong actives — suits most skin types.' })}`;
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

/** First potent active (retinoid / AHA / BHA / benzoyl / azelaic) found in the evaluated formula. */
const PROACTIVE_POTENT = ['retinoid', 'aha', 'bha', 'benzoyl', 'azelaic'];
function potentActiveOf(turn: AgentStateTracker, lang: Lang): { key: string; label: string; arg: string } | undefined {
    const names: string[] = ((turn.lastAnalysis as any)?.evaluation?.detected_ingredients || [])
        .map((i: any) => i?.name || i?.id).filter(Boolean);
    for (const n of names) {
        const c = resolveConcept(String(n));
        if (c && PROACTIVE_POTENT.includes(c.key) && POTENT_KEYS.includes(c.key)) {
            return { key: c.key, label: pickL(c.label, lang), arg: c.aliases[0] };
        }
    }
    return undefined;
}

// ── deterministic search extraction ──────────────────────────────────────────
// Clear catalog searches should not spend two model round-trips choosing and
// narrating a tool that the router has already identified.
function directSearchArgs(message: string, intent: FastIntent): Record<string, any> | null {
    const raw = String(message || '');
    const args: Record<string, any> = { limit: 8 };
    if (intent.entities.category) args.category = intent.entities.category;
    if (intent.entities.country) args.country = intent.entities.country;
    if (typeof intent.entities.budget === 'number') args.max_price = intent.entities.budget;

    const budget = raw.match(/(?:under|below|less\s+than|maximum|max\.?|تحت|أقل\s*من|اقل\s*من|بميزانية|ميزانيتي)\s*(\d{3,6})\s*(?:دج|دينار|dzd|dz|da)?/i);
    if (args.max_price === undefined && budget) args.max_price = Number(budget[1]);

    const skin: string[] = [];
    const hair: string[] = [];
    const conditions: Array<{ re: RegExp; value: string; hair?: boolean }> = [
        { re: /\b(?:oily|greasy|grasse|huileuse)\b|بشرة\s*(?:دهنية|دهنيه)|دهني(?:ة)?\s*(?:البشرة)?/i, value: 'oily' },
        { re: /\b(?:dry|s[eè]che)\b|بشرة\s*جافة|جلد\s*جاف|جفاف/i, value: 'dry' },
        { re: /\b(?:sensitive|sensible)\b|بشرة\s*حساسة|بشرة\s*حساسه/i, value: 'sensitive' },
        { re: /\b(?:combination skin|combination|mixte)\b|بشرة\s*مختلطة/i, value: 'combination' },
        { re: /\b(?:acne|acn[eé]ique|pimples?)\b|حب\s*الشباب|حبوب\s*الوجه/i, value: 'acne' },
        { re: /\b(?:dehydrated|dehydration)\b|ناقصة\s*الترطيب|بشرة\s*عطشانة/i, value: 'dehydrated' },
        { re: /\b(?:curly|boucl[eé]s?)\b|شعر\s*مجعد|شعر\s*كيرلي/i, value: 'curly', hair: true },
        { re: /\b(?:damaged hair|damaged|ab[iî]m[eé]s?)\b|شعر\s*(?:تالف|متضرر|متقصف)/i, value: 'damaged', hair: true },
        { re: /\b(?:dandruff|pellicules?)\b|قشرة|القشرة/i, value: 'dandruff', hair: true },
        { re: /\b(?:frizzy|anti-frizz)\b|هيشان|تجعد\s*الشعر/i, value: 'frizzy', hair: true },
    ];
    for (const c of conditions) if (c.re.test(raw)) (c.hair ? hair : skin).push(c.value);
    const hairContext = /hair|cheveu|shampoo|shampoing|شعر|شامبو|فروة|فروه/i.test(raw);
    if (hair.length || (hairContext && skin.length)) args.hair_type = Array.from(new Set([...hair, ...(hairContext ? skin : [])])).join(' / ');
    else if (skin.length) args.skin_type = Array.from(new Set(skin)).join(' / ');

    const claimRules: Array<[RegExp, string]> = [
        [/dark\s*spots?|hyperpigmentation|بقع\s*داكنة|التصبغات/i, 'تفتيح البقع الداكنة'],
        [/brighten(?:ing)?|lighten(?:ing)?|éclairc|تفتيح|توحيد\s*لون/i, 'تفتيح البشرة'],
        [/anti[- ]?acne|treat(?:s|ing)?\s+acne|مضاد\s*لح(?:ب|بّ)\s*الشباب/i, 'مضاد لحب الشباب'],
        [/hydrating|moisturi[sz](?:e|ing|er|ation)?|hydratant|مرطب\s*للبشرة|ترطيب\s*البشرة/i, 'مرطب للبشرة'],
        [/soothing|calming|apaisant|مهدئ|تهدئة\s*البشرة/i, 'تهدئة البشرة'],
        [/antioxidant|مضاد\s*للأكسدة|مضاد\s*للاكسدة/i, 'مضاد للأكسدة'],
        [/anti[- ]?wrinkle|anti[- ]?aging|anti[- ]?rides|مكافحة\s*التجاعيد/i, 'مكافحة التجاعيد'],
        [/sun\s*protection|protect(?:ion)?\s*(?:from|against)\s*(?:the\s*)?sun|broad[- ]spectrum|حماية\s*(?:واسعة\s*الطيف\s*)?من\s*الشمس/i, 'حماية من الشمس'],
        [/anti[- ]dandruff|مضاد\s*للقشرة/i, 'مضاد للقشرة'],
    ];
    const claims = claimRules.filter(([re]) => re.test(raw)).map(([, value]) => value);
    if (claims.length) args.marketing_claims = Array.from(new Set(claims));

    const activeRules: Array<[RegExp, string]> = [
        [/niacinamide|نياسيناميد/i, 'Niacinamide'],
        [/retinol|ريتينول/i, 'Retinol'],
        [/salicylic\s*acid|acide\s*salicylique|حمض\s*الساليسيليك/i, 'Salicylic Acid'],
        [/vitamin\s*c|vitamine\s*c|فيتامين\s*سي|فيتامين\s*ج/i, 'Vitamin C'],
        [/hyaluronic\s*acid|acide\s*hyaluronique|حمض\s*الهيالورونيك/i, 'Hyaluronic Acid'],
        [/azelaic\s*acid|acide\s*az[eé]la[iï]que|حمض\s*الأزيليك|حمض\s*الازيليك/i, 'Azelaic Acid'],
        [/benzoyl\s*peroxide|بنزويل\s*بيروكسيد/i, 'Benzoyl Peroxide'],
        [/panthenol|بانثينول/i, 'Panthenol'],
        [/ceramides?|c[eé]ramides?|سيراميد/i, 'Ceramide'],
    ];
    const active = activeRules.find(([re]) => re.test(raw));
    if (active) args.active_ingredient = active[1];

    const exclusions: Array<[RegExp, string]> = [
        [/(?:without|free\s+from|sans|بدون|بلا|خالي(?:ة)?\s+من)\s+(?:any\s+)?(?:fragrance|perfume|parfum|عطر|عطور)/i, 'fragrance'],
        [/(?:without|free\s+from|sans|بدون|بلا|خالي(?:ة)?\s+من)\s+(?:any\s+)?(?:alcohol|alcool|كحول)/i, 'alcohol'],
        [/(?:without|free\s+from|sans|بدون|بلا|خالي(?:ة)?\s+من)\s+(?:any\s+)?(?:sulfates?|sulphates?|sls|كبريتات|سلفات)/i, 'sulfate'],
        [/(?:without|free\s+from|sans|بدون|بلا|خالي(?:ة)?\s+من)\s+(?:any\s+)?(?:parabens?|بارابين)/i, 'paraben'],
    ];
    const excluded = exclusions.filter(([re]) => re.test(raw)).map(([, value]) => value);
    if (excluded.length) args.exclude_ingredients = Array.from(new Set(excluded));
    if (/\b(?:cheapest|cheaper|lowest\s+price)\b|الأرخص|ارخص|أقل\s*سعر|اقل\s*سعر/i.test(raw)) args.sort_by = 'price_asc';
    if (/\b(?:most\s+expensive|highest\s+price)\b|الأغلى|اغلى/i.test(raw)) args.sort_by = 'price_desc';

    const brandMatch = raw.match(/(?:\bbrand\b|\bmarque\b|ماركة|ماركه|براند)\s+([\p{L}\p{N}][\p{L}\p{N}&.'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}&.'’-]*)?)/iu);
    if (brandMatch?.[1]) args.brand = brandMatch[1].trim();

    // Build a residual product/brand-name query, not the whole natural-language
    // prompt; structured constraints are already passed in their own fields.
    let residual = foldMessage(raw);
    const remove: RegExp[] = [
        /\b(?:i|im|i'm|want|looking|for|search|searching|find|show|recommend|suggest|give|me|do|you|have|any|best|product|products|please|could|can|the|a|an|and|or|of|to|from|with|in|under|below|less|than|cheap|cheaper)\b/gi,
        /(?:أريد|اريد|ابحث|أبحث|اعطني|أعطني|وريني|أرني|عندك|هل\s*عندك|نحب|نبغي|بغيت|من\s*فضلك|ممكن|الأفضل|افضل|أفضل|منتجات|منتج|لي|عن|في|من|على|مع)/gi,
        /\b(?:algeria|algerian|alg[eé]rie|france|french|korea|korean|tunisia|egypt|turkey)\b|الجزائر(?:ية)?|جزائري(?:ة)?|فرنسا|فرنسي(?:ة)?|كوريا|كوري(?:ة)?|تونس|تونسي(?:ة)?|مصر|مصري(?:ة)?/gi,
        /\b(?:skin serum|serum|s[eé]rum|face wash|cleanser|sunscreen|sun screen|sunblock|moisturizer|moisturiser|cream|lotion|toner|shampoo|shampoing|hair mask|conditioner|body wash|eye cream|scrub)\b|سيروم|غسول|منظف|واقي\s*(?:من\s*)?الشمس|واقي\s*شمسي|مرطب|كريم|شامبو|بلسم|تونر|مقشر/gi,
        /\b(?:oily|greasy|dry|sensitive|combination|acne|dehydrated|curly|damaged|dandruff|frizzy|brighten(?:ing)?|lighten(?:ing)?|dark spots?|hyperpigmentation|hydrating|moisturi[sz](?:e|ing|er|ation)?|soothing|calming|retinol|niacinamide|salicylic acid|vitamin c|hyaluronic acid|azelaic acid|benzoyl peroxide|panthenol|ceramides?)\b|دهنية|دهني|جافة|جاف|حساسة|مختلطة|حب\s*الشباب|تفتيح|توحيد\s*لون|بقع\s*داكنة|ترطيب|ريتينول|نياسيناميد|حمض\s*الساليسيليك|فيتامين\s*سي|حمض\s*الهيالورونيك|حمض\s*الأزيليك|بانثينول|سيراميد/gi,
        /(?:under|below|less\s+than|تحت|أقل\s*من|اقل\s*من)?\s*\d{3,6}\s*(?:دج|دينار|dzd|dz|da)?/gi,
    ];
    for (const re of remove) residual = residual.replace(re, ' ');
    residual = residual.replace(/[.,!?؟،؛:;()\[\]{}"'’`]/g, ' ').replace(/\s+/g, ' ').trim();
    const filler = new Set(['want','looking','search','find','show','recommend','suggest','give','skin','hair','face','the','and','for','under','from','with','algerian','algeria','brightening','claims','product','products']);
    const words = residual.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w) && !filler.has(w));
    if (!args.brand && words.length > 0 && words.length <= 5) args.query = words.join(' ');

    const hasTarget = ['category','country','max_price','skin_type','hair_type','marketing_claims','active_ingredient','exclude_ingredients','brand','query'].some(k => {
        const v = args[k]; return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
    });
    return hasTarget ? args : null;
}

function fmtDirectSearch(lang: Lang, out: any, args: Record<string, any>): string {
    const found = Number(out.foundCount || 0);
    const returned = Number(out.returnedCount || 0);
    const criteria: string[] = [];
    if (args.category) criteria.push(String(args.category).replace(/_/g, ' '));
    if (args.country) criteria.push(String(args.country));
    if (args.skin_type) criteria.push(String(args.skin_type));
    if (args.hair_type) criteria.push(String(args.hair_type));
    if (args.max_price) criteria.push(`${args.max_price} DZD max`);
    const criteriaText = criteria.length ? criteria.join(' · ') : '';
    if (!returned) return tr(lang, {
        ar: `لم أعثر على منتجات مطابقة${criteriaText ? ` للمعايير (${criteriaText})` : ''} في الكتالوج الحالي. جرّب توسيع البحث أو حذف شرط واحد.`,
        fr: `Aucun produit ne correspond${criteriaText ? ` aux critères (${criteriaText})` : ''} dans le catalogue actuel. Élargissez la recherche ou retirez un critère.`,
        en: `I couldn't find matching products${criteriaText ? ` for (${criteriaText})` : ''} in the current catalog. Broaden the search or remove one constraint.`,
    });
    const more = out.hasMore ? tr(lang, { ar: ' اكتب «المزيد» لرؤية نتائج أخرى.', fr: ' Écrivez « plus » pour voir les autres résultats.', en: ' Say “more” to see more results.' }) : '';
    const relaxed = Array.isArray(out.relaxedFilters) && out.relaxedFilters.length
        ? tr(lang, { ar: ` تنبيه: لم يمكن تحقيق بعض الشروط بالكامل (${out.relaxedFilters.join('، ')}).`, fr: ` Note : certains critères n'ont pas été entièrement satisfaits (${out.relaxedFilters.join(', ')}).`, en: ` Note: some constraints could not be fully satisfied (${out.relaxedFilters.join(', ')}).` }) : '';
    return tr(lang, {
        ar: `وجدت ${returned} منتجات${found > returned ? ` من أصل ${found} نتيجة` : ''}${criteriaText ? ` وفق معاييرك (${criteriaText})` : ''}. رتّبت النتائج بحسب مدى المطابقة؛ التفاصيل في البطاقات أدناه.`,
        fr: `${returned} produit(s) trouvé(s)${found > returned ? ` sur ${found} résultats` : ''}${criteriaText ? ` selon vos critères (${criteriaText})` : ''}. Les résultats sont classés par pertinence ; détails dans les cartes ci-dessous.`,
        en: `Found ${returned} product(s)${found > returned ? ` out of ${found} matches` : ''}${criteriaText ? ` for (${criteriaText})` : ''}. Results are ranked by relevance; details are in the cards below.`,
    }) + more + relaxed;
}

// ── the dispatcher ───────────────────────────────────────────────────────────
export async function tryFastLane(input: FastLaneInput): Promise<FastLaneResult | null> {
    if (!FAST_LANE_ENABLED) return null;
    const { message, state, turnState, tools, intent } = input;
    if (!message || message.length > 600) return null;

    const runTool = (name: string, args: any) => {
        const statuses: Record<string, string> = {
            search_products: '🔍 جاري البحث في كتالوج المنتجات...',
            evaluate_product: '🧪 جاري فحص وتحليل التركيبة مع OilGuard...',
            evaluate_brand: '🏷️ جاري تحليل منتجات الماركة...',
            get_product: '📋 جاري استرجاع تفاصيل المنتج ومكوناته...',
            build_routine: '🧴 جاري تكوين روتين عناية متكامل...',
            get_products_details: '📋 جاري استرجاع مكونات المنتجات...',
            get_community_reviews: '💬 جاري فحص تجارب وآراء المستخدمين...',
            compare_products: '⚖️ جاري المقارنة بين المنتجات...',
            check_ingredient_list: '🧫 جاري تحليل قائمة المكونات...',
            product_contains: '🔎 جاري فحص القائمة الكاملة للمكونات...',
            find_alternatives: '🔁 جاري البحث عن بدائل...',
            check_compatibility: '🧬 جاري فحص التوافق...',
            modify_routine: '✏️ جاري تعديل الروتين...',
            generate_usage_schedule: '🗓️ جاري إعداد جدول الاستخدام...',
            triage_reaction: '🩺 جاري تحليل تفاعل البشرة...',
        };
        input.emitStatus?.(statuses[name] || '⚙️ جاري تنفيذ الخطوة المطلوبة...');
        return run(tools, name, args);
    };

    const voice = detectVoice(message, state.profile);
    const lang: Lang = voice.tlang;
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
            const baseLang = lang === 'dz' ? 'ar' : lang;
            let note = welcomeBackNote(baseLang, state.returningFacts);
            if (lang === 'dz') note = darijaize(note);
            if (note) out = `${note}\n${out}`;
        }
        // Distressed users get a calm, emoji-free reply (⚠️ stays).
        if (voice.mood === 'distressed') out = calm(out);
        input.emitText?.(out);
        return { text: out, tool, lang };
    };

    // ── 0a. A bare "yes" accepting the offer made by the previous reply ─────
    const offer = state.pendingOffer;
    if (offer && offer.turn === state.turnCount - 1 && isAffirmative(message)) {
        state.pendingOffer = null;
        input.emitStatus?.('✨ ...');

        // Contribute-to-catalog: no tool — straight to the moderation queue.
        if (offer.tool === 'submit_contribution') {
            const ls: any = state.lastLabelScan;
            if (ls?.ingredients && ls.uncatalogued) {
                const r = submitContribution(
                    { brand: ls.brand, name: ls.name, category: ls.category, ingredients: ls.ingredients, quantity: ls.quantity },
                    state.userId || 'anon'
                );
                if (r.ok) {
                    return finish(tr(lang, {
                        ar: r.duplicate ? 'هذا المنتج مقترح سابقاً وهو قيد المراجعة، شكراً لك!' : 'شكراً! أرسلته للمراجعة، وبعد التأكد منه سيُضاف للكتالوج.',
                        fr: r.duplicate ? 'Ce produit est déjà proposé et en cours de modération, merci !' : 'Merci ! Envoyé en modération ; il sera ajouté au catalogue après vérification.',
                        en: r.duplicate ? 'This product was already submitted and is awaiting moderation — thanks!' : 'Thanks! Sent for moderation — it will be added to the catalog once verified.',
                    }), 'submit_contribution');
                }
                return finish(tr(lang, {
                    ar: r.error === 'rate_limited' ? 'وصلت للحد اليومي من المساهمات، جرّب غداً.' : 'لم تكتمل بيانات المنتج لإرساله (أحتاج الاسم وقائمة المكونات).',
                    fr: r.error === 'rate_limited' ? 'Limite quotidienne de contributions atteinte.' : 'Données incomplètes pour l\'envoyer (nom + liste d\'ingrédients requis).',
                    en: r.error === 'rate_limited' ? 'Daily contribution limit reached.' : 'Not enough data to submit (name and ingredient list are required).',
                }), 'submit_contribution');
            }
            return null;
        }

        const out = await runTool(offer.tool, offer.args);
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
            if (offer.tool === 'manage_cabinet') {
                emitCardForTool('manage_cabinet', turnState, input.emitCard);
                // an uncatalogued scanned product: chain the contribution offer
                const ls: any = state.lastLabelScan;
                const chain: NextStep | null = ls?.uncatalogued
                    ? { text: { ar: 'تحب نرسله للكتالوج بعد مراجعته ليستفيد منه غيرك؟', fr: 'Voulez-vous le proposer au catalogue (après modération) ?', en: 'Want to submit it to the catalog (after moderation) so others can use it?' }, offer: { tool: 'submit_contribution', args: {} } }
                    : null;
                return finish(fmtCabinet(lang, 'add', out), 'manage_cabinet', chain);
            }
            if (offer.tool === 'generate_usage_schedule') {
                emitCardForTool('generate_usage_schedule', turnState, input.emitCard);
                return finish(fmtSchedule(lang, out), 'generate_usage_schedule');
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
                const out = await runTool('evaluate_product', { productId: cands[0].id });
                if (out && typeof out.oilGuardScore === 'number') {
                    emitCardForTool('evaluate_product', turnState, input.emitCard);
                    return finish(sorry + fmtEvaluate(lang, out, turnState, state), 'evaluate_product', nextStepFor('evaluate_product', { out, state, productId: cands[0].id, potentActive: potentActiveOf(turnState, lang) }));
                }
            } else if (cands.length >= 1) {
                const out = await runTool('search_products', { brand: cands[0].brand, category: cat });
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
        const out = await runTool('search_products', refinement.args);
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
            // ── deterministic catalog search ────────────────────────────────
            case 'search_products': {
                const args = directSearchArgs(message, intent);
                if (!args) return null;
                const out = await runTool('search_products', args);
                if (!out || typeof out.returnedCount !== 'number') break;
                if (out.returnedCount > 0) emitCardForTool('search_products', turnState, input.emitCard);
                return finish(fmtDirectSearch(lang, out, args), 'search_products');
            }

            // ── evaluate one product ─────────────────────────────────────────
            case 'evaluate_product': {
                // signed-in: the product is already on the user's shelf with a stored analysis → answer instantly
                if (state.authenticated) {
                    const q = leftoverTokens(message).join(' ');
                    const hit = q ? findShelfAnalysis(state, q) : null;
                    if (hit) {
                        input.emitCard?.('shelf_product', { product: hit });
                        return finish(fmtShelfAnalysis(lang, hit), 'evaluate_product');
                    }
                }
                const target = await resolveProductTarget(message, state);
                if (!target) return null;
                const out = await runTool('evaluate_product', { productId: target.id });
                if (!out || typeof out.oilGuardScore !== 'number') break;
                emitCardForTool('evaluate_product', turnState, input.emitCard);
                const cabNote = cabinetNote(lang, state, turnState, target.id);
                return finish(fmtEvaluate(lang, out, turnState, state) + (cabNote ? ' ' + cabNote : ''), 'evaluate_product', nextStepFor('evaluate_product', { out, state, productId: target.id, potentActive: potentActiveOf(turnState, lang) }));
            }

            // ── brand verdict (single-brand, non-compound) ───────────────────
            case 'evaluate_brand': {
                const possessive = resolveBrandCategoryReference(message, state);
                const brandName = possessive?.brand || intent.entities.brand;
                if (!brandName) return null;
                const out = await runTool('evaluate_brand', {
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
                const out = await runTool('compare_products', { products: [] });
                if (!out) break;
                emitCardForTool('compare_products', turnState, input.emitCard);
                return finish(fmtCompare(lang, out), 'compare_products', nextStepFor('compare_products', { out, state }));
            }

            // ── raw INCI paste ───────────────────────────────────────────────
            case 'check_ingredient_list': {
                const idx = message.search(/[A-Za-z]{3,}/);
                if (idx < 0) return null;
                const text = message.slice(idx).replace(/^[A-Za-z ]{0,20}:\s*(?=[A-Za-z])/, (m) => (/ingredients?|inci|composition/i.test(m) ? '' : m));
                const out = await runTool('check_ingredient_list', { ingredients_text: text });
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
                const out = await runTool('product_contains', { productId: target.id, ingredient: message });
                if (!out || !out.checks) break;
                void concepts;
                emitCardForTool('product_contains', turnState, input.emitCard);
                return finish(fmtContains(lang, out), 'product_contains', nextStepFor('product_contains', { out, state }));
            }

            // ── alternatives / "cheaper one like this" ───────────────────────
            case 'find_alternatives': {
                const target = await resolveProductTarget(message, state);
                if (!target) return null;
                const out = await runTool('find_alternatives', {
                    productId: target.id,
                    cheaper_only: CHEAPER_RE.test(folded) || undefined,
                });
                const products = turnState.lastProductResults as any[] | null;
                if (!out || !products || products.length === 0) break;
                emitCardForTool('find_alternatives', turnState, input.emitCard);
                return finish(fmtAlternatives(lang, out, products), 'find_alternatives', nextStepFor('find_alternatives', { out, state, products }));
            }

            // ── local dupe of an imported product ────────────────────────────
            case 'find_actives_dupe': {
                const req = parseDupeRequest(message);
                if (!req || !req.reference) return null;     // unknown import → LLM supplies target_actives
                const out = await runTool('find_actives_dupe', {
                    reference_product: req.reference.label,
                    reference_price: req.price,
                    country: req.local ? 'Algeria' : undefined,
                    category: req.reference.category,
                });
                const products = turnState.lastProductResults as any[] | null;
                if (!out || !products || products.length === 0) break;
                emitCardForTool('find_actives_dupe', turnState, input.emitCard);
                return finish(fmtDupe(lang, out, products), 'find_actives_dupe');
            }

            // ── induction schedule ───────────────────────────────────────────
            case 'generate_usage_schedule': {
                if (!isScheduleQuestion(message).yes) return null;
                const out = await runTool('generate_usage_schedule', { active: message });
                if (!out || !out.weeks) break;
                emitCardForTool('generate_usage_schedule', turnState, input.emitCard);
                return finish(fmtSchedule(lang, out), 'generate_usage_schedule');
            }

            // ── "why this one?" ──────────────────────────────────────────────
            case 'explain_pick': {
                if (!isWhyQuestion(message)) return null;
                const out = await runTool('explain_pick', {});
                if (!out || !out.reasons) break;
                emitCardForTool('explain_pick', turnState, input.emitCard);
                return finish(fmtExplain(lang, out), 'explain_pick');
            }

            // ── routine history / share / shopping / gift ────────────────────
            case 'routine_versions': {
                const cmd = parseVersionCommand(message);
                if (!cmd || !state.lastRoutine) return null;
                const out = await runTool('routine_versions', { action: cmd.action, version: cmd.version });
                if (!out) break;
                emitCardForTool('routine_versions', turnState, input.emitCard);
                return finish(fmtVersions(lang, cmd.action, out), 'routine_versions');
            }
            case 'share_routine': {
                const out = await runTool('share_routine', {});
                if (!out) break;
                emitCardForTool('share_routine', turnState, input.emitCard);
                return finish(tr(lang, { ar: `جهّزت الروتين للمشاركة (${out.total.value} دج). انسخ النص أو استعمل زر المشاركة 👇`, fr: `Routine prête à partager (${out.total.value} DA). Copiez le texte ou utilisez le bouton de partage 👇`, en: `Your routine is ready to share (${out.total.value} DZD). Copy the text or use the share button 👇` }), 'share_routine');
            }
            case 'build_shopping_list': {
                const out = await runTool('build_shopping_list', {});
                if (!out || !out.toBuy) break;
                emitCardForTool('build_shopping_list', turnState, input.emitCard);
                return finish(fmtShopping(lang, out), 'build_shopping_list');
            }
            case 'build_gift_set': {
                const oc = parseOutputCommand(message);
                if (!oc || oc.kind !== 'gift') return null;
                if (!oc.budget) {
                    return finish(tr(lang, { ar: 'يا سلام، هدية! شحال ميزانيتك لها؟', fr: 'Une belle attention ! Quel est votre budget ?', en: 'A lovely gift! What\'s your budget?', dz: 'هدية؟ مليح! شحال ميزانيتك؟' }), 'build_gift_set');
                }
                const rec = message.match(/(?:لماما|لأمي|لامي|لأختي|لصديقتي|لزوجتي|لبنتي|لأبي|mom|mother|sister|friend|wife|daughter|maman|sœur|amie|femme)/i)?.[0];
                const out = await runTool('build_gift_set', { budget: oc.budget, recipient: rec });
                if (!out || !out.items) break;
                emitCardForTool('build_gift_set', turnState, input.emitCard);
                return finish(fmtGift(lang, out), 'build_gift_set');
            }

            // ── reaction triage ──────────────────────────────────────────────
            case 'triage_reaction': {
                const out = await runTool('triage_reaction', {});
                if (!out || !out.steps) break;
                emitCardForTool('triage_reaction', turnState, input.emitCard);
                return finish(fmtTriage(lang, out), 'triage_reaction');
            }

            // ── my cabinet ───────────────────────────────────────────────────
            case 'manage_cabinet': {
                const cmd = parseCabinetCommand(message);
                if (!cmd) return null;
                if (!state.userId) {
                    return finish(tr(lang, {
                        ar: 'خزانتك الشخصية تحتاج حساباً — سجّل الدخول (أو فعّل «حفظ منتجاتي») وأضيفه فوراً.',
                        fr: 'Votre armoire personnelle nécessite un compte — connectez-vous (ou activez « enregistrer mes produits »).',
                        en: 'Your personal cabinet needs an account — sign in (or enable "save my products") and I\'ll add it.',
                    }), 'manage_cabinet');
                }
                const hasCtx = !!(state.lastProduct?.id || state.lastAnalysis?.productId);
                let args: any;
                if (cmd.action === 'list') args = { action: 'list' };
                else if (!hasCtx) return null;                       // which product? → LLM asks
                else if (cmd.action === 'remove') args = { action: 'remove' };
                else if (cmd.action === 'add') args = { action: 'add' };
                else args = { action: 'update', status: cmd.status, verdict: cmd.verdict };
                const out = await runTool('manage_cabinet', args);
                if (!out) break;
                emitCardForTool('manage_cabinet', turnState, input.emitCard);
                return finish(fmtCabinet(lang, args.action, out), 'manage_cabinet');
            }

            // ── compatibility ────────────────────────────────────────────────
            case 'check_compatibility': {
                const q = isCompatQuestion(message, !!state.lastRoutine);
                if (!q.yes) return null;
                const args = q.routineMode
                    ? { productIds: (state.lastRoutine?.steps || []).map((s: any) => s.product?.id).filter(Boolean) }
                    : { actives: [message] };
                const out = await runTool('check_compatibility', args);
                if (!out) break;
                emitCardForTool('check_compatibility', turnState, input.emitCard);
                return finish(fmtCompat(lang, out), 'check_compatibility');
            }

            // ── routine edits ────────────────────────────────────────────────
            case 'modify_routine': {
                if (!state.lastRoutine) return null;
                const edit = parseRoutineEdit(message);
                if (!edit) return null;
                const out = await runTool('modify_routine', edit);
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
