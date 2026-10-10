import { getProducts } from '../../wathiq/backendClient';
import {
    normalizeCountry,
    normalizeCategory,
    matchesMultilingualCondition,
    normalizeArabicText
} from '../taxonomy';
import { getRepresentativePrice } from '../priceUtils';
import { getProduct } from './getProduct';

export interface RequiredProductRef {
    id?: string;
    name?: string;
}

export interface BuildRoutineArgs {
    target_concern: string; // e.g. "بشرة دهنية", "حب الشباب", "تفتيح", "بشرة جافة", "شعر تالف"
    max_budget: number; // e.g. 5000, 4000, 8000 (DZD)
    routine_type?: 'skin' | 'hair';
    time_of_day?: 'full' | 'morning' | 'night';
    country?: string; // e.g. "Algeria"
    preferred_brand?: string;
    /** Products the user explicitly asked to include ("with this serum", "مع هذا المنتج"). */
    required_products?: RequiredProductRef[];
    /** Product IDs the user asked to keep OUT ("بدون منتج فينوس", "not that cleanser"). */
    excluded_product_ids?: string[];
    /** Ingredients to avoid across all steps (session allergies / "بدون كحول"). */
    avoid_ingredients?: string[];
    /** Step categories the user does NOT want ("ما نبغيش واقي شمس", "no toner"). */
    exclude_categories?: string[];
}

export interface RoutineStep {
    stepNumber: number;
    stepName: string;
    category: string;
    product: {
        id: string;
        brand: string;
        name: string;
        price: number;
        currency: string;
        image?: string;
        categoryLabel?: string;
        claims: string[];
    };
    usageTime: string;
    howToUse: string;
    whyChosen: string;
}

export interface RequiredPlacement {
    id: string;
    name: string;
    stepNumber: number;
    stepName: string;
}

export interface RequiredNotPlaced {
    id?: string;
    name?: string;
    reason: string;
}

export interface RoutineResult {
    routineId: string;
    title: string;
    concern: string;
    routineType: 'skin' | 'hair';
    maxBudget: number;
    totalCost: number;
    savings: number;
    stepsCount: number;
    steps: RoutineStep[];
    usageTips: string[];
    /** Steps dropped because the user said they don't want them. */
    skippedByRequest?: string[];
    /** Which user-required products were placed, and where. */
    includedRequired: RequiredPlacement[];
    /** Which user-required products could NOT be placed, and why. */
    requiredNotPlaced: RequiredNotPlaced[];
}

interface StepDef {
    name: string;
    categories: string[];
    usageTime: string;
    howToUse: string;
    whyPrefix: string;
}

/** Ingredients a step product must not contain (lowercased INCI substrings). */
function violatesAvoidList(product: any, avoidNorm: string[]): boolean {
    if (avoidNorm.length === 0) return false;
    const ing = product.ingredients;
    if (!ing) return false; // unknown composition — allowed unless we know it violates
    const ingText = normalizeArabicText(Array.isArray(ing) ? ing.join(' ') : String(ing));
    return avoidNorm.some(tok => ingText.includes(tok));
}

export async function buildRoutine(args: BuildRoutineArgs): Promise<RoutineResult | { error: string; requiredNotPlaced?: RequiredNotPlaced[] }> {
    const products = await getProducts();
    const routineType = args.routine_type || (args.target_concern.includes('شعر') ? 'hair' : 'skin');
    const maxBudget = args.max_budget && args.max_budget > 0 ? args.max_budget : 5000;
    const targetCountry = normalizeCountry(args.country);
    const targetConcern = args.target_concern || 'العناية الأساسية';
    const preferredBrandNorm = args.preferred_brand ? normalizeArabicText(args.preferred_brand) : undefined;
    const avoidNorm = (args.avoid_ingredients || []).map(a => normalizeArabicText(a)).filter(a => a.length >= 3);
    const excludedIds = new Set((args.excluded_product_ids || []).map(id => String(id).toLowerCase().trim()));

    // Filter valid products with positive price
    let pool = products.filter(p => {
        const pr = getRepresentativePrice(p);
        return pr > 0;
    });

    // Hard exclusions by ID
    if (excludedIds.size > 0) {
        pool = pool.filter(p => !excludedIds.has((p.id || '').toLowerCase()));
    }

    // Avoid-ingredient handling (allergies) is PER-STEP, not global: a step
    // with no safe candidate gets OMITTED from the routine (with an honest
    // note) rather than recommending a product containing the allergen —
    // and rather than the old all-or-nothing global filter that silently
    // gave up on the whole avoid list when the safe pool was small.
    const omittedForSafety: string[] = [];

    if (targetCountry) {
        const countryMatches = pool.filter(p => {
            const pNorm = normalizeCountry(p.country) || (p.country || '').trim();
            return pNorm.toLowerCase() === targetCountry.toLowerCase();
        });
        if (countryMatches.length >= 10) {
            pool = countryMatches;
        }
    }

    // ─── RESOLVE REQUIRED PRODUCTS UP FRONT ─────────────────────────────────
    // The previous version of this tool ACCEPTED required_products from the
    // agent but never read the field — "build me a routine with this serum"
    // silently produced a routine without it. Resolution happens first so the
    // budget math below accounts for their cost from the start.
    interface ResolvedRequired {
        ref: RequiredProductRef;
        raw: any;
        price: number;
        category: string; // normalized category id
    }
    const resolvedRequired: ResolvedRequired[] = [];
    const requiredNotPlaced: RequiredNotPlaced[] = [];

    for (const ref of args.required_products || []) {
        if (!ref.id && !ref.name) continue;
        try {
            const res = await getProduct({ productId: ref.id, productName: ref.name, query: ref.name });
            if (res.found && res.product) {
                // Find the raw catalog product for full fields (category etc.)
                const raw = products.find(p => (p.id || '').toLowerCase() === String(res.product!.id).toLowerCase());
                if (!raw) {
                    requiredNotPlaced.push({ ...ref, reason: 'not found in catalog' });
                    continue;
                }
                const price = getRepresentativePrice(raw);
                if (price <= 0) {
                    requiredNotPlaced.push({ ...ref, reason: 'سعره غير معروف في الكتالوج' });
                    continue;
                }
                if (excludedIds.has((raw.id || '').toLowerCase())) {
                    requiredNotPlaced.push({ ...ref, reason: 'مستبعد بناءً على طلبك' });
                    continue;
                }
                if (violatesAvoidList(raw, avoidNorm)) {
                    requiredNotPlaced.push({ ...ref, reason: 'يحتوي على مكون طلبت تجنبه' });
                    continue;
                }
                const rawCat = typeof raw.category === 'object' ? (raw.category?.id || '') : (raw.category || '');
                resolvedRequired.push({
                    ref,
                    raw,
                    price,
                    category: (normalizeCategory(rawCat) || rawCat || '').toLowerCase(),
                });
            } else {
                requiredNotPlaced.push({ ...ref, reason: 'لم يتم العثور عليه في الكتالوج' });
            }
        } catch (e: any) {
            requiredNotPlaced.push({ ...ref, reason: `lookup failed: ${e.message}` });
        }
    }

    const requiredTotal = resolvedRequired.reduce((s, r) => s + r.price, 0);
    if (requiredTotal > maxBudget) {
        return {
            error: `المنتجات التي طلبت تضمينها تكلف ${requiredTotal} دج، ما يتجاوز ميزانيتك (${maxBudget} دج). ارفع الميزانية أو أسقط أحد المنتجات المطلوبة.`,
            requiredNotPlaced: resolvedRequired.map(r => ({
                id: r.raw.id, name: r.raw.name, reason: 'over budget'
            })),
        };
    }

    // Step definitions for Skin vs Hair
    let stepCategories: StepDef[] = [];

    if (routineType === 'hair') {
        stepCategories = [
            {
                name: 'تنظيف فروة الرأس والشعر',
                categories: ['shampoo'],
                usageTime: '2 - 3 مرات أسبوعياً',
                howToUse: 'يُدلك بلطف على فروة الرأس الرطبة لتنظيفها من التراكمات ثم يُشطف جيداً.',
                whyPrefix: 'ينظف الفروة بعمق دون تجفيف ألياف الشعر.'
            },
            {
                name: 'تغذية وترميم ألياف الشعر',
                categories: ['hair_mask'],
                usageTime: 'مرة إلى مرتين أسبوعياً',
                howToUse: 'يوزع على أطراف الشعر المبللة بعد الغسل، ويُترك 5–10 دقائق ثم يُشطف.',
                whyPrefix: 'يمنح الشعر ترطيباً مكثفاً ويعيد بناء الأطراف المتضررة.'
            },
            {
                name: 'الحماية والتصفيف اليومي',
                categories: ['hair_serum', 'oil_blend', 'oil_replacement'],
                usageTime: 'يومياً أو بعد الاستحمام',
                howToUse: 'توضع قطرات خفيفة على الشعر الرطب أو الجاف مع التركيز على الأطراف.',
                whyPrefix: 'يحمي من الحرارة والتطاير ويمنح لمعاناً طبيعياً.'
            }
        ];
    } else {
        // Skin Routine
        const includeSunscreen = (args.time_of_day === 'morning' || args.time_of_day === 'full' || !args.time_of_day);
        stepCategories = [
            {
                name: 'التنظيف وإزالة الشوائب',
                categories: ['cleanser'],
                usageTime: 'صباحاً ومساءً',
                howToUse: 'يُدلك على بشرة مبللة بحركات دائرية لمدة 60 ثانية ثم يُشطف بالماء الفاتر.',
                whyPrefix: 'ينظف المسام من الدهون والشوائب بلطف ويحافظ على حاجز البشرة.'
            },
            {
                name: 'العلاج والاستهداف النشط',
                categories: ['skin_serum'],
                usageTime: 'مرة إلى مرتين يومياً',
                howToUse: 'توضع 3 إلى 4 قطرات على الوجه والرقبة وتُربت برفق حتى تمتصها البشرة.',
                whyPrefix: 'يحتوي على مواد فعالة مركزة تستهدف المشكلة الجلدية مباشرة.'
            },
            {
                name: 'الترطيب وحبس الرطوبة',
                categories: ['lotion_cream'],
                usageTime: 'صباحاً ومساءً',
                howToUse: 'توضع كمية مناسبة بحجم حبة الحمص وتُوزع بالتساوي كطبقة ترطيب وحماية.',
                whyPrefix: 'يعزز مرونة الجلد ويمنع فقدان الماء عبر طبقات البشرة.'
            }
        ];

        if (includeSunscreen && maxBudget >= 3500) {
            stepCategories.push({
                name: 'الحماية النهارية من الشمس',
                categories: ['sunscreen'],
                usageTime: 'صباحاً قبل الخروج بـ 15 دقيقة',
                howToUse: 'توضع كمية كافية (مقدار إصبعين) وتُجدد كل ساعتين عند التعرض للشمس.',
                whyPrefix: 'حماية واسعة الطيف تمنع التصبغات وتلف الكولاجين وآثار الحبوب.'
            });
        }
    }

    // ─── HONOR "I DON'T WANT X" ────────────────────────────────────────────
    // Drop whole steps the user explicitly excluded (e.g. already owns a
    // sunscreen). Required products still win over an exclusion.
    const excludedCats = (args.exclude_categories || [])
        .map(c => (normalizeCategory(c) || c || '').toLowerCase())
        .filter(Boolean);
    const skippedByRequest: string[] = [];
    if (excludedCats.length > 0) {
        stepCategories = stepCategories.filter(def => {
            const hit = def.categories.some(c => excludedCats.some(e => c === e || c.includes(e) || e.includes(c)));
            if (hit) skippedByRequest.push(def.name);
            return !hit;
        });
    }

    // ─── PLACE REQUIRED PRODUCTS INTO THEIR NATURAL STEPS ───────────────────
    const selectedSteps: RoutineStep[] = [];
    const includedRequired: RequiredPlacement[] = [];
    const usedIds = new Set<string>();
    let currentTotal = 0;

    const REQUIRED_TAG = 'منتج مطلوب من المستخدم';
    const placedRefs = new Set<ResolvedRequired>();

    const makeStepFromRaw = (raw: any, price: number, stepDef: StepDef, whySuffix: string): RoutineStep => ({
        stepNumber: selectedSteps.length + 1,
        stepName: stepDef.name,
        category: stepDef.categories[0],
        product: {
            id: raw.id,
            brand: raw.brand || 'ماركة معتمدة',
            name: raw.name || 'منتج عناية',
            price,
            currency: raw.price?.currency || 'دج',
            image: raw.image,
            categoryLabel: typeof raw.category === 'object' ? raw.category?.label : raw.category,
            claims: (raw.marketingClaims || []).slice(0, 3)
        },
        usageTime: stepDef.usageTime,
        howToUse: stepDef.howToUse,
        whyChosen: whySuffix
    });

    // Budget left for auto-selected steps after honoring required products.
    // We place required items at their matching step; anything whose category
    // matches NO step becomes an extra step appended at the end.
    const stepTakenByRequired = new Set<number>(); // indexes into stepCategories

    for (const req of resolvedRequired) {
        const stepIdx = stepCategories.findIndex((def, idx) =>
            !stepTakenByRequired.has(idx) &&
            def.categories.some(c => req.category.includes(c) || c.includes(req.category))
        );

        if (stepIdx >= 0) {
            const def = stepCategories[stepIdx];
            stepTakenByRequired.add(stepIdx);
            placedRefs.add(req);
            usedIds.add((req.raw.id || '').toLowerCase());
            currentTotal += req.price;
            selectedSteps.push(makeStepFromRaw(
                req.raw, req.price, def,
                `${REQUIRED_TAG} — ${def.whyPrefix} ملائم لـ ${targetConcern}.`
            ));
            includedRequired.push({
                id: req.raw.id, name: req.raw.name,
                stepNumber: selectedSteps.length, stepName: def.name
            });
        }
    }

    // ─── AUTO-FILL REMAINING STEPS ───────────────────────────────────────────
    for (let i = 0; i < stepCategories.length; i++) {
        if (stepTakenByRequired.has(i)) continue; // already satisfied by a required product
        const stepDef = stepCategories[i];

        // Find candidates for this category (never reuse a product twice).
        let candidates = pool.filter(p => {
            if (usedIds.has((p.id || '').toLowerCase())) return false;
            const rawCat = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
            const pCatNorm = (normalizeCategory(rawCat) || rawCat.toLowerCase()).toLowerCase();
            return stepDef.categories.some(c => pCatNorm.includes(c) || c.includes(pCatNorm));
        });

        // Allergy/avoid filter for THIS step: if no safe option exists, the
        // step is omitted entirely — we never put a product containing the
        // avoided ingredient into a routine.
        if (avoidNorm.length > 0) {
            const safeCandidates = candidates.filter(p => !violatesAvoidList(p, avoidNorm));
            if (safeCandidates.length === 0 && candidates.length > 0) {
                omittedForSafety.push(stepDef.name);
                continue;
            }
            candidates = safeCandidates;
        }

        if (candidates.length === 0) continue;

        // Score candidates based on concern match and price realism
        const remainingSteps = stepCategories.length - selectedSteps.length;
        const remainingBudget = maxBudget - currentTotal;
        const targetStepBudget = remainingBudget / Math.max(remainingSteps, 1);

        const scored = candidates.map(p => {
            let score = 0;
            const price = getRepresentativePrice(p);
            const allTags: string[] = [
                ...(p.marketingClaims || []),
                ...(p.targetTypes || [])
            ].map((t: any) => typeof t === 'string' ? t.toLowerCase() : '');

            // Concern match bonus
            if (allTags.some(t => matchesMultilingualCondition(t, targetConcern))) {
                score += 40;
            }

            // Substring search in name/ingredients/claims
            const pText = `${p.brand || ''} ${p.name || ''} ${p.ingredients || ''} ${allTags.join(' ')}`.toLowerCase();
            if (pText.includes(targetConcern.toLowerCase())) {
                score += 25;
            }

            // Budget friendliness bonus: closer to target step budget without exceeding
            if (price <= remainingBudget - (remainingSteps - 1) * 600) {
                score += 30;
                // Penalize if too far above target step budget
                const ratio = price / (targetStepBudget || 1);
                if (ratio >= 0.5 && ratio <= 1.3) score += 20;
            } else {
                score -= 100; // Too expensive for remaining steps
            }

            // Prefer local if requested
            if (targetCountry && (p.country || '').toLowerCase().includes(targetCountry.toLowerCase())) {
                score += 15;
            }

            // Preferred brand bonus (explicit user preference)
            if (preferredBrandNorm && normalizeArabicText(p.brand || '').includes(preferredBrandNorm)) {
                score += 25;
            }

            return { product: p, price, score };
        });

        scored.sort((a, b) => b.score - a.score);

        // Pick the top candidate that fits within the REMAINING budget. If
        // nothing fits, the step is SKIPPED — the old code fell back to
        // scored[0] anyway, which is how routines silently blew the budget.
        const chosen = scored.find(s => s.price > 0 && (currentTotal + s.price) <= maxBudget);

        if (chosen) {
            currentTotal += chosen.price;
            usedIds.add((chosen.product.id || '').toLowerCase());
            const whySuffix = preferredBrandNorm && normalizeArabicText(chosen.product.brand || '').includes(preferredBrandNorm)
                ? `${stepDef.whyPrefix} ملائم لـ ${targetConcern}. (من علامتك المفضلة)`
                : `${stepDef.whyPrefix} ملائم لـ ${targetConcern}.`;
            selectedSteps.push(makeStepFromRaw(chosen.product, chosen.price, stepDef, whySuffix));
        }
    }

    // ─── APPEND REQUIRED PRODUCTS THAT MATCHED NO STEP ──────────────────────
    // e.g. user demands a toner but the routine template has no toner step —
    // it becomes an extra step at the end rather than being dropped silently.
    for (const req of resolvedRequired) {
        if (placedRefs.has(req)) continue;
        if (currentTotal + req.price > maxBudget) {
            requiredNotPlaced.push({
                id: req.raw.id, name: req.raw.name,
                reason: `فئته (${req.category}) لا تناسب خطوات الروتين القياسية وإضافته تتجاوز الميزانية`
            });
            continue;
        }
        const extraDef: StepDef = {
            name: 'خطوة إضافية (منتج مطلوب)',
            categories: [req.category || 'other'],
            usageTime: 'حسب تعليمات العبوة',
            howToUse: 'يُستخدم كخطوة إضافية وفق التعليمات المدونة على العبوة.',
            whyPrefix: 'أُضيف بناءً على طلبك المباشر.'
        };
        placedRefs.add(req);
        usedIds.add((req.raw.id || '').toLowerCase());
        currentTotal += req.price;
        selectedSteps.push(makeStepFromRaw(
            req.raw, req.price, extraDef,
            `${REQUIRED_TAG} — ${extraDef.whyPrefix}`
        ));
        includedRequired.push({
            id: req.raw.id, name: req.raw.name,
            stepNumber: selectedSteps.length, stepName: extraDef.name
        });
    }

    // Any required product that never got placed (should be rare — most exit
    // through the branches above) gets an explicit reason.
    for (const req of resolvedRequired) {
        if (!placedRefs.has(req)) {
            requiredNotPlaced.push({ id: req.raw.id, name: req.raw.name, reason: 'تعذر إدراجه في الروتين' });
        }
    }

    if (selectedSteps.length === 0) {
        return { error: `لم نتمكن من تكوين روتين متكامل ضمن ميزانية ${maxBudget} دج. يرجى رفع الميزانية قليلاً أو تحديد فئة أخرى.` };
    }

    const totalCost = selectedSteps.reduce((sum, s) => sum + s.product.price, 0);
    const savings = Math.max(0, maxBudget - totalCost);

    const routineTitle = routineType === 'hair'
        ? `روتين متكامل للعناية بالشعر (${targetConcern})`
        : `روتين متكامل للعناية بالبشرة (${targetConcern})`;

    const usageTips = [
        'التزم بالترتيب الموضح أعلاه (من الأخف قواماً إلى الأثقل) لضمان أقصى امتصاص للمكونات.',
        'أدخل أي منتج جديد تدريجياً لملاحظة استجابة بشرتك براحة وأمان.',
        savings > 0 ? `تم توفير ${savings} دج من ميزانيتك المقدرة بـ ${maxBudget} دج.` : 'تم استغلال الميزانية بالكامل لأفضل توليفة من المنتجات.'
    ];
    if (skippedByRequest.length > 0) {
        usageTips.push(`تم استثناء الخطوات التالية كما طلبت: ${skippedByRequest.join('، ')}.`);
    }
    if (omittedForSafety.length > 0) {
        usageTips.push(`حُذفت الخطوات التالية لأن كل المنتجات المتاحة لها تحتوي على مكون طلبت تجنبه: ${omittedForSafety.join('، ')}.`);
    }

    return {
        routineId: `RTN-${Date.now().toString().slice(-6)}`,
        title: routineTitle,
        concern: targetConcern,
        routineType,
        maxBudget,
        totalCost,
        savings,
        stepsCount: selectedSteps.length,
        steps: selectedSteps,
        usageTips,
        includedRequired,
        requiredNotPlaced,
        ...(skippedByRequest.length > 0 ? { skippedByRequest } : {}),
    };
}
