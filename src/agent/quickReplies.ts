/**
 * Tap-to-answer: instead of making the user type a paragraph, hand the frontend
 * a few buttons that send a ready-made message. Deterministic — built from the
 * reply text, the session and the structured results of the turn.
 */
import { tr, TLang } from './voice';

export interface QuickReply { id: string; label: string; value: string; kind?: 'answer' | 'action' }

const qr = (id: string, label: string, value?: string, kind: 'answer' | 'action' = 'answer'): QuickReply => ({ id, label, value: value ?? label, kind });

export function suggestQuickReplies(input: {
    replyText: string;
    lang: TLang;
    pendingOfferActive?: boolean;
    hasRoutine?: boolean;
    hasSkinType?: boolean;
    sectionTypes?: string[];
}): QuickReply[] {
    const { replyText, lang } = input;
    const askedSkin = /(?:ما|وش|شنو)\s*(?:هو\s*)?نوع\s*بشرتك\s*[؟?]|what(?:'s|\s+is)\s+your\s+skin\s+type\s*[?؟]|what\s+skin\s+type\s+do\s+you\s+have\s*[?؟]|quel\s+est\s+votre\s+type\s+de\s+peau\s*[?؟]|quel\s+type\s+de\s+peau\s+avez-vous\s*[?؟]/i.test(replyText);
    const askedBudget = /(?:ما|وش|شحال|كم)\s*(?:هي\s*)?(?:هي\s*)?ميزانيتك\s*[؟?]|what(?:'s|\s+is)\s+your\s+budget\s*[?؟]|how\s+much\s+is\s+your\s+budget\s*[?؟]|quel\s+est\s+votre\s+budget\s*[?؟]/i.test(replyText);
    const askedCity = /(?:أي\s*مدينة|وين\s*تسكن|فين\s*تسكن)\s*[؟?]|which\s+city\s+do\s+you\s+live\s+in\s*[?؟]|where\s+do\s+you\s+live\s*[?؟]|quelle\s+ville\s+habitez-vous\s*[?؟]/i.test(replyText);
    const askedCategory = /(?:أي\s*نوع\s*من\s*المنتجات|شنو\s*تحب\s*تشري)\s*[؟?]|which\s+(?:type|kind)\s+of\s+product\s+do\s+you\s+want\s*[?؟]|what\s+kind\s+of\s+product\s+are\s+you\s+looking\s+for\s*[?؟]|quel\s+type\s+de\s+produit\s+cherchez-vous\s*[?؟]/i.test(replyText);

    // Only answer a direct question, and never ask again when the app profile already has this value.
    if (askedSkin && !input.hasSkinType) {
        return [
            qr('skin_oily', tr(lang, { ar: 'بشرة دهنية', fr: 'Peau grasse', en: 'Oily' }), tr(lang, { ar: 'بشرتي دهنية', fr: 'Ma peau est grasse', en: 'My skin is oily' })),
            qr('skin_dry', tr(lang, { ar: 'بشرة جافة', fr: 'Peau sèche', en: 'Dry' }), tr(lang, { ar: 'بشرتي جافة', fr: 'Ma peau est sèche', en: 'My skin is dry' })),
            qr('skin_combo', tr(lang, { ar: 'بشرة مختلطة', fr: 'Peau mixte', en: 'Combination' }), tr(lang, { ar: 'بشرتي مختلطة', fr: 'Ma peau est mixte', en: 'My skin is combination' })),
            qr('skin_sensitive', tr(lang, { ar: 'بشرة حساسة', fr: 'Peau sensible', en: 'Sensitive' }), tr(lang, { ar: 'بشرتي حساسة', fr: 'Ma peau est sensible', en: 'My skin is sensitive' })),
            qr('skin_normal', tr(lang, { ar: 'عادية', fr: 'Normale', en: 'Normal' }), tr(lang, { ar: 'بشرتي عادية', fr: 'Ma peau est normale', en: 'My skin is normal' })),
        ];
    }
    if (askedBudget) {
        return [2000, 4000, 6000, 10000].map(n => qr(`budget_${n}`, `${n} ${tr(lang, { ar: 'دج', fr: 'DA', en: 'DZD' })}`, tr(lang, { ar: `ميزانيتي ${n} دج`, fr: `Mon budget est de ${n} DA`, en: `My budget is ${n} DZD` })));
    }
    if (askedCity) {
        return [
            ['Algiers', 'الجزائر العاصمة', 'Alger'], ['Oran', 'وهران', 'Oran'], ['Constantine', 'قسنطينة', 'Constantine'],
            ['Ouargla', 'ورقلة', 'Ouargla'],
        ].map(([en, ar, fr]) => qr(`city_${en.toLowerCase()}`, tr(lang, { ar, fr, en }), tr(lang, { ar: `راني في ${ar}`, fr: `Je suis à ${fr}`, en: `I live in ${en}` })));
    }
    if (askedCategory) {
        return [
            qr('cat_cleanser', tr(lang, { ar: 'غسول', fr: 'Nettoyant', en: 'Cleanser' })),
            qr('cat_serum', tr(lang, { ar: 'سيروم', fr: 'Sérum', en: 'Serum' })),
            qr('cat_cream', tr(lang, { ar: 'مرطب', fr: 'Hydratant', en: 'Moisturizer' })),
            qr('cat_sunscreen', tr(lang, { ar: 'واقي شمس', fr: 'Écran solaire', en: 'Sunscreen' })),
        ];
    }
    if (input.pendingOfferActive) {
        return [
            qr('yes', tr(lang, { ar: 'نعم', fr: 'Oui', en: 'Yes' })),
            qr('no', tr(lang, { ar: 'لا شكراً', fr: 'Non merci', en: 'No thanks' })),
        ];
    }
    if (input.hasRoutine && (input.sectionTypes || []).includes('routine') && /[؟?]/.test(replyText)) {
        return [
            qr('shop', tr(lang, { ar: 'قائمة التسوق', fr: 'Liste de courses', en: 'Shopping list' }), tr(lang, { ar: 'اعطيني قائمة التسوق', fr: 'Donne-moi la liste de courses', en: 'Give me the shopping list' }), 'action'),
            qr('share', tr(lang, { ar: 'شارك الروتين', fr: 'Partager', en: 'Share routine' }), tr(lang, { ar: 'شارك الروتين', fr: 'Partage la routine', en: 'Share the routine' }), 'action'),
            qr('compat', tr(lang, { ar: 'فحص التوافق', fr: 'Compatibilité', en: 'Check compatibility' }), tr(lang, { ar: 'هل منتجات روتيني تتعارض؟', fr: 'Les produits de ma routine sont-ils compatibles ?', en: 'Do my routine products clash?' }), 'action'),
        ];
    }
    return [];
}
