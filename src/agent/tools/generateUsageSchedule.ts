// path: src/agent/tools/generateUsageSchedule.ts
/**
 * generate_usage_schedule — Dermatological onboarding schedules (Retinization)
 * 
 * Prevents users from destroying their skin barrier when starting potent
 * actives like Retinol or Glycolic acid by generating a 4-week acclimation
 * protocol, including the "sandwich method".
 */

export interface GenerateUsageScheduleArgs {
    active: string;
    sensitivity?: 'beginner' | 'experienced' | 'sensitive';
}

export async function generateUsageSchedule(args: GenerateUsageScheduleArgs) {
    const active = args.active.toLowerCase();
    const sens = args.sensitivity || 'beginner';
    
    let protocol = '';
    let warnings = '';
    
    if (active.includes('retinol') || active.includes('retin') || active.includes('tretinoin')) {
        protocol = sens === 'sensitive' 
            ? "الأسبوع 1 و 2: ليلة واحدة أسبوعياً.\nالأسبوع 3 و 4: ليلتان أسبوعياً."
            : "الأسبوع 1: ليلة واحدة.\nالأسبوع 2: ليلتان.\nالأسبوع 3 فما بعد: 3 ليالٍ أسبوعياً.";
        warnings = "تطبيق طريقة الساندويتش (مرطب ← ريتينول ← مرطب). تجنب محيط العينين وزوايا الأنف. لا تستخدم مقشرات (AHA/BHA) في نفس الليلة.";
    } else if (active.includes('glycolic') || active.includes('aha') || active.includes('bha') || active.includes('salicylic')) {
        protocol = "الأسبوع 1 و 2: مرتين أسبوعياً (مساءً).\nالأسبوع 3 فما بعد: 2-3 مرات أسبوعياً حسب استجابة البشرة.";
        warnings = "لا يوضع على بشرة رطبة. يجب استخدام واقي شمس صباحاً.";
    } else {
        protocol = "الأسبوع 1: مرتين أسبوعياً.\nالأسبوع 2: يوم بيوم.\nالأسبوع 3: الاستخدام اليومي إذا لم يحدث تهيج.";
        warnings = "راقب استجابة بشرتك، وتوقف عند ظهور احمرار شديد أو حكة.";
    }
    
    return {
        active: args.active,
        sensitivity: sens,
        schedule: protocol,
        technique: warnings,
        note: "هذا الجدول إرشادي للتعويد التدريجي وتجنب تلف حاجز البشرة (Acclimation)."
    };
}