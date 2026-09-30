/**
 * Wathiq Intelligence — Multilingual Semantic Taxonomy & Normalizers
 * Maps Arabic, Algerian Darija, French, and English terms to Wathiq catalog entities.
 */

import fs from 'fs';
import path from 'path';


// Safely loads dynamically learned words patched by the autonomous worker
function loadLearnedAliases(canonicalKey: string): string[] {
    try {
        const filePath = path.join(__dirname, 'learned_taxonomy.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return data[canonicalKey] || [];
        }
    } catch (e) {}
    return [];
}

// ─── 1. COUNTRIES ─────────────────────────────────────────────────────────────
const COUNTRY_MAP: { [key: string]: string } = {
    // Algeria
    'algeria': 'Algeria',
    'algérie': 'Algeria',
    'algerie': 'Algeria',
    'dz': 'Algeria',
    'الجزائر': 'Algeria',
    'دزاير': 'Algeria',
    'جزائري': 'Algeria',
    'جزائرية': 'Algeria',
    'algerian': 'Algeria',
    'algérien': 'Algeria',
    'algérienne': 'Algeria',

    // Korea
    'korea': 'Korea',
    'south korea': 'Korea',
    'corée': 'Korea',
    'coree': 'Korea',
    'coréen': 'Korea',
    'coréenne': 'Korea',
    'korean': 'Korea',
    'كوريا': 'Korea',
    'كوري': 'Korea',
    'كورية': 'Korea',

    // France
    'france': 'France',
    'french': 'France',
    'français': 'France',
    'française': 'France',
    'فرنسا': 'France',
    'فرنسي': 'France',
    'فرنسية': 'France',

    // USA
    'usa': 'USA',
    'us': 'USA',
    'united states': 'USA',
    'amérique': 'USA',
    'états-unis': 'USA',
    'etats-unis': 'USA',
    'أمريكا': 'USA',
    'الولايات المتحدة': 'USA',
    'أمريكي': 'USA',

    // Turkey
    'turkey': 'Turkey',
    'turquie': 'Turkey',
    'turkish': 'Turkey',
    'turc': 'Turkey',
    'تركيا': 'Turkey',
    'تركي': 'Turkey',

    // Other
    'germany': 'Germany',
    'allemagne': 'Germany',
    'ألمانيا': 'Germany',
    'italy': 'Italy',
    'italie': 'Italy',
    'إيطاليا': 'Italy',
    'tunisia': 'Tunisia',
    'tunisie': 'Tunisia',
    'تونس': 'Tunisia',
    'egypt': 'Egypt',
    'égypte': 'Egypt',
    'مصر': 'Egypt',
    'uk': 'UK',
    'united kingdom': 'UK',
    'royaume-uni': 'UK',
    'بريطانيا': 'UK',
};

export function normalizeCountry(raw?: string): string | undefined {
    if (!raw) return undefined;
    const clean = raw.trim().toLowerCase();
    return COUNTRY_MAP[clean] || (raw.charAt(0).toUpperCase() + raw.slice(1));
}

// ─── 2. CATEGORIES ────────────────────────────────────────────────────────────
// Valid catalog categories:
// cleanser, lotion_cream, shampoo, body_wash, skin_serum, scrub, sunscreen,
// other, oil_replacement, mask, face_mask, conditioner, eye_cream, hair_mask,
// toner, hair_serum, oil_blend

const CATEGORY_MAP: { [key: string]: string } = {
    // Cleansers
    'cleanser': 'cleanser',
    'face wash': 'cleanser',
    'facial wash': 'cleanser',
    'face cleanser': 'cleanser',
    'gel nettoyant': 'cleanser',
    'mousse nettoyante': 'cleanser',
    'nettoyant': 'cleanser',
    'غسول': 'cleanser',
    'غسول وجه': 'cleanser',
    'صابون وجه': 'cleanser',
    'منظف': 'cleanser',
    'منظف وجه': 'cleanser',

    // Skin Serums
    'skin_serum': 'skin_serum',
    'serum': 'skin_serum',
    'sérum': 'skin_serum',
    'skin serum': 'skin_serum',
    'facial serum': 'skin_serum',
    'sérum visage': 'skin_serum',
    'سيروم': 'skin_serum',
    'سيروم وجه': 'skin_serum',
    'سيروم للبشرة': 'skin_serum',
    'essence': 'skin_serum',
    'ampoule': 'skin_serum',

    // Hair Serums
    'hair_serum': 'hair_serum',
    'hair serum': 'hair_serum',
    'sérum cheveux': 'hair_serum',
    'سيروم شعر': 'hair_serum',
    'سيروم للشعر': 'hair_serum',

    // Lotions & Creams (Moisturizers)
    'lotion_cream': 'lotion_cream',
    'moisturizer': 'lotion_cream',
    'cream': 'lotion_cream',
    'crème': 'lotion_cream',
    'lotion': 'lotion_cream',
    'crème hydratante': 'lotion_cream',
    'hydratant': 'lotion_cream',
    'day cream': 'lotion_cream',
    'night cream': 'lotion_cream',
    'مرطب': 'lotion_cream',
    'كريم': 'lotion_cream',
    'كريم مرطب': 'lotion_cream',
    'مرطب للبشرة': 'lotion_cream',

    // Sunscreens
    'sunscreen': 'sunscreen',
    'sun screen': 'sunscreen',
    'spf': 'sunscreen',
    'sunblock': 'sunscreen',
    'solaire': 'sunscreen',
    'écran solaire': 'sunscreen',
    'ecran solaire': 'sunscreen',
    'crème solaire': 'sunscreen',
    'واقي': 'sunscreen',
    'واقي شمس': 'sunscreen',
    'واقي الشمس': 'sunscreen',
    'حماية من الشمس': 'sunscreen',

    // Shampoos
    'shampoo': 'shampoo',
    'shampoing': 'shampoo',
    'champoo': 'shampoo',
    'شامبو': 'shampoo',
    'شمبوان': 'shampoo',

    // Conditioners
    'conditioner': 'conditioner',
    'après-shampoing': 'conditioner',
    'apres shampoing': 'conditioner',
    'بلسم': 'conditioner',
    'مرطب شعر': 'conditioner',

    // Hair Masks
    'hair_mask': 'hair_mask',
    'hair mask': 'hair_mask',
    'masque cheveux': 'hair_mask',
    'قناع شعر': 'hair_mask',
    'قناع للشعر': 'hair_mask',
    'ماسك شعر': 'hair_mask',

    // Face Masks
    'face_mask': 'face_mask',
    'mask': 'mask',
    'sheet mask': 'face_mask',
    'clay mask': 'face_mask',
    'masque visage': 'face_mask',
    'قناع وجه': 'mask',
    'ماسك وجه': 'mask',
    'قناع': 'mask',

    // Toners
    'toner': 'toner',
    'tonique': 'toner',
    'lotion tonique': 'toner',
    'mist': 'toner',
    'brume': 'toner',
    'تونر': 'toner',
    'ميست': 'toner',

    // Scrubs & Exfoliators
    'scrub': 'scrub',
    'gommage': 'scrub',
    'exfoliator': 'scrub',
    'peeling': 'scrub',
    'مقشر': 'scrub',
    'سكراب': 'scrub',

    // Eye Creams
    'eye_cream': 'eye_cream',
    'eye cream': 'eye_cream',
    'contour des yeux': 'eye_cream',
    'كريم عين': 'eye_cream',
    'كريم للعين': 'eye_cream',
    'محيط العين': 'eye_cream',

    // Body Wash
    'body_wash': 'body_wash',
    'body wash': 'body_wash',
    'shower gel': 'body_wash',
    'gel douche': 'body_wash',
    'غسول جسم': 'body_wash',
    'غسول للجسم': 'body_wash',
    'صابون استحمام': 'body_wash',

    // Oils & Oil Replacement
    'oil_blend': 'oil_blend',
    'face oil': 'oil_blend',
    'hair oil': 'oil_blend',
    'huile': 'oil_blend',
    'زيت': 'oil_blend',
    'زيت شعر': 'oil_blend',
    'زيت للبشرة': 'oil_blend',
    'oil_replacement': 'oil_replacement',
    'بديل الزيت': 'oil_replacement',
    'بديل زيت': 'oil_replacement',
};

export function normalizeCategory(raw?: string): string | undefined {
    if (!raw) return undefined;
    const clean = raw.trim().toLowerCase();
    return CATEGORY_MAP[clean] || clean;
}

// ─── 3. SKIN & HAIR TYPES (CANONICAL ARABIC DATABASE TARGET TYPES) ─────────────
export const WATHIQ_CATALOG_TARGET_TYPES: string[] = [
    // أنواع البشرة
    'بشرة دهنية',
    'بشرة جافة',
    'بشرة مختلطة',
    'بشرة حساسة',
    'بشرة عادية',
    'بشرة معرضة للحبوب',
    'كل أنواع البشرة',
    // أنواع الشعر وفروة الرأس
    'شعر دهني',
    'شعر جاف',
    'شعر عادي',
    'شعر مجعد',
    'شعر تالف',
    'شعر متضرر',
    'شعر مصبوغ',
    'فروة حساسة'
];

export interface TargetMapping {
    canonical: string;
    catalogTags: string[];
    aliases: string[];
}

export const TARGET_TYPE_MAPPINGS: TargetMapping[] = [
    {
        canonical: 'oily_skin',
        catalogTags: ['بشرة دهنية', 'للبشرة الدهنية', 'مخصص للبشرة الدهنية', 'توازن الزيوت والدهون'],
        aliases: ['oily', 'oily skin', 'grasse', 'peau grasse', 'دهنية', 'بشرة دهنية', 'دهن', 'تطلق الزيت', 'تزييت', 'مدهنة']
    },
    {
        canonical: 'dry_skin',
        catalogTags: ['بشرة جافة', 'للبشرة الجافة', 'مرطب للبشرة'],
        aliases: ['dry', 'dry skin', 'sèche', 'seche', 'peau sèche', 'peau seche', 'جافة', 'بشرة جافة', 'شايحة', 'ناشفة', 'جفاف']
    },
    {
        canonical: 'combination_skin',
        catalogTags: ['بشرة مختلطة', 'كل أنواع البشرة'],
        aliases: ['combination', 'combo', 'combination skin', 'mixte', 'peau mixte', 'مختلطة', 'بشرة مختلطة', 'عادية لمختلطة']
    },
    {
        canonical: 'sensitive_skin',
        catalogTags: ['بشرة حساسة', 'للبشرة الحساسة'],
        aliases: ['sensitive', 'sensitive skin', 'sensible', 'peau sensible', 'حساسة', 'بشرة حساسة', 'التهاب', 'حمراء']
    },
    {
        canonical: 'acne_prone',
        catalogTags: ['بشرة معرضة للحبوب', 'مضاد لحب الشباب', 'مضاد للرؤوس السوداء'],
        aliases: ['acne', 'acne prone', 'acne-prone', 'blemish', 'breakouts', 'boutons', 'acné', 'acneique', 'acnéique', 'حب الشباب', 'حبوب', 'معرضة للحبوب', 'بثور', 'لي بوطون', 'لحبوب']
    },
    {
        canonical: 'normal_skin',
        catalogTags: ['بشرة عادية', 'كل أنواع البشرة'],
        aliases: ['normal', 'normal skin', 'normale', 'peau normale', 'عادية', 'بشرة عادية']
    },
    {
        canonical: 'all_skin_types',
        catalogTags: ['كل أنواع البشرة'],
        aliases: ['all skin types', 'all types', 'tous types de peau', 'كل أنواع البشرة', 'جميع أنواع البشرة']
    },
    {
        canonical: 'oily_hair',
        catalogTags: ['شعر دهني', 'oily_hair', 'مخصص للشعر الدهني'],
        aliases: ['oily hair', 'cheveux gras', 'شعر دهني', 'فروة دهنية']
    },
    {
        canonical: 'dry_hair',
        catalogTags: ['شعر جاف', 'dry_hair', 'مخصص للشعر الجاف'],
        aliases: ['dry hair', 'cheveux secs', 'شعر جاف', 'شعر ناشف']
    },
    {
        canonical: 'normal_hair',
        catalogTags: ['شعر عادي'],
        aliases: ['normal hair', 'cheveux normaux', 'شعر عادي', 'عادي']
    },
    {
        canonical: 'damaged_hair',
        catalogTags: ['شعر متضرر', 'شعر تالف', 'إصلاح الشعر المتضرر'],
        aliases: ['damaged hair', 'damaged', 'abîmé', 'cheveux abîmés', 'cheveux cassants', 'تالف', 'متضرر', 'متقصف', 'شعر متضرر', 'شعر تالف']
    },
    {
        canonical: 'curly_hair',
        catalogTags: ['شعر مجعد', 'مكافحة التجعد'],
        aliases: ['curly', 'curly hair', 'bouclé', 'cheveux bouclés', 'frisé', 'مجعد', 'شعر مجعد', 'كيرلي']
    },
    {
        canonical: 'colored_hair',
        catalogTags: ['شعر مصبوغ', 'colored_hair', 'حماية اللون'],
        aliases: ['colored hair', 'color treated', 'cheveux colorés', 'مصبوغ', 'شعر مصبوغ', 'صبغة']
    },
    {
        canonical: 'sensitive_scalp',
        catalogTags: ['فروة حساسة', 'تنقية الفروة', 'تنقية فروة الرأس'],
        aliases: ['sensitive scalp', 'cuir chevelu sensible', 'فروة حساسة', 'حكة فروة', 'حساسية فروة الرأس']
    }
];

export function normalizeTargetType(input?: string): string | undefined {
    if (!input) return undefined;
    const clean = input.trim().toLowerCase();

    // Direct match against catalog target types
    const direct = WATHIQ_CATALOG_TARGET_TYPES.find(t => t.toLowerCase() === clean);
    if (direct) return direct;

    // Check alias mappings
    for (const mapping of TARGET_TYPE_MAPPINGS) {
        if (mapping.aliases.some(a => clean.includes(a.toLowerCase()) || a.toLowerCase().includes(clean))) {
            return mapping.catalogTags[0];
        }
    }

    return undefined;
}

// ─── 4. MARKETING CLAIMS (CANONICAL ARABIC DATABASE LIST) ─────────────────────
export const WATHIQ_CATALOG_CLAIMS: string[] = [
    'تنظيف لطيف',
    'تنظيف عميق',
    'تنقية فروة الرأس',
    'مضاد للقشرة',
    'مخصص للشعر الدهني',
    'مخصص للشعر الجاف',
    'مضاد لتساقط الشعر',
    'تعزيز النمو',
    'تكثيف الشعر',
    'مرطب للشعر',
    'تغذية الشعر',
    'إصلاح الشعر المتضرر',
    'تلميع ولمعان',
    'تنعيم الشعر',
    'مكافحة التجعد',
    'حماية اللون',
    'حماية من الحرارة',
    'مهدئ',
    'مضاد للالتهابات',
    'فك التشابك',
    'ترطيب مكثف',
    'تقوية الشعر',
    'ترطيب للشعر',
    'مرطب للبشرة',
    'مكافحة التجاعيد',
    'شد البشرة',
    'تحفيز الكولاجين',
    'مضاد للأكسدة',
    'تفتيح البشرة',
    'توحيد لون البشرة',
    'تفتيح البقع الداكنة',
    'تفتيح تحت العين',
    'للبشرة الجافة',
    'للبشرة الحساسة',
    'للبشرة الدهنية',
    'تنقية المسام',
    'توازن الزيوت',
    'مضاد لحب الشباب',
    'مضاد للرؤوس السوداء',
    'تقشير لطيف',
    'إزالة السيلوليت',
    'شد الجسم',
    'حماية من الشمس',
    'حماية واسعة الطيف',
    'مقاوم للماء',
    'إزالة المكياج',
    'توازن الحموضة',
    'تقشير',
    'تهدئة البشرة',
    'قابض للمسام',
    'تنقية عميقة'
];

export interface ClaimMapping {
    canonical: string;
    catalogClaims: string[];
    aliases: string[];
}

export const CLAIM_MAPPINGS: ClaimMapping[] = [
    // Brightening & Dark Spots
    {
        canonical: 'brightening',
        catalogClaims: ['تفتيح البشرة', 'تفتيح البقع الداكنة', 'توحيد لون البشرة', 'تفتيح تحت العين'],
        aliases: [
            'brightening', 'whitening', 'lightening', 'dark spots', 'hyperpigmentation', 'glow', 'radiance',
            'anti-taches', 'éclaircissant', 'taches brunes', 'unifiant', 'éclat',
            'تفتيح', 'تفتيح البشرة', 'بقع', 'البقع الداكنة', 'تبييض', 'توحيد اللون', 'نضارة', 'إشراق', 'كلف', 'تصبغات',
            ...loadLearnedAliases('brightening')
        ]
    },
    // Anti-Acne & Blemish & Pores
    {
        canonical: 'anti_acne',
        catalogClaims: ['مضاد لحب الشباب', 'مضاد للرؤوس السوداء', 'تنقية المسام', 'قابض للمسام', 'توازن الزيوت', 'للبشرة الدهنية'],
        aliases: [
            'anti-acne', 'acne', 'blackheads', 'pores', 'blemishes', 'breakouts', 'sebum', 'oil control',
            'anti-acné', 'points noirs', 'pores dilatés', 'imperfections', 'sébum',
            'حب الشباب', 'حبوب', 'رؤوس سوداء', 'مسام', 'تنقية المسام', 'مضاد للحبوب', 'توازن الزيوت', 'دهون', 'بشرة دهنية',
            ...loadLearnedAliases('anti_acne')
        ]
    },
    // Anti-Aging & Wrinkles & Collagen
    {
        canonical: 'anti_aging',
        catalogClaims: ['مكافحة التجاعيد', 'شد البشرة', 'تحفيز الكولاجين', 'مضاد للأكسدة'],
        aliases: [
            'anti-aging', 'anti-wrinkle', 'firming', 'collagen', 'wrinkles', 'fine lines', 'antioxidant',
            'anti-âge', 'anti-rides', 'raffermissant', 'collagène', 'rides', 'antioxydant',
            'تجاعيد', 'شد البشرة', 'شيخوخة', 'كولاجين', 'مكافحة التجاعيد', 'خطوط رفيقة', 'مضاد للأكسدة',
            // DYNAMIC LEARNING MERGE HERE:
            ...loadLearnedAliases('anti_aging')
        ]
    },
    // Hydration & Skin Barrier
    {
        canonical: 'hydration',
        catalogClaims: ['مرطب للبشرة', 'ترطيب مكثف', 'للبشرة الجافة', 'للبشرة الحساسة'],
        aliases: [
            'hydrating', 'hydration', 'moisturizing', 'dry skin', 'sensitive skin',
            'hydratant', 'hydratation', 'peau sèche', 'peau sensible',
            'ترطيب', 'ترطيب عميق', 'مرطب', 'جافة', 'حساسة', 'مرطب للبشرة', 'ترطيب مكثف',
            ...loadLearnedAliases('hydration')
        ]
    },
    // Soothing & Anti-Inflammatory
    {
        canonical: 'soothing',
        catalogClaims: ['مهدئ', 'تهدئة البشرة', 'مضاد للالتهابات'],
        aliases: [
            'soothing', 'calming', 'anti-inflammatory', 'redness',
            'apaisant', 'anti-rougeurs', 'calmant',
            'تهدئة', 'مهدئ', 'التهاب', 'احمرار', 'حساسية', 'تهدئة البشرة', 'مضاد للالتهابات'
        ]
    },
    // Cleansing & Exfoliation & Makeup Removal
    {
        canonical: 'cleansing_exfoliating',
        catalogClaims: ['تنظيف لطيف', 'تنظيف عميق', 'تنقية عميقة', 'تقشير لطيف', 'تقشير', 'إزالة المكياج', 'توازن الحموضة'],
        aliases: [
            'cleansing', 'exfoliating', 'deep cleanse', 'gentle cleanse', 'makeup remover', 'ph balanced',
            'nettoyant doux', 'nettoyage profond', 'gommage', 'exfoliant', 'démaquillant',
            'تنظيف عميق', 'تنظيف لطيف', 'تقشير', 'مقشر لطيف', 'إزالة المكياج', 'توازن الحموضة', 'تنقية عميقة'
        ]
    },
    // Sun Protection
    {
        canonical: 'sun_protection',
        catalogClaims: ['حماية من الشمس', 'حماية واسعة الطيف', 'مقاوم للماء'],
        aliases: [
            'sun protection', 'broad spectrum', 'uv protection', 'water resistant', 'spf',
            'protection solaire', 'large spectre', 'résistant à l\'eau',
            'حماية من الشمس', 'واقي شمس', 'مقاوم للماء', 'حماية واسعة الطيف'
        ]
    },
    // Anti-Dandruff & Scalp
    {
        canonical: 'anti_dandruff',
        catalogClaims: ['مضاد للقشرة', 'تنقية فروة الرأس', 'مخصص للشعر الدهني', 'مخصص للشعر الجاف'],
        aliases: [
            'anti-dandruff', 'dandruff', 'flaking', 'scalp',
            'anti-pelliculaire', 'pellicules', 'cuir chevelu',
            'قشرة', 'مضاد للقشرة', 'فروة الرأس', 'تنقية فروة الرأس'
        ]
    },
    // Anti-Hair Loss & Growth & Density
    {
        canonical: 'hair_growth_anti_loss',
        catalogClaims: ['مضاد لتساقط الشعر', 'تعزيز النمو', 'تكثيف الشعر', 'تقوية الشعر'],
        aliases: [
            'anti-hair loss', 'hair loss', 'growth', 'density', 'strengthening',
            'anti-chute', 'chute de cheveux', 'pousse des cheveux', 'densité', 'fortifiant',
            'تساقط الشعر', 'نمو الشعر', 'تكثيف الشعر', 'تقوية الشعر', 'تساقط', 'تعزيز النمو'
        ]
    },
    // Hair Repair, Shine & Protection
    {
        canonical: 'hair_nourish_repair',
        catalogClaims: [
            'إصلاح الشعر المتضرر', 'تغذية الشعر', 'مرطب للشعر', 'ترطيب للشعر',
            'تلميع ولمعان', 'تنعيم الشعر', 'مكافحة التجعد', 'حماية اللون', 'حماية من الحرارة', 'فك التشابك'
        ],
        aliases: [
            'hair repair', 'nourishing', 'shine', 'frizz control', 'color protect', 'heat protect', 'detangle',
            'réparation cheveux', 'nourrissant', 'brillance', 'anti-frisottis', 'protection couleur', 'protection thermique', 'démêlant',
            'تغذية الشعر', 'لمعان', 'إصلاح الشعر', 'حماية اللون', 'حرارة', 'تنعيم', 'فك التشابك', 'مرطب للشعر'
        ]
    },
    // Body Care & Cellulite
    {
        canonical: 'body_care',
        catalogClaims: ['إزالة السيلوليت', 'شد الجسم'],
        aliases: [
            'cellulite', 'body firming', 'slimming', 'anti-cellulite',
            'سيلوليت', 'شد الجسم', 'إزالة السيلوليت'
        ]
    },
    // Eye Care
    {
        canonical: 'eye_care',
        catalogClaims: ['تفتيح تحت العين'],
        aliases: [
            'dark circles', 'puffy eyes', 'under eye', 'eye contour',
            'cernes', 'poches', 'contour yeux',
            'هالات سوداء', 'انتفاخات العين', 'تحت العين', 'تفتيح تحت العين'
        ]
    }
];

// ─── 5. MATCHING UTILITIES ───────────────────────────────────────────────────

/**
 * Normalizes any free-form or foreign language claim to its exact canonical Arabic catalog claim.
 */
export function normalizeClaimToCatalog(claim: string): string | undefined {
    if (!claim) return undefined;
    const clean = claim.trim().toLowerCase();

    // Direct match against catalog claims
    const direct = WATHIQ_CATALOG_CLAIMS.find(c => c.toLowerCase() === clean);
    if (direct) return direct;

    // Check alias mappings
    for (const mapping of CLAIM_MAPPINGS) {
        if (mapping.aliases.some(a => clean.includes(a.toLowerCase()) || a.toLowerCase().includes(clean))) {
            return mapping.catalogClaims[0];
        }
    }

    return undefined;
}

/**
 * Checks whether a given catalog tag matches a user condition in any language.
 */
export function matchesMultilingualCondition(catalogTag: string, userQueryOrCondition: string): boolean {
    if (!catalogTag || !userQueryOrCondition) return false;
    const tag = catalogTag.toLowerCase().trim();
    const cond = userQueryOrCondition.toLowerCase().trim();

    // Direct contains
    if (tag.includes(cond) || cond.includes(tag)) return true;

    // Check skin/hair target mappings
    for (const mapping of TARGET_TYPE_MAPPINGS) {
        const matchesCondition = mapping.aliases.some(alias => cond.includes(alias.toLowerCase()));
        if (matchesCondition) {
            const matchesTag = mapping.catalogTags.some(catTag => tag.includes(catTag.toLowerCase()) || catTag.toLowerCase().includes(tag));
            if (matchesTag) return true;
        }
    }

    // Check claim mappings
    for (const mapping of CLAIM_MAPPINGS) {
        const matchesCondition = mapping.aliases.some(alias => cond.includes(alias.toLowerCase()));
        if (matchesCondition) {
            const matchesTag = mapping.catalogClaims.some(catClaim => tag.includes(catClaim.toLowerCase()) || catClaim.toLowerCase().includes(tag));
            if (matchesTag) return true;
        }
    }

    return false;
}

/**
 * Expands a list of user claims/keywords into all associated canonical catalog claims.
 */
export function expandToCatalogClaims(inputClaims: string[]): string[] {
    const matched = new Set<string>();
    for (const claim of inputClaims) {
        const cLow = claim.toLowerCase().trim();

        // If directly in catalog, add it
        const direct = WATHIQ_CATALOG_CLAIMS.find(c => c.toLowerCase() === cLow);
        if (direct) {
            matched.add(direct);
        }

        for (const mapping of CLAIM_MAPPINGS) {
            if (mapping.aliases.some(a => cLow.includes(a.toLowerCase()) || a.toLowerCase().includes(cLow))) {
                mapping.catalogClaims.forEach(cc => matched.add(cc));
            }
        }
    }
    return Array.from(matched);
}
