/**
 * SCAN LANE — "I'm at the parapharmacy, is this worth buying?" + a photo.
 *
 * Photo(s) → vision OCR (the contribution parser you already have) → resolve the
 * product against the catalog → OilGuard scoring → a short verdict, with the
 * same cards the text flows use. If the product is not in the catalog, the INCI
 * list read from the photo is scored directly (check_ingredient_list).
 *
 * Deterministic after the single vision call: no extra model round-trips.
 */
import type { SessionState, AgentStateTracker } from './sessionMemory';
import { getProduct, norm } from './tools/getProduct';
import { sanitizeScanImages, ExtractedLabel, LabelParser } from './tools/scanShelfLabel';
import { emitCardForTool, resetTurnState } from './cards';
import { tr, detectVoice, calm, TLang as Lang } from './voice';

const PLACEHOLDER_BRAND = 'غير محدد';
const PLACEHOLDER_NAME = 'منتج عناية';

export interface ScanLaneInput {
    message: string;
    images: any;
    state: SessionState;
    turnState: AgentStateTracker;
    tools: Record<string, any>;
    parser: LabelParser;
    emitCard?: (type: string, data: any) => void;
    emitText?: (delta: string) => void;
    emitStatus?: (status: string) => void;
}

export interface ScanLaneResult { text: string; tool: string; lang: Lang }

export function scanVerdict(lang: Lang, score: number): string {
    if (score >= 80) return tr(lang, { ar: 'خيار ممتاز للشراء', fr: 'Très bon choix à l\'achat', en: 'An excellent buy' });
    if (score >= 65) return tr(lang, { ar: 'خيار جيد ومقبول', fr: 'Choix correct', en: 'A decent choice' });
    if (score >= 50) return tr(lang, { ar: 'متوسط — هناك خيارات أفضل', fr: 'Moyen — il existe mieux', en: 'Average — better options exist' });
    return tr(lang, { ar: 'لا أنصح بشرائه', fr: 'Je ne le recommande pas', en: 'I would not recommend buying it' });
}

async function run(tools: Record<string, any>, name: string, args: any) {
    try {
        const out = await tools[name]?.execute?.(args, { toolCallId: `scan_${name}`, messages: [] });
        return out && !out.error ? out : null;
    } catch { return null; }
}

export async function tryScanLane(input: ScanLaneInput): Promise<ScanLaneResult | null> {
    const imgs = sanitizeScanImages(input.images);
    const voice = detectVoice(input.message || '', input.state.profile);
    const lang: Lang = voice.tlang;
    const reply = (raw: string, tool = 'scan_shelf_label', cabinetOffer?: any, uncatalogued = false): ScanLaneResult => {
        let body = raw;
        if (uncatalogued && input.state.lastLabelScan) input.state.lastLabelScan.uncatalogued = true;
        if (uncatalogued && !input.state.userId) {
            // no cabinet to offer → offer to help grow the catalog instead
            body += ' ' + tr(lang, { ar: 'تحب نرسله للكتالوج بعد مراجعته ليستفيد منه غيرك؟', fr: 'Voulez-vous le proposer au catalogue (après modération) ?', en: 'Want to submit it to the catalog (after moderation) so others can use it?', dz: 'تحب نبعثو للكتالوج بعد المراجعة باش يستفيد منو غيرك؟' });
            input.state.pendingOffer = { tool: 'submit_contribution', args: {}, turn: input.state.turnCount };
        } else if (cabinetOffer && input.state.userId) {
            body += ' ' + tr(lang, { ar: 'تحب نضيفه لخزانتك؟', fr: 'Je l\'ajoute à votre armoire ?', en: 'Shall I add it to your cabinet?', dz: 'تحب نزيدو لخزانتك؟' });
            input.state.pendingOffer = { tool: 'manage_cabinet', args: cabinetOffer, turn: input.state.turnCount };
        }
        const text = voice.mood === 'distressed' ? calm(body) : body;
        input.emitText?.(text);
        return { text, tool, lang };
    };

    if (!imgs) {
        return reply(tr(lang, {
            ar: 'لم أتمكن من استعمال الصورة المرفقة (الصيغة أو الحجم غير مقبول). جرّب صورة JPG/PNG أوضح وأصغر.',
            fr: 'Je n\'ai pas pu utiliser la photo (format ou taille non accepté). Essayez une photo JPG/PNG plus nette et plus légère.',
            en: 'I could not use the attached photo (unsupported format or size). Try a clearer, smaller JPG/PNG.',
        }));
    }

    input.emitStatus?.('📷 جاري قراءة المنتج من الصورة...');
    let label: ExtractedLabel;
    try {
        label = await input.parser({ frontImage: imgs.frontImage, inciImage: imgs.inciImage });
    } catch (e: any) {
        console.warn('[SCAN] vision parse failed:', e?.message);
        return reply(tr(lang, {
            ar: 'تعذّرت قراءة الصورة. صوّر الجهة الخلفية (قائمة المكونات) بإضاءة جيدة وحاول مجدداً.',
            fr: 'Lecture de la photo impossible. Photographiez le dos (liste d\'ingrédients) avec une bonne lumière.',
            en: 'I could not read the photo. Photograph the back (ingredient list) in good light and try again.',
        }));
    }

    const hasIdentity = label.brand && label.brand !== PLACEHOLDER_BRAND && label.name && label.name !== PLACEHOLDER_NAME;
    const ingredientCount = (label.ingredients || '').split(',').filter(s => s.trim().length > 1).length;
    const scanCard = {
        brand: label.brand, name: label.name, category: label.category, quantity: label.quantity,
        ingredientCount, recognized: !!hasIdentity,
    };
    (input.turnState as any).lastLabelScan = scanCard;
    // server-side only: the INCI text + whether the product is uncatalogued (for the contribution offer)
    input.state.lastLabelScan = { ...scanCard, ingredients: label.ingredients, uncatalogued: false };
    input.emitCard?.('label_scan', scanCard);
    const scanned = hasIdentity ? `${label.brand} ${label.name}`.trim() : tr(lang, { ar: 'المنتج المصوَّر', fr: 'le produit photographié', en: 'the photographed product' });

    // ── 1. Catalog hit → full evaluation with the product's own data ─────────
    if (hasIdentity) {
        const q = `${label.brand} ${label.name}`;
        const res = await getProduct({ productName: q, query: q });
        if (res.found && res.product) {
            const strong = /^(exact_id|partial_id|exact_name|unique_substring)/.test(res.matchStrategy || '')
                || norm(q).includes(norm(res.product.brand));
            if (strong) {
                const out = await run(input.tools, 'evaluate_product', { productId: res.product.id });
                if (out && typeof out.oilGuardScore === 'number') {
                    emitCardForTool('evaluate_product', input.turnState, input.emitCard);
                    const name = `${out.brand} ${out.name}`.trim();
                    const text = tr(lang, {
                        ar: `${name} (موجود في كتالوجنا): ${out.oilGuardScore}/100 — ${scanVerdict(lang, out.oilGuardScore)}. ${out.finalVerdict || ''} التفاصيل في البطاقة 👇`,
                        fr: `${name} (dans notre catalogue) : ${out.oilGuardScore}/100 — ${scanVerdict(lang, out.oilGuardScore)}. ${out.finalVerdict || ''} Détails dans la carte 👇`,
                        en: `${name} (in our catalog): ${out.oilGuardScore}/100 — ${scanVerdict(lang, out.oilGuardScore)}. ${out.finalVerdict || ''} Details in the card 👇`,
                    }).replace(/\s+\./g, '.');
                    return reply(text, 'evaluate_product', { action: 'add', product_id: res.product.id });
                }
            }
        }
    }

    // ── 2. Not in catalog → score the INCI list read from the photo ──────────
    if (ingredientCount >= 2) {
        const out = await run(input.tools, 'check_ingredient_list', {
            ingredients_text: label.ingredients,
            product_type: label.category,
            label: hasIdentity ? `${label.brand} ${label.name}` : undefined,
        });
        if (out && typeof out.score === 'number') {
            emitCardForTool('check_ingredient_list', input.turnState, input.emitCard);
            let text = tr(lang, {
                ar: `قرأت تركيبة ${scanned} من الصورة (${ingredientCount} مكوّن): ${out.score}/100 — ${scanVerdict(lang, out.score)}.`,
                fr: `Composition de ${scanned} lue sur la photo (${ingredientCount} ingrédients) : ${out.score}/100 — ${scanVerdict(lang, out.score)}.`,
                en: `Read ${scanned}'s ingredients from the photo (${ingredientCount} items): ${out.score}/100 — ${scanVerdict(lang, out.score)}.`,
            });
            if (out.allergenHits?.length) {
                text += ' ' + tr(lang, {
                    ar: `⚠️ تحتوي على ${out.allergenHits.join('، ')} (مما تتجنبه).`,
                    fr: `⚠️ Contient ${out.allergenHits.join(', ')} (que vous évitez).`,
                    en: `⚠️ Contains ${out.allergenHits.join(', ')} (on your avoid list).`,
                });
            } else if (out.safetyFlags?.length) {
                text += ' ' + out.safetyFlags.slice(0, 2).join(' · ') + '.';
            }
            text += ' ' + tr(lang, { ar: 'غير موجود في كتالوجنا، لذا التقييم مبني على التركيبة المقروءة فقط. التفاصيل في البطاقة 👇', fr: 'Absent de notre catalogue : évaluation basée uniquement sur la composition lue. Détails dans la carte 👇', en: 'Not in our catalog, so this is based on the ingredients read from the photo only. Details in the card 👇' });
            return reply(text, 'check_ingredient_list', { action: 'add', brand: label.brand !== PLACEHOLDER_BRAND ? label.brand : undefined, name: hasIdentity ? label.name : scanned, ingredients_text: label.ingredients, category: label.category }, true);
        }
    }

    // ── 3. Could not read ingredients → ask for the right photo ──────────────
    resetTurnState(input.turnState);
    return reply(hasIdentity
        ? tr(lang, {
            ar: `تعرّفت على ${scanned} لكنه غير موجود في الكتالوج ولم أقرأ قائمة مكوناته. صوّر الجهة الخلفية (INCI) لأقيّمه لك.`,
            fr: `J'ai reconnu ${scanned} mais il n'est pas au catalogue et je n'ai pas lu les ingrédients. Photographiez le dos (INCI) et je l'évalue.`,
            en: `I recognised ${scanned}, but it is not in the catalog and I could not read its ingredients. Photograph the back (INCI list) and I will score it.`,
        })
        : tr(lang, {
            ar: 'لم أتعرف على المنتج ولا على مكوناته. صوّر الجهة الخلفية (قائمة المكونات INCI) بإضاءة جيدة وقريبة.',
            fr: 'Je n\'ai reconnu ni le produit ni ses ingrédients. Photographiez le dos (liste INCI) de près et bien éclairé.',
            en: 'I could not identify the product or its ingredients. Photograph the back (INCI list) up close in good light.',
        }));
}
