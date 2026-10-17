/**
 * modify_routine — edit the routine already shown instead of rebuilding it.
 *
 * Before: "بدّل الخطوة الثانية بشي أرخص" re-ran build_routine from scratch and
 * could change every product (including the cleanser the user liked).
 * After: only the targeted step changes; every other step is kept verbatim,
 * totals/savings are recomputed, and allergy/avoid filters are never relaxed.
 *
 * Actions
 *   swap   – replace one step (optionally "cheaper" or with a named product)
 *   remove – drop one step
 *   add    – add a step for a category (toner, sunscreen, mask, eye_cream…)
 *   refit  – bring the routine under a new budget by swapping the most
 *            expensive steps for cheaper same-category products
 */
import { getProducts } from '../../wathiq/backendClient';
import { getProduct } from './getProduct';
import { searchProducts } from './searchProducts';
import { RoutineResult, RoutineStep } from './buildRoutine';
import { getRepresentativePrice } from '../priceUtils';
import { normalizeCategory, normalizeArabicText } from '../taxonomy';

export type AtomicRoutineAction = 'swap' | 'remove' | 'add' | 'refit';
export type RoutineAction = AtomicRoutineAction | 'replace_all' | 'batch';

export interface RoutineEditItem {
    action: 'swap' | 'remove' | 'add';
    /** 1-based step number in the routine as it was shown. */
    step_number?: number;
    category?: string;
    cheaper?: boolean;
    replacement?: { id?: string; name?: string };
    /** Optional brand constraint for a category replacement/addition. */
    preferred_brand?: string;
    /** Optional approved category change when the original category has no viable products. */
    new_category?: string;
    /** When true, keep successful batch edits and report unavailable ones for follow-up. */
    allow_partial?: boolean;
}

export interface ModifyRoutineArgs {
    action: RoutineAction;
    /** 1-based step number as shown to the user. */
    step_number?: number;
    /** Category of the step/product to target or add ("sunscreen", "toner", "serum"…). */
    category?: string;
    /** swap: pick something strictly cheaper than the current step. */
    cheaper?: boolean;
    /** swap: user named the replacement product. */
    replacement?: { id?: string; name?: string };
    /** Optional required brand when selecting a replacement product. */
    preferred_brand?: string;
    /** Change the targeted step's functional category only when explicitly approved by the user. */
    new_category?: string;
    /** Batch mode: apply feasible edits and leave failed edits unchanged. */
    allow_partial?: boolean;
    /** New budget in DZD (refit / swap / add). Defaults to the routine's budget. */
    max_budget?: number;
    /** Internal per-step ceiling used by replace_all to distribute the budget fairly. */
    price_cap?: number;
    /** Several explicit operations, e.g. replace cleanser and serum in one turn. */
    edits?: RoutineEditItem[];
    /** replace_all: categories/products the user explicitly wants to keep unchanged. */
    exclude_categories?: string[];
}

export interface ModifyRoutineAtomicArgs extends Omit<ModifyRoutineArgs, 'action' | 'edits'> {
    action: AtomicRoutineAction;
}

export interface ModifyContext {
    avoid_ingredients?: string[];
    country?: string;
}

export interface RoutineFollowUp {
    needsFollowup: true;
    kind: 'missing_routine' | 'target_unclear' | 'brand_unavailable' | 'product_unavailable' | 'budget' | 'duplicate_step' | 'constraint_conflict' | 'batch_failure' | 'unsupported_request' | 'edit_failed';
    message: string;
    question: string;
    options: string[];
    recoverable: true;
    unchanged: true;
    details?: string[];
}

export type ModifyRoutineResult =
    | (RoutineResult & { modification: { action: RoutineAction; summary: string; before?: any; after?: any; stillOverBudget?: boolean; changedCount?: number; requestedCount?: number; changes?: any[]; skipped?: string[] } })
    | { error: string }
    | RoutineFollowUp;

const SAVINGS_TIP_RE = /تم توفير|تم استغلال الميزانية/;

const ADD_DEFS: Record<string, { name: string; usageTime: string; howToUse: string; why: string }> = {
    toner: { name: 'التونر', usageTime: 'صباحاً ومساءً بعد الغسول', howToUse: 'يُوضع على قطنة أو بالكف ويُربّت على البشرة قبل السيروم.', why: 'يهيّئ البشرة لامتصاص باقي المنتجات.' },
    sunscreen: { name: 'الحماية النهارية من الشمس', usageTime: 'صباحاً قبل الخروج بـ 15 دقيقة', howToUse: 'توضع كمية كافية (مقدار إصبعين) وتُجدد كل ساعتين عند التعرض للشمس.', why: 'حماية واسعة الطيف تمنع التصبغات وتلف الكولاجين.' },
    mask: { name: 'الماسك', usageTime: 'مرة إلى مرتين أسبوعياً', howToUse: 'يوضع على بشرة نظيفة حسب مدة العبوة ثم يُشطف.', why: 'عناية مكثفة إضافية.' },
    hair_mask: { name: 'ماسك الشعر', usageTime: 'مرة أسبوعياً', howToUse: 'يوزع على الشعر الرطب من الأطراف ويُشطف بعد المدة المدونة.', why: 'تغذية وإصلاح مكثف للشعر.' },
    eye_cream: { name: 'كريم العين', usageTime: 'صباحاً ومساءً', howToUse: 'كمية صغيرة بطرف الإصبع حول العين بالتربيت.', why: 'عناية مخصصة لمنطقة حول العين.' },
    scrub: { name: 'المقشر', usageTime: 'مرة أسبوعياً', howToUse: 'يُدلّك بلطف على بشرة رطبة ثم يُشطف؛ لا تستعمله يومياً.', why: 'إزالة الخلايا الميتة.' },
    cleanser: { name: 'الغسول', usageTime: 'صباحاً ومساءً', howToUse: 'يُدلّك على الوجه المبلل ثم يُشطف بالماء الفاتر.', why: 'تنظيف أساسي.' },
    skin_serum: { name: 'السيروم', usageTime: 'مساءً (أو صباحاً حسب النوع)', howToUse: 'بضع قطرات على بشرة نظيفة قبل الكريم.', why: 'مكوّنات مركّزة لمشكلتك.' },
    lotion_cream: { name: 'المرطب', usageTime: 'صباحاً ومساءً', howToUse: 'طبقة رقيقة بعد السيروم لقفل الترطيب.', why: 'ترطيب وحماية الحاجز.' },
};
const GENERIC_DEF = { name: 'خطوة إضافية', usageTime: 'حسب تعليمات العبوة', howToUse: 'يُستخدم وفق التعليمات المدونة على العبوة.', why: 'أُضيف بناءً على طلبك.' };

function canonCat(c?: string): string {
    return (normalizeCategory(c || '') || (c || '')).toLowerCase();
}

function sameCategory(a: string, b: string): boolean {
    const x = canonCat(a), y = canonCat(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function recompute(routine: RoutineResult, steps: RoutineStep[], budget: number): RoutineResult {
    const renumbered = steps.map((s, i) => ({ ...s, stepNumber: i + 1 }));
    const totalCost = renumbered.reduce((sum, s) => sum + s.product.price, 0);
    const savings = Math.max(0, budget - totalCost);
    const tips = (routine.usageTips || []).filter(t => !SAVINGS_TIP_RE.test(t));
    tips.push(savings > 0
        ? `تم توفير ${savings} دج من ميزانيتك المقدرة بـ ${budget} دج.`
        : (totalCost > budget ? `⚠️ المجموع (${totalCost} دج) يتجاوز الميزانية (${budget} دج).` : 'تم استغلال الميزانية بالكامل.'));
    return { ...routine, maxBudget: budget, steps: renumbered, stepsCount: renumbered.length, totalCost, savings, usageTips: tips };
}

function buildStepProduct(raw: any, price: number): RoutineStep['product'] {
    return {
        id: raw.id,
        brand: raw.brand || 'ماركة معتمدة',
        name: raw.name || 'منتج عناية',
        price,
        currency: raw.price?.currency || 'دج',
        image: raw.image,
        categoryLabel: typeof raw.category === 'object' ? raw.category?.label : raw.category,
        claims: (raw.marketingClaims || []).slice(0, 3),
    };
}

function findTargetIndex(routine: RoutineResult, args: ModifyRoutineArgs): number {
    if (args.step_number && args.step_number >= 1 && args.step_number <= routine.steps.length) {
        return args.step_number - 1;
    }
    if (args.category) {
        const idx = routine.steps.findIndex(s => sameCategory(s.category, args.category!));
        if (idx >= 0) return idx;
        const n = normalizeArabicText(args.category);
        return routine.steps.findIndex(s => normalizeArabicText(s.stepName).includes(n));
    }
    return -1;
}

/**
 * Finds a catalog product for a category under a price cap, never serving a
 * product that violates the avoid list and never one already in the routine.
 */
async function pickProduct(
    routine: RoutineResult,
    category: string,
    cap: number,
    ctx: ModifyContext,
    extraExcludeIds: string[] = [],
    preferredBrand?: string
): Promise<{ raw: any; price: number } | null> {
    if (cap <= 0) return null;
    const hair = routine.routineType === 'hair';
    const res: any = await searchProducts({
        category,
        ...(preferredBrand ? { brand: preferredBrand } : {}),
        ...(hair ? { hair_type: routine.concern } : { skin_type: routine.concern }),
        max_price: cap,
        exclude_ingredients: ctx.avoid_ingredients?.length ? ctx.avoid_ingredients : undefined,
        exclude_product_ids: [...routine.steps.map(s => s.product.id), ...extraExcludeIds],
        country: ctx.country,
        sort_by: 'relevance',
        limit: 8,
    });

    // Search relaxes exclusions when nothing satisfies them — for a routine we
    // never accept that: no verified-safe product means no replacement.
    if ((res.relaxedFilters || []).some((r: string) => /exclude/i.test(r))) return null;

    const catalog = await getProducts();
    const byId = new Map(catalog.map((p: any) => [String(p.id).toLowerCase(), p]));
    for (const candidate of res.products || []) {
        const raw = byId.get(String(candidate.id).toLowerCase());
        if (!raw) continue;
        if (preferredBrand) {
            const wanted = normalizeArabicText(preferredBrand);
            const actual = normalizeArabicText(String(raw.brand || ''));
            // searchProducts treats brand as a soft constraint if it finds no hits;
            // routine edits must not silently violate an explicitly requested brand.
            if (!wanted || !actual.includes(wanted)) continue;
        }
        const price = getRepresentativePrice(raw);
        if (price > 0 && price <= cap) return { raw, price };
    }
    return null;
}

async function resolveNamed(ref: { id?: string; name?: string }) {
    const r = await getProduct({ productId: ref.id, productName: ref.name, query: ref.name });
    if (!r.found || !r.product) return null;
    const catalog = await getProducts();
    const raw = catalog.find((p: any) => String(p.id).toLowerCase() === String(r.product!.id).toLowerCase());
    if (!raw) return null;
    const price = getRepresentativePrice(raw);
    return price > 0 ? { raw, price } : null;
}

async function modifyRoutineSingle(
    routine: RoutineResult | null | undefined,
    args: ModifyRoutineAtomicArgs,
    ctx: ModifyContext = {}
): Promise<ModifyRoutineResult> {
    if (!routine || !routine.steps?.length) {
        return { error: 'لا يوجد روتين في هذه المحادثة لتعديله. اطلب مني بناء روتين أولاً.' };
    }

    const budget = args.max_budget && args.max_budget > 0 ? args.max_budget : routine.maxBudget;

    // ───────────────────────── REMOVE ─────────────────────────
    if (args.action === 'remove') {
        const idx = findTargetIndex(routine, args);
        if (idx < 0) return { error: 'لم أتمكن من تحديد الخطوة المطلوب حذفها. اذكر رقم الخطوة أو نوع المنتج.' };
        if (routine.steps.length === 1) return { error: 'لا يمكن حذف الخطوة الوحيدة في الروتين.' };
        const removed = routine.steps[idx];
        const next = routine.steps.filter((_, i) => i !== idx);
        const out = recompute(routine, next, budget);
        return { ...out, modification: { action: 'remove', summary: `حُذفت الخطوة ${removed.stepNumber} (${removed.stepName}).`, before: { stepNumber: removed.stepNumber, product: removed.product } } };
    }

    // ───────────────────────── SWAP ─────────────────────────
    if (args.action === 'swap') {
        const idx = findTargetIndex(routine, args);
        if (idx < 0) return { error: 'لم أتمكن من تحديد الخطوة المطلوب تبديلها. اذكر رقم الخطوة أو نوع المنتج.' };
        const target = routine.steps[idx];
        const desiredCategory = args.new_category ? canonCat(args.new_category) : target.category;
        const categoryChanged = !!args.new_category && !sameCategory(target.category, desiredCategory);
        const othersTotal = routine.steps.reduce((s, st, i) => s + (i === idx ? 0 : st.product.price), 0);
        let cap = budget - othersTotal;
        if (typeof args.price_cap === 'number' && args.price_cap > 0) cap = Math.min(cap, args.price_cap);
        if (args.cheaper) cap = Math.min(cap, target.product.price - 1);

        let chosen: { raw: any; price: number } | null = null;
        if (args.replacement && (args.replacement.id || args.replacement.name)) {
            chosen = await resolveNamed(args.replacement);
            if (!chosen) return { error: 'لم أجد المنتج الذي طلبت وضعه بدلاً منه في الكتالوج.' };
            if (routine.steps.some((s, i) => i !== idx && String(s.product.id).toLowerCase() === String(chosen!.raw.id).toLowerCase())) {
                return { error: 'هذا المنتج موجود بالفعل في الروتين.' };
            }
            const rawCategory = typeof chosen.raw.category === 'object' ? (chosen.raw.category?.id || chosen.raw.category?.key || chosen.raw.category?.label) : chosen.raw.category;
            if (rawCategory && !sameCategory(String(rawCategory), desiredCategory)) {
                return { error: `المنتج الذي اخترته ليس من فئة ${desiredCategory}، لذلك لم أضعه في هذه الخطوة.` };
            }
            const avoid = (ctx.avoid_ingredients || []).map(x => normalizeArabicText(x)).filter(Boolean);
            const rawIngredients = chosen.raw.ingredientList || chosen.raw.ingredients || chosen.raw.inci || chosen.raw.inciList || [];
            const ingredientText = normalizeArabicText(Array.isArray(rawIngredients) ? rawIngredients.join(' ') : String(rawIngredients || ''));
            const hit = avoid.find(x => x && ingredientText.includes(normalizeArabicText(x)));
            if (hit) return { error: `لا أستطيع إدخال هذا المنتج لأن قائمة مكوناته تتضمن مادة تتجنبها (${hit}).` };
            if (chosen.price > budget - othersTotal) {
                return { error: `سعر هذا المنتج (${chosen.price} دج) يتجاوز الميزانية المتبقية لهذه الخطوة (${Math.max(0, budget - othersTotal)} دج).` };
            }
        } else {
            chosen = await pickProduct(routine, desiredCategory, cap, ctx, [target.product.id], args.preferred_brand);
            if (!chosen) {
                return { error: args.cheaper
                    ? 'لم أجد بديلاً أرخص لهذه الخطوة يحترم تفضيلاتك وما تتجنبه.'
                    : 'لم أجد بديلاً مناسباً لهذه الخطوة ضمن الميزانية وما تتجنبه.' };
            }
        }

        const newDef = ADD_DEFS[desiredCategory];
        const newStep: RoutineStep = {
            ...target,
            ...(categoryChanged ? {
                category: desiredCategory,
                stepName: newDef?.name || String(chosen.raw.categoryLabel || chosen.raw.category?.label || desiredCategory),
                usageTime: newDef?.usageTime || target.usageTime,
                howToUse: newDef?.howToUse || target.howToUse,
                whyChosen: `تم تغيير نوع الخطوة من ${target.stepName} إلى ${newDef?.name || desiredCategory} بناءً على موافقتك.`,
            } : {}),
            product: buildStepProduct(chosen.raw, chosen.price),
            whyChosen: categoryChanged
                ? `تم تغيير نوع الخطوة من ${target.stepName} إلى ${newStep.stepName} بناءً على موافقتك؛ البديل الجديد بدل ${target.product.brand} ${target.product.name}.`
                : `${target.whyChosen.split('—').pop()?.trim() || ''} (بديل اخترته لك بدل ${target.product.brand} ${target.product.name})`.trim(),
        };
        const steps = routine.steps.map((s, i) => (i === idx ? newStep : s));
        const out = recompute(routine, steps, budget);
        return {
            ...out,
            modification: {
                action: 'swap',
                summary: categoryChanged
                    ? `تغيّر نوع الخطوة ${target.stepNumber} من ${target.stepName} إلى ${newStep.stepName}، واستُبدل المنتج.`
                    : `استُبدلت الخطوة ${target.stepNumber} (${target.stepName}).`,
                before: { stepNumber: target.stepNumber, product: target.product },
                after: { stepNumber: target.stepNumber, product: newStep.product },
            },
        };
    }

    // ───────────────────────── ADD ─────────────────────────
    if (args.action === 'add') {
        if (!args.category) return { error: 'ما نوع الخطوة التي تريد إضافتها؟ (تونر، واقي شمس، ماسك، كريم عين…)' };
        const cat = canonCat(args.category);
        if (routine.steps.some(s => sameCategory(s.category, cat))) {
            return { error: 'الروتين يحتوي بالفعل على هذه الفئة — يمكنني تبديلها بدلاً من إضافتها.' };
        }
        const remaining = budget - routine.totalCost;
        if (remaining <= 0) return { error: `لا توجد ميزانية متبقية (${budget} دج مستهلكة بالكامل). ارفع الميزانية أو أحذف خطوة.` };

        const chosen = await pickProduct(routine, cat, remaining, ctx, [], args.preferred_brand);
        if (!chosen) return { error: `لم أجد منتجاً من هذه الفئة ضمن ${remaining} دج المتبقية يحترم ما تتجنبه.` };

        const def = ADD_DEFS[cat] || GENERIC_DEF;
        const newStep: RoutineStep = {
            stepNumber: 0,
            stepName: def.name,
            category: cat,
            product: buildStepProduct(chosen.raw, chosen.price),
            usageTime: def.usageTime,
            howToUse: def.howToUse,
            whyChosen: `أُضيف بناءً على طلبك — ${def.why}`,
        };
        const steps = [...routine.steps];
        if (cat === 'toner') {
            const cl = steps.findIndex(s => sameCategory(s.category, 'cleanser'));
            steps.splice(cl >= 0 ? cl + 1 : 0, 0, newStep);
        } else {
            steps.push(newStep);
        }
        const out = recompute(routine, steps, budget);
        const pos = out.steps.findIndex(s => s.product.id === newStep.product.id) + 1;
        return { ...out, modification: { action: 'add', summary: `أُضيفت خطوة "${def.name}" كخطوة رقم ${pos}.`, after: { stepNumber: pos, product: newStep.product } } };
    }

    // ───────────────────────── REFIT ─────────────────────────
    if (args.action === 'refit') {
        if (!args.max_budget || args.max_budget <= 0) return { error: 'ما هي الميزانية الجديدة بالدينار؟' };
        let steps = [...routine.steps];
        let total = steps.reduce((s, st) => s + st.product.price, 0);
        const swaps: string[] = [];

        if (total > budget) {
            const order = steps.map((s, i) => ({ i, price: s.product.price })).sort((a, b) => b.price - a.price);
            for (const { i } of order) {
                if (total <= budget) break;
                const target = steps[i];
                const tmpRoutine = { ...routine, steps } as RoutineResult;
                const chosen = await pickProduct(tmpRoutine, target.category, target.product.price - 1, ctx, [target.product.id]);
                if (!chosen) continue;
                total -= target.product.price - chosen.price;
                swaps.push(`${target.product.name} → ${chosen.raw.name}`);
                steps[i] = { ...target, product: buildStepProduct(chosen.raw, chosen.price), whyChosen: `${target.whyChosen} (عُدّل لتناسب ميزانيتك الجديدة)` };
            }
        }

        const out = recompute(routine, steps, budget);
        const over = out.totalCost > budget;
        return {
            ...out,
            modification: {
                action: 'refit',
                stillOverBudget: over,
                summary: over
                    ? `خفّضت التكلفة إلى ${out.totalCost} دج لكنها ما زالت أعلى من ${budget} دج؛ يمكنني حذف خطوة لتناسب الميزانية.`
                    : swaps.length > 0
                        ? `عدّلت ${swaps.length} خطوة لتناسب ميزانية ${budget} دج.`
                        : `الروتين الحالي (${out.totalCost} دج) يناسب الميزانية الجديدة أصلاً.`,
            },
        };
    }

    return { error: 'إجراء غير معروف على الروتين.' };
}


/**
 * Bulk-aware public entry point. All operations run against an in-memory copy;
 * the caller commits the returned routine only when the whole batch succeeds.
 */
async function modifyRoutineInternal(
    routine: RoutineResult | null | undefined,
    args: ModifyRoutineArgs,
    ctx: ModifyContext = {}
): Promise<ModifyRoutineResult> {
    if (!routine || !routine.steps?.length) {
        return { error: 'لا يوجد روتين في هذه المحادثة لتعديله. اطلب مني بناء روتين أولاً.' };
    }
    const budget = args.max_budget && args.max_budget > 0 ? args.max_budget : routine.maxBudget;

    if (args.action === 'replace_all') {
        let current: any = { ...routine, steps: [...routine.steps] };
        const changes: any[] = [];
        const skipped: string[] = [];
        const excluded = (args.exclude_categories || []).map(canonCat).filter(Boolean);
        const targets = routine.steps.map((step, index) => ({ step, index })).filter(({ step }) =>
            !excluded.some(category => sameCategory(step.category, category))
        );
        if (targets.length === 0) return { error: 'كل خطوات الروتين مستثناة من التغيير؛ لم أغيّر أي منتج.' };
        // The order/count stays stable during swaps, so original indexes remain valid.
        // Share the unused budget evenly across all requested replacements; without
        // this cap, the first expensive replacement could consume the whole budget
        // and cause later requested products to remain unchanged.
        const originalTotal = routine.steps.reduce((sum, step) => sum + Number(step.product?.price || 0), 0);
        const budgetShare = Math.max(0, budget - originalTotal) / targets.length;
        for (const { step: original, index: i } of targets) {
            const currentStep = current.steps[i];
            const beforeId = String(currentStep?.product?.id || '');
            const result = await modifyRoutineSingle(current, {
                action: 'swap',
                step_number: i + 1,
                cheaper: !!args.cheaper,
                max_budget: budget,
                price_cap: original.product.price + budgetShare,
                preferred_brand: args.preferred_brand,
            }, ctx);
            if ('error' in result) {
                skipped.push(`${original.stepName}: ${result.error}`);
                continue;
            }
            const after = result.steps[i];
            if (String(after?.product?.id || '') === beforeId) {
                skipped.push(`${original.stepName}: لم يتغير المنتج`);
                continue;
            }
            current = result;
            changes.push({
                stepNumber: i + 1,
                category: original.category,
                before: original.product,
                after: after.product,
            });
        }
        if (changes.length === 0) {
            return { error: skipped.length ? `لم أجد بديلاً مختلفاً مناسباً لأي خطوة. ${skipped[0]}` : 'لم أتمكن من تغيير منتجات الروتين.' };
        }
        const final = recompute(current, current.steps, budget) as any;
        final.modification = {
            action: 'replace_all',
            changedCount: changes.length,
            requestedCount: targets.length,
            changes,
            skipped,
            preservedByRequest: excluded,
            summary: skipped.length
                ? `غيّرت ${changes.length} من أصل ${targets.length} منتجات مطلوبة. تعذّر تغيير ${skipped.length} خطوة؛ أبقيتها كما هي بدلاً من اختيار منتج غير مناسب.${excluded.length ? ` وأبقيت الفئات المستثناة دون تغيير: ${excluded.join('، ')}.` : ''}`
                : `تم استبدال ${changes.length} منتجات مع الحفاظ على أنواع الخطوات والميزانية.${excluded.length ? ` وأبقيت الفئات المستثناة دون تغيير: ${excluded.join('، ')}.` : ''}`,
            ...(skipped.length ? {
                followupQuestion: `تعذّر إيجاد بدائل لـ ${skipped.map(x => x.split(':')[0]).join('، ')}. هل تسمح بماركات أخرى، أم تريد تغيير نوع هذه الخطوات وتحديث أسمائها وتعليمات استخدامها؟`,
                followupOptions: ['اسمح بماركات أخرى', 'غيّر نوع الخطوات المتعذرة', 'ارفع الميزانية', 'أبقِ المنتجات الحالية'],
            } : {}),
        };
        return final;
    }

    if (args.action === 'batch') {
        if (!Array.isArray(args.edits) || args.edits.length < 2) {
            return { error: 'للتعديل المتعدد، أرسل عمليتين على الأقل ضمن edits.' };
        }
        if (args.edits.length > 10) return { error: 'يمكن تنفيذ 10 تعديلات كحد أقصى في الطلب الواحد.' };
        // Validate all targets before applying any change; then perform swaps first,
        // removals from high to low step number, and adds last to preserve references.
        const edits = args.edits.map((e, index) => ({ ...e, __index: index }));
        const ordered = [...edits].sort((a, b) => {
            const rank = (x: any) => x.action === 'swap' ? 0 : x.action === 'remove' ? 1 : 2;
            const rd = rank(a) - rank(b);
            if (rd) return rd;
            if (a.action === 'remove' && b.action === 'remove') return (b.step_number || 0) - (a.step_number || 0);
            return a.__index - b.__index;
        });
        let current: any = { ...routine, steps: [...routine.steps] };
        const changes: any[] = [];
        for (const item of ordered) {
            const { __index, ...edit } = item as any;
            // Capture the targeted step before each atomic operation so the final
            // response can explain exactly which products changed, not only the count.
            const targetIndex = edit.action === 'add' ? -1 : findTargetIndex(current, edit);
            const beforeStep = targetIndex >= 0 ? current.steps[targetIndex] : undefined;
            // Removals are sorted from high to low step number to keep explicit indexes stable.
            const result = await modifyRoutineSingle(current, { ...edit, cheaper: edit.cheaper ?? args.cheaper, max_budget: budget, preferred_brand: edit.preferred_brand ?? args.preferred_brand }, ctx);
            if ('error' in result) {
                if (args.allow_partial) {
                    changes.push({ originalEditIndex: __index, action: edit.action, category: edit.category || beforeStep?.category, failed: true, reason: result.error, summary: 'لم تُطبّق هذه الخطوة؛ بقيت كما هي.' });
                    continue;
                }
                return { error: `لم أطبق التعديلات لأن العملية ${__index + 1} تعذّرت: ${result.error} لم يتغير الروتين. يمكنك السماح بالتعديلات الممكنة فقط أو تعديل القيود.` };
            }
            const atomicMod: any = result.modification || {};
            changes.push({
                originalEditIndex: __index,
                action: edit.action,
                category: edit.category || beforeStep?.category,
                step_number: edit.step_number ?? atomicMod.after?.stepNumber ?? atomicMod.before?.stepNumber,
                before: atomicMod.before?.product || (edit.action === 'swap' || edit.action === 'remove' ? beforeStep?.product : undefined),
                after: atomicMod.after?.product,
                summary: atomicMod.summary,
            });
            current = result;
        }
        const final = recompute(current, current.steps, budget) as any;
        final.modification = {
            action: 'batch',
            changedCount: changes.filter((c: any) => !c.failed).length,
            requestedCount: edits.length,
            changes,
            skipped: changes.filter((c: any) => c.failed).map((c: any) => c.reason),
            summary: changes.some((c: any) => c.failed)
                ? `نُفذت ${changes.filter((c: any) => !c.failed).length} من أصل ${edits.length} تعديلات؛ بقيت الخطوات المتعذرة كما هي.`
                : `نُفذت ${changes.length} تعديلات على الروتين في طلب واحد، مع الحفاظ على الميزانية المحددة.`,
            ...(changes.some((c: any) => c.failed) ? {
                followupQuestion: 'تعذّر تنفيذ بعض التعديلات. هل تريد السماح بماركات أخرى أو تغيير فئة الخطوات المتعذرة، أم تفضّل إبقاءها كما هي؟',
                followupOptions: ['اسمح بماركات أخرى', 'غيّر فئة الخطوات المتعذرة', 'ارفع الميزانية', 'أبقِ الخطوات كما هي'],
            } : {}),
        };
        return final;
    }

    return modifyRoutineSingle(routine, args as ModifyRoutineAtomicArgs, ctx);
}


/** Convert every recoverable edit failure into a user-facing next step. */
function toRoutineFollowUp(error: string, args: ModifyRoutineArgs): RoutineFollowUp {
    const text = String(error || 'تعذّر تنفيذ التعديل المطلوب.');
    const norm = normalizeArabicText(text);
    const brand = args.preferred_brand;
    const category = args.category || args.edits?.find(e => e.category)?.category;
    const options: string[] = [];
    let kind: RoutineFollowUp['kind'] = 'edit_failed';
    let message = text;
    let question = 'كيف تفضّل أن أتابع؟';

    if (/لا يوجد روتين|اطلب مني بناء روتين/.test(text)) {
        kind = 'missing_routine';
        message = 'لا يظهر لي روتين سابق محفوظ في هذه المحادثة، لذلك لم أغيّر أي شيء.';
        question = 'هل تريد أن أبني روتيناً جديداً أولاً، أم ترسل الروتين الذي تريد تعديله؟';
        options.push('ابنِ روتيناً جديداً', 'سأرسل الروتين الحالي');
    } else if (/لم أتمكن من تحديد الخطوة|اذكر رقم الخطوة|نوع المنتج/.test(text)) {
        kind = 'target_unclear';
        message = 'أحتاج فقط إلى تحديد الخطوة المقصودة حتى لا أغيّر منتجاً غير الذي تريده.';
        question = 'أي خطوة تريد تعديلها؟ اذكر اسمها أو رقمها أو اسم المنتج الحالي.';
        options.push('الغسول', 'السيروم', 'المرطب', 'واقي الشمس', 'أرسل رقم الخطوة');
    } else if (/ماركة|علامة تجارية|brand/.test(norm) || brand) {
        kind = 'brand_unavailable';
        const requestedCategory = category || (text.match(/(?:خطوة|فئة)\s+([^؛،.]+?)(?: ضمن| يحترم|$)/)?.[1] || 'هذه الفئة');
        message = `${brand ? `لم أجد منتجاً مناسباً من ماركة ${brand}` : 'لم أجد منتجاً مناسباً من الماركة المطلوبة'} ${requestedCategory === 'هذه الفئة' ? 'ضمن هذه الفئة' : `لفئة «${requestedCategory}»`} ضمن الشروط الحالية. لم أستبدل الماركة بصمت.`;
        question = `هل تريد تغيير الماركة لهذه الخطوة${requestedCategory !== 'هذه الفئة' ? ` (${requestedCategory})` : ''}، أم تفضّل رفع الميزانية أو تغيير نوع الخطوة؟`;
        options.push('اسمح بماركة أخرى', 'ارفع الميزانية', 'غيّر فئة الخطوة', 'أبقِ المنتج الحالي');
    } else if (/ميزاني|دج المتبقي|يتجاوز الميزانية|ارفع الميزانية|مستهلكة بالكامل|budget/.test(norm)) {
        kind = 'budget';
        message = text;
        question = 'ما الخيار الأنسب لك حتى أتابع التعديل؟';
        options.push('ارفع الميزانية', 'اختر بديلاً أرخص', 'احذف خطوة أخرى', 'أبقِ المنتج الحالي');
    } else if (/لا أستطيع إدخال|تتجنبها|حساسية|مكونات/.test(text)) {
        kind = 'constraint_conflict';
        message = `${text} سأحافظ على قائمة الحساسية والتجنّب ولن أتجاوزها.`;
        question = 'هل تريد أن أبحث عن بديل آخر يلتزم بهذه القيود، أم تختار منتجاً مختلفاً بنفسك؟';
        options.push('ابحث عن بديل ملتزم', 'سأحدد منتجاً آخر');
    } else if (/موجود بالفعل|يحتوي بالفعل على هذه الفئة|الخطوة الوحيدة/.test(text)) {
        kind = 'duplicate_step';
        message = text;
        question = 'هل تريد استبدال الخطوة الموجودة بدلاً من إضافة خطوة مكررة، أم تعديل خطوة أخرى؟';
        options.push('استبدل الخطوة الموجودة', 'اختر خطوة أخرى', 'أبقِ الروتين كما هو');
    } else if (/لم أجد|لم يتم العثور|لا يوجد منتج|بديلاً مناسباً|بديلاً أرخص|لم أتمكن من تغيير/.test(text)) {
        kind = 'product_unavailable';
        message = category
            ? `لم أجد حالياً منتجاً مناسباً لفئة «${category}» يحقق كل شروطك. لم أغيّر نوع الخطوة أو أضع منتجاً غير مناسب بدلاً منها.`
            : text;
        question = 'هل تريد أن أوسّع البحث إلى ماركات أخرى، أو أغيّر نوع هذه الخطوة إلى فئة متاحة وأحدّث اسمها وطريقة استخدامها، أو نعدّل الميزانية؟';
        options.push('وسّع البحث إلى ماركات أخرى', 'غيّر فئة الخطوة إلى بديل متاح', 'ارفع الميزانية', 'أبقِ الخطوة الحالية');
    } else if (/كل خطوات الروتين مستثناة/.test(text)) {
        kind = 'target_unclear';
        message = text;
        question = 'ما الفئات التي تسمح لي بتغييرها؟';
        options.push('غيّر كل الخطوات', 'استثنِ واقي الشمس فقط', 'سأحدد الفئات');
    } else if (/لم أطبق التعديلات|العملية .* فشلت|batch|تعديلات/.test(norm)) {
        kind = 'batch_failure';
        message = `${text} لم أعتمد أي جزء من التعديلات، والروتين ما زال كما كان.`;
        question = 'هل تريد مني تنفيذ التعديلات الممكنة فقط وترك الخطوات المتعذرة كما هي، أم نعدّل الطلب معاً؟';
        options.push('نفّذ ما يمكن واترك الباقي', 'اسمح بماركات أخرى', 'عدّل الميزانية أو القيود');
    } else {
        kind = 'edit_failed';
        message = `${text} لم أغيّر الروتين، ويمكننا تعديل الطلب بدلاً من التوقف هنا.`;
        question = 'أي تفضيل تريد تغييره لأتابع: الماركة، الميزانية، نوع الخطوة، أم المنتج المحدد؟';
        options.push('غيّر الماركة', 'عدّل الميزانية', 'غيّر نوع الخطوة', 'اختر منتجاً آخر');
    }

    return { needsFollowup: true, kind, message, question, options, recoverable: true, unchanged: true };
}

/** Public API: never leak a raw edit error as the final user-facing outcome. */
export async function modifyRoutine(
    routine: RoutineResult | null | undefined,
    args: ModifyRoutineArgs,
    ctx: ModifyContext = {}
): Promise<ModifyRoutineResult> {
    try {
        const result = await modifyRoutineInternal(routine, args, ctx);
        if (result && typeof result === 'object' && 'error' in result) {
            return toRoutineFollowUp(result.error, args);
        }
        return result;
    } catch (err: any) {
        const detail = typeof err?.message === 'string' ? err.message : 'خطأ غير متوقع أثناء تعديل الروتين.';
        console.error('[modifyRoutine] Recoverable edit failure:', detail);
        return toRoutineFollowUp(detail, args);
    }
}
