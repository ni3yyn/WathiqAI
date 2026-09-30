import { getProducts } from '../../wathiq/backendClient';
import { 
    normalizeCountry, 
    normalizeCategory, 
    matchesMultilingualCondition, 
    expandToCatalogClaims,
    normalizeTargetType 
} from '../taxonomy';
import { getRepresentativePrice } from '../priceUtils';

export interface BuildRoutineArgs {
    target_concern: string; // e.g. "بشرة دهنية", "حب الشباب", "تفتيح", "بشرة جافة", "شعر تالف"
    max_budget: number; // e.g. 5000, 4000, 8000 (DZD)
    routine_type?: 'skin' | 'hair';
    time_of_day?: 'full' | 'morning' | 'night';
    country?: string; // e.g. "Algeria"
    preferred_brand?: string;
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
}

export async function buildRoutine(args: BuildRoutineArgs): Promise<RoutineResult | { error: string }> {
    const products = await getProducts();
    const routineType = args.routine_type || (args.target_concern.includes('شعر') ? 'hair' : 'skin');
    const maxBudget = args.max_budget && args.max_budget > 0 ? args.max_budget : 5000;
    const targetCountry = normalizeCountry(args.country);
    const targetConcern = args.target_concern || 'العناية الأساسية';

    // Filter valid products with positive price
    let pool = products.filter(p => {
        const pr = getRepresentativePrice(p);
        return pr > 0;
    });

    if (targetCountry) {
        const countryMatches = pool.filter(p => {
            const pNorm = normalizeCountry(p.country) || (p.country || '').trim();
            return pNorm.toLowerCase() === targetCountry.toLowerCase();
        });
        if (countryMatches.length >= 10) {
            pool = countryMatches;
        }
    }

    // Step definitions for Skin vs Hair
    let stepCategories: Array<{
        name: string;
        categories: string[];
        usageTime: string;
        howToUse: string;
        whyPrefix: string;
    }> = [];

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
                categories: ['hair_serum', 'oil_blend'],
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

    // Score and select best product per step category
    const selectedSteps: RoutineStep[] = [];
    let currentTotal = 0;

    for (let i = 0; i < stepCategories.length; i++) {
        const stepDef = stepCategories[i];
        
        // Find candidates for this category
        const candidates = pool.filter(p => {
            const rawCat = typeof p.category === 'object' ? (p.category?.id || '') : (p.category || '');
            const pCatNorm = normalizeCategory(rawCat) || rawCat.toLowerCase();
            return stepDef.categories.some(c => pCatNorm.includes(c) || c.includes(pCatNorm));
        });

        if (candidates.length === 0) continue;

        // Score candidates based on concern match and price realism
        const remainingSteps = stepCategories.length - selectedSteps.length;
        const remainingBudget = maxBudget - currentTotal;
        const targetStepBudget = remainingBudget / remainingSteps;

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

            return { product: p, price, score };
        });

        scored.sort((a, b) => b.score - a.score);

        // Pick the top candidate that fits within realistic budget constraints
        const chosen = scored.find(s => s.price > 0 && (currentTotal + s.price) <= maxBudget) || scored[0];
        
        if (chosen) {
            currentTotal += chosen.price;
            const p = chosen.product;
            selectedSteps.push({
                stepNumber: selectedSteps.length + 1,
                stepName: stepDef.name,
                category: stepDef.categories[0],
                product: {
                    id: p.id,
                    brand: p.brand || 'ماركة معتمدة',
                    name: p.name || 'منتج عناية',
                    price: chosen.price,
                    currency: p.price?.currency || 'دج',
                    image: p.image,
                    categoryLabel: typeof p.category === 'object' ? p.category?.label : p.category,
                    claims: (p.marketingClaims || []).slice(0, 3)
                },
                usageTime: stepDef.usageTime,
                howToUse: stepDef.howToUse,
                whyChosen: `${stepDef.whyPrefix} ملائم لـ ${targetConcern}.`
            });
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
        usageTips: [
            'التزم بالترتيب الموضح أعلاه (من الأخف قواماً إلى الأثقل) لضمان أقصى امتصاص للمكونات.',
            'أدخل أي منتج جديد تدريجياً لملاحظة استجابة بشرتك براحة وأمان.',
            savings > 0 ? `تم توفير ${savings} دج من ميزانيتك المقدرة بـ ${maxBudget} دج.` : 'تم استغلال الميزانية بالكامل لأفضل توليفة من المنتجات.'
        ]
    };
}