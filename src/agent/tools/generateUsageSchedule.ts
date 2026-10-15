/**
 * generate_usage_schedule — a Week 1 → Week 4+ induction calendar for potent
 * actives (retinoids, AHA/BHA, benzoyl peroxide, azelaic acid, vitamin C), so
 * users don't start daily, burn their barrier and quit.
 *
 * Deterministic: frequency ramps depend on the active, the stated/estimated
 * concentration and how sensitive the user is. General guidance only — not a
 * medical prescription.
 */
import { resolveConcept, getConcept, L10n, pick, PREGNANCY_NOTE, POTENT_KEYS } from '../ingredientKnowledge';
import type { TLang } from '../voice';
type Lang = TLang;

export type Sensitivity = 'beginner' | 'normal' | 'experienced';

export interface GenerateUsageScheduleArgs {
    /** The active, free text: "Retinol 0.5%", "ريتينول", "glycolic acid 7%". */
    active: string;
    /** % strength if known (0.5 for 0.5% retinol). Parsed from `active` when omitted. */
    concentration?: number;
    sensitivity?: Sensitivity;
    /** From the session profile (حساسة / sensitive skin) — forces the gentle ramp. */
    skin_sensitive?: boolean;
}

interface WeekPlan { from: number; to: number; perWeek: number | 'alternate' | 'daily'; note?: L10n }

const DAYS: Record<Lang, string[]> = {
    dz: ['التنين', 'التلات', 'لاربع', 'الخميس', 'الجمعة', 'السبت', 'لحد'],
    ar: ['الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'],
    fr: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'],
    en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
};
// weekday indexes (Mon=0) for N nights per week, spread evenly
const SPREAD: Record<number, number[]> = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4] };

function parseConcentration(text: string): number | undefined {
    const m = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
    return m ? parseFloat(m[1].replace(',', '.')) : undefined;
}

function ramp(key: string, strength: number | undefined, sens: Sensitivity): WeekPlan[] {
    const strong = (key === 'retinoid' && (strength ?? 0.5) >= 0.5) || (key === 'aha' && (strength ?? 7) >= 7) || (key === 'bha' && (strength ?? 2) >= 2);
    switch (key) {
        case 'retinoid':
            if (sens === 'beginner' || strong && sens === 'normal') return [{ from: 1, to: 2, perWeek: 1 }, { from: 3, to: 3, perWeek: 2 }, { from: 4, to: 7, perWeek: 3 }, { from: 8, to: 8, perWeek: 'alternate' }];
            if (sens === 'normal') return [{ from: 1, to: 2, perWeek: 2 }, { from: 3, to: 4, perWeek: 3 }, { from: 5, to: 8, perWeek: 'alternate' }];
            return [{ from: 1, to: 1, perWeek: 3 }, { from: 2, to: 3, perWeek: 4 }, { from: 4, to: 8, perWeek: 'alternate' }];
        case 'aha':
            if (sens === 'beginner' || strong && sens === 'normal') return [{ from: 1, to: 2, perWeek: 1 }, { from: 3, to: 4, perWeek: 2 }, { from: 5, to: 8, perWeek: 3 }];
            return [{ from: 1, to: 2, perWeek: 2 }, { from: 3, to: 4, perWeek: 3 }, { from: 5, to: 8, perWeek: 3 }];
        case 'bha':
            if (sens === 'beginner') return [{ from: 1, to: 2, perWeek: 2 }, { from: 3, to: 4, perWeek: 3 }, { from: 5, to: 8, perWeek: 'alternate' }];
            return [{ from: 1, to: 1, perWeek: 3 }, { from: 2, to: 3, perWeek: 4 }, { from: 4, to: 8, perWeek: 'alternate' }];
        case 'benzoyl':
            return [{ from: 1, to: 2, perWeek: 3, note: { ar: 'طبقة رقيقة على مناطق الحبوب فقط.', fr: 'Fine couche sur les boutons uniquement.', en: 'Thin layer on blemish areas only.' } }, { from: 3, to: 4, perWeek: 'alternate' }, { from: 5, to: 8, perWeek: 'daily' }];
        case 'azelaic':
            return [{ from: 1, to: 2, perWeek: 'alternate' }, { from: 3, to: 8, perWeek: 'daily' }];
        case 'vitc':
            return [{ from: 1, to: 1, perWeek: 'alternate' }, { from: 2, to: 8, perWeek: 'daily' }];
        default:
            return [];
    }
}

const HEADS: Record<string, { time: 'PM' | 'AM'; method: 'sandwich' | 'direct' }> = {
    retinoid: { time: 'PM', method: 'sandwich' },
    aha: { time: 'PM', method: 'sandwich' },
    bha: { time: 'PM', method: 'direct' },
    benzoyl: { time: 'PM', method: 'direct' },
    azelaic: { time: 'PM', method: 'direct' },
    vitc: { time: 'AM', method: 'direct' },
};

export function generateUsageSchedule(args: GenerateUsageScheduleArgs) {
    const concept = resolveConcept(args.active || '');
    if (!concept || !POTENT_KEYS.includes(concept.key)) {
        return { error: 'لا أحتاج لجدول تدرّج لهذا المكوّن، أو لم أتعرف عليه. اذكر المادة الفعّالة (ريتينول، حمض الجليكوليك، ساليسيليك، بنزويل بيروكسايد، أزيليك، فيتامين سي).' };
    }
    const key = concept.key;
    const strength = args.concentration ?? parseConcentration(args.active);
    const sens: Sensitivity = args.skin_sensitive ? 'beginner' : (args.sensitivity || 'beginner');
    const plan = ramp(key, strength, sens);
    const head = HEADS[key];
    const method: 'sandwich' | 'direct' = (sens === 'beginner' || args.skin_sensitive) && head.method === 'sandwich' ? 'sandwich' : (key === 'retinoid' || key === 'aha') && sens !== 'experienced' ? 'sandwich' : 'direct';

    const weeks = plan.map(p => {
        const n = typeof p.perWeek === 'number' ? p.perWeek : undefined;
        const frequency: L10n = n !== undefined
            ? { ar: `${n === 1 ? 'مرة واحدة' : n === 2 ? 'مرتان' : `${n} مرات`} في الأسبوع`, fr: `${n}×/semaine`, en: `${n}× per week`, dz: `${n === 1 ? 'مرة وحدة' : n === 2 ? 'جوج مرات' : `${n} مرات`} في السيمانة` }
            : p.perWeek === 'alternate'
                ? { ar: 'ليلة بعد ليلة (يوم بعد يوم)', fr: 'un jour sur deux', en: 'every other day', dz: 'ليلة إيه وليلة لا' }
                : { ar: 'يومياً', fr: 'tous les jours', en: 'daily', dz: 'كل يوم' };
        return {
            weeks: p.from === p.to ? `${p.from}` : `${p.from}–${p.to}`,
            from: p.from, to: p.to,
            perWeek: p.perWeek,
            frequency,
            exampleDays: n ? SPREAD[n]?.map(i => i) : undefined,
            note: p.note,
        };
    });

    const rules: L10n[] = [];
    rules.push(head.time === 'PM'
        ? { ar: 'يُستعمل مساءً فقط على بشرة نظيفة وجافة تماماً.', fr: 'Le soir uniquement, sur peau propre et bien sèche.', en: 'Evenings only, on clean, fully dry skin.' }
        : { ar: 'يُستعمل صباحاً على بشرة نظيفة، متبوعاً بواقي الشمس.', fr: 'Le matin sur peau propre, suivi d\'un écran solaire.', en: 'Mornings on clean skin, followed by sunscreen.' });
    if (method === 'sandwich') rules.push({ ar: 'طريقة الساندويتش: طبقة مرطب خفيفة ← كمية بحجم حبة البازلاء ← طبقة مرطب ثانية.', fr: 'Méthode sandwich : fine couche d\'hydratant → quantité d\'un petit pois → hydratant.', en: 'Sandwich method: thin moisturizer → pea-sized amount → moisturizer.' });
    rules.push({ ar: 'تجنب محيط العينين وجوانب الأنف والفم.', fr: 'Évitez le contour des yeux, les ailes du nez et la bouche.', en: 'Avoid the eye area, nose corners and mouth.' });
    if (key !== 'vitc') rules.push({ ar: 'أوقف أي مقشرات أو أحماض أخرى أثناء فترة التدرج.', fr: 'Pas d\'autres exfoliants/acides pendant la montée en puissance.', en: 'No other exfoliants or acids during the ramp-up.' });
    if (['retinoid', 'aha', 'bha'].includes(key)) rules.push({ ar: 'واقي الشمس كل صباح بلا استثناء.', fr: 'Écran solaire chaque matin, sans exception.', en: 'Sunscreen every morning, no exceptions.' });
    rules.push({ ar: 'لا تزِد التكرار إذا ظهر احمرار أو حرقان؛ ابقَ على نفس المرحلة أسبوعاً إضافياً.', fr: 'N\'augmentez pas la fréquence en cas de rougeur/picotement ; restez une semaine de plus à l\'étape actuelle.', en: 'Do not step up if you get redness or stinging; stay on the current step one more week.' });

    const stopSigns: L10n = {
        ar: 'توقف فوراً واستشر طبيباً إذا ظهر حرق شديد أو تورم أو تقشر واسع أو احمرار مستمر أكثر من 48 ساعة.',
        fr: 'Arrêtez et consultez si brûlure intense, gonflement, desquamation importante ou rougeur >48 h.',
        en: 'Stop and see a doctor for severe burning, swelling, heavy peeling or redness lasting over 48 hours.',
    };

    return {
        active: concept.label.ar,
        activeKey: key,
        concentration: strength ?? null,
        sensitivity: sens,
        applyTime: head.time,
        method,
        weeks,
        rules,
        stopSigns,
        pregnancyNote: key === 'retinoid' ? PREGNANCY_NOTE : undefined,
        disclaimer: 'إرشاد عام وليس وصفة طبية؛ عدّل حسب استجابة بشرتك.',
        dayNames: DAYS,
    };
}

export function dayNamesFor(lang: Lang, idxs: number[] | undefined): string {
    if (!idxs || idxs.length === 0) return '';
    return idxs.map(i => DAYS[lang][i]).join(lang === 'ar' ? '، ' : ', ');
}

export { pick };
