/**
 * build_gift_set — a safe-by-default gift: gentle, fragrance-free, no potent
 * actives (no retinoid/acids/benzoyl peroxide), 2–4 pieces within a budget.
 * Reuses the routine builder so budgets, allergies and exclusions behave
 * exactly like everywhere else.
 */
import { buildRoutine } from './buildRoutine';

export interface BuildGiftSetArgs {
    budget: number;
    recipient?: string;               // "mother", "friend", "ماما"… (display only)
    skin_type?: string;               // default: normal skin (safest)
    avoid?: string[];
    country?: string;
}

const GENTLE_AVOID = ['retinol', 'glycolic', 'salicylic', 'benzoyl peroxide', 'parfum'];

export async function buildGiftSet(args: BuildGiftSetArgs) {
    if (!args.budget || args.budget < 500) {
        return { error: 'حدّد ميزانية الهدية بالدينار (مثلاً 3000 دج).' };
    }
    const routine: any = await buildRoutine({
        target_concern: args.skin_type || 'بشرة عادية',
        max_budget: args.budget,
        country: args.country,
        avoid_ingredients: Array.from(new Set([...GENTLE_AVOID, ...(args.avoid || [])])),
    } as any);
    if (!routine || routine.error) return { error: routine?.error || 'تعذّر تكوين مجموعة هدية ضمن هذه الميزانية.' };

    return {
        ...routine,
        title: 'مجموعة هدية لطيفة',
        isGift: true,
        recipient: args.recipient || null,
        giftNotes: [
            'اخترتها لطيفة وخالية من العطور والمكونات القوية (ريتينول، أحماض، بنزويل بيروكسايد) لتناسب معظم البشرات.',
            'إذا كنت تعرف أن لدى صاحب الهدية حساسية معيّنة فأخبرني لأستبعدها.',
        ],
    };
}
