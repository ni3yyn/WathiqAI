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

export type RoutineAction = 'swap' | 'remove' | 'add' | 'refit';

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
    /** New budget in DZD (refit / swap / add). Defaults to the routine's budget. */
    max_budget?: number;
}

export interface ModifyContext {
    avoid_ingredients?: string[];
    country?: string;
}

export type ModifyRoutineResult =
    | (RoutineResult & { modification: { action: RoutineAction; summary: string; before?: any; after?: any; stillOverBudget?: boolean } })
    | { error: string };

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
    extraExcludeIds: string[] = []
): Promise<{ raw: any; price: number } | null> {
    if (cap <= 0) return null;
    const hair = routine.routineType === 'hair';
    const res: any = await searchProducts({
        category,
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
        const price = getRepresentativePrice(raw);
        if (price > 0 && price <= cap) return { raw, price };
    }
    return null;
}

async function resolveNamed(ref: { id?: string; name?: string }) {
    const r = await getProduct({ productId: ref.id, productName: ref.name, query: ref.name });
    if (!r.found || !r.product) return null;
    const catalog = await getProducts();
    const raw = catalog.find((p: any) => p.id === r.product!.id);
    if (!raw) return null;
    const price = getRepresentativePrice(raw);
    return price > 0 ? { raw, price } : null;
}

export async function modifyRoutine(
    routine: RoutineResult | null | undefined,
    args: ModifyRoutineArgs,
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
        const othersTotal = routine.steps.reduce((s, st, i) => s + (i === idx ? 0 : st.product.price), 0);
        let cap = budget - othersTotal;
        if (args.cheaper) cap = Math.min(cap, target.product.price - 1);

        let chosen: { raw: any; price: number } | null = null;
        if (args.replacement && (args.replacement.id || args.replacement.name)) {
            chosen = await resolveNamed(args.replacement);
            if (!chosen) return { error: 'لم أجد المنتج الذي طلبت وضعه بدلاً منه في الكتالوج.' };
            if (routine.steps.some((s, i) => i !== idx && s.product.id === chosen!.raw.id)) {
                return { error: 'هذا المنتج موجود بالفعل في الروتين.' };
            }
            if (chosen.price > budget - othersTotal) {
                return { error: `سعر هذا المنتج (${chosen.price} دج) يتجاوز الميزانية المتبقية لهذه الخطوة (${Math.max(0, budget - othersTotal)} دج).` };
            }
        } else {
            chosen = await pickProduct(routine, target.category, cap, ctx, [target.product.id]);
            if (!chosen) {
                return { error: args.cheaper
                    ? 'لم أجد بديلاً أرخص لهذه الخطوة يحترم تفضيلاتك وما تتجنبه.'
                    : 'لم أجد بديلاً مناسباً لهذه الخطوة ضمن الميزانية وما تتجنبه.' };
            }
        }

        const newStep: RoutineStep = {
            ...target,
            product: buildStepProduct(chosen.raw, chosen.price),
            whyChosen: `${target.whyChosen.split('—').pop()?.trim() || ''} (بديل اخترته لك بدل ${target.product.brand} ${target.product.name})`.trim(),
        };
        const steps = routine.steps.map((s, i) => (i === idx ? newStep : s));
        const out = recompute(routine, steps, budget);
        return {
            ...out,
            modification: {
                action: 'swap',
                summary: `استُبدلت الخطوة ${target.stepNumber} (${target.stepName}).`,
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

        const chosen = await pickProduct(routine, cat, remaining, ctx);
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
