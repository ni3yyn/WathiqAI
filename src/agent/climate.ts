/**
 * Bioclimatic awareness for Algeria.
 *
 * Detects the user's city/region from the conversation, maps it to a climate
 * zone and turns that into concise formulation guidance for the model — e.g. a
 * humectant-only hyaluronic serum in a very dry Saharan climate can leave skin
 * drier unless sealed with an occlusive/ceramide cream.
 *
 * City list covers common wilayas in Arabic, French, English and Darija
 * spellings; unknown places simply yield no climate context (nothing invented).
 */
import { foldMessage } from './intents';
import type { L10n } from './ingredientKnowledge';

export type ClimateZone = 'coastal_humid' | 'arid_saharan' | 'steppe_highland' | 'tell_temperate';
export type Season = 'summer' | 'winter' | 'mid';

interface CityRule { re: RegExp; city: string; zone: ClimateZone }

const CITIES: CityRule[] = [
    // Saharan / arid
    { re: /ورقلة|ouargla|ouargla/, city: 'Ouargla', zone: 'arid_saharan' },
    { re: /أدرار|ادرار|adrar/, city: 'Adrar', zone: 'arid_saharan' },
    { re: /بسكرة|biskra/, city: 'Biskra', zone: 'arid_saharan' },
    { re: /غرداية|ghardaia|ghardaïa/, city: 'Ghardaïa', zone: 'arid_saharan' },
    { re: /الوادي|el ?oued|oued souf/, city: 'El Oued', zone: 'arid_saharan' },
    { re: /تمنراست|tamanrasset|tamanghasset/, city: 'Tamanrasset', zone: 'arid_saharan' },
    { re: /بشار|bechar|béchar/, city: 'Béchar', zone: 'arid_saharan' },
    { re: /تندوف|tindouf/, city: 'Tindouf', zone: 'arid_saharan' },
    { re: /تقرت|touggourt/, city: 'Touggourt', zone: 'arid_saharan' },
    { re: /المنيعة|el ?menia|el ?golea/, city: 'El Menia', zone: 'arid_saharan' },
    { re: /ايليزي|إليزي|illizi/, city: 'Illizi', zone: 'arid_saharan' },
    { re: /الصحراء|sahara|saharan|saharien|الجنوب الكبير/, city: 'Sahara', zone: 'arid_saharan' },
    // Steppe / high plateaus
    { re: /سطيف|setif|sétif/, city: 'Sétif', zone: 'steppe_highland' },
    { re: /باتنة|batna/, city: 'Batna', zone: 'steppe_highland' },
    { re: /الجلفة|djelfa/, city: 'Djelfa', zone: 'steppe_highland' },
    { re: /خنشلة|khenchela/, city: 'Khenchela', zone: 'steppe_highland' },
    { re: /تبسة|tebessa|tébessa/, city: 'Tébessa', zone: 'steppe_highland' },
    { re: /ام البواقي|أم البواقي|oum el bouaghi/, city: 'Oum El Bouaghi', zone: 'steppe_highland' },
    { re: /برج بوعريريج|bordj bou arreridj|bba\b/, city: 'Bordj Bou Arréridj', zone: 'steppe_highland' },
    { re: /المسيلة|msila|m'sila/, city: "M'Sila", zone: 'steppe_highland' },
    { re: /النعامة|naama/, city: 'Naâma', zone: 'steppe_highland' },
    { re: /سعيدة|saida|saïda/, city: 'Saïda', zone: 'steppe_highland' },
    { re: /تيارت|tiaret/, city: 'Tiaret', zone: 'steppe_highland' },
    { re: /الاغواط|الأغواط|laghouat/, city: 'Laghouat', zone: 'steppe_highland' },
    { re: /الهضاب|high plateaus|hauts plateaux/, city: 'High Plateaus', zone: 'steppe_highland' },
    // Coastal / humid
    { re: /الجزائر العاصمة|العاصمة|alger\b|algiers|دزاير العاصمة/, city: 'Algiers', zone: 'coastal_humid' },
    { re: /وهران|oran/, city: 'Oran', zone: 'coastal_humid' },
    { re: /عنابة|annaba/, city: 'Annaba', zone: 'coastal_humid' },
    { re: /بجاية|bejaia|béjaïa|bgayet/, city: 'Béjaïa', zone: 'coastal_humid' },
    { re: /تيبازة|tipaza|tipasa/, city: 'Tipaza', zone: 'coastal_humid' },
    { re: /مستغانم|mostaganem/, city: 'Mostaganem', zone: 'coastal_humid' },
    { re: /سكيكدة|skikda/, city: 'Skikda', zone: 'coastal_humid' },
    { re: /جيجل|jijel/, city: 'Jijel', zone: 'coastal_humid' },
    { re: /بومرداس|boumerdes|boumerdès/, city: 'Boumerdès', zone: 'coastal_humid' },
    { re: /عين تموشنت|ain temouchent|aïn témouchent/, city: 'Aïn Témouchent', zone: 'coastal_humid' },
    { re: /الطارف|el tarf/, city: 'El Tarf', zone: 'coastal_humid' },
    { re: /الساحل|coastal|littoral|الشاطئ|البحر/, city: 'Coast', zone: 'coastal_humid' },
    // Tell / temperate interior
    { re: /قسنطينة|constantine/, city: 'Constantine', zone: 'tell_temperate' },
    { re: /البليدة|blida/, city: 'Blida', zone: 'tell_temperate' },
    { re: /تيزي وزو|tizi ouzou|tizi-ouzou/, city: 'Tizi Ouzou', zone: 'tell_temperate' },
    { re: /ميلة|mila\b/, city: 'Mila', zone: 'tell_temperate' },
    { re: /قالمة|guelma/, city: 'Guelma', zone: 'tell_temperate' },
    { re: /المدية|medea|médéa/, city: 'Médéa', zone: 'tell_temperate' },
    { re: /البويرة|bouira/, city: 'Bouira', zone: 'tell_temperate' },
    { re: /سيدي بلعباس|sidi bel abbes|sidi bel abbès/, city: 'Sidi Bel Abbès', zone: 'tell_temperate' },
    { re: /معسكر|mascara/, city: 'Mascara', zone: 'tell_temperate' },
    { re: /تلمسان|tlemcen/, city: 'Tlemcen', zone: 'tell_temperate' },
];

export interface DetectedClimate { zone: ClimateZone; city: string }

export function detectClimate(text: string): DetectedClimate | null {
    const t = foldMessage(text || '');
    if (!t) return null;
    for (const c of CITIES) if (c.re.test(t)) return { zone: c.zone, city: c.city };
    return null;
}

export function currentSeason(now: Date = new Date()): Season {
    const m = now.getMonth() + 1;      // Algeria: northern hemisphere
    if (m >= 6 && m <= 9) return 'summer';
    if (m === 12 || m <= 2) return 'winter';
    return 'mid';
}

/** User-stated season overrides the calendar ("في الصيف", "in winter"). */
export function detectSeason(text: string): Season | null {
    const t = foldMessage(text || '');
    if (/الصيف|صيفا|summer|[ée]t[ée]\b|canicule|حر\b/.test(t)) return 'summer';
    if (/الشتاء|شتاء|winter|hiver|برد\b/.test(t)) return 'winter';
    return null;
}

export const ZONE_LABEL: Record<ClimateZone, { label: L10n; humidity: string }> = {
    coastal_humid: { label: { ar: 'ساحلي رطب', fr: 'côtier humide', en: 'coastal humid' }, humidity: 'high' },
    arid_saharan: { label: { ar: 'صحراوي جاف', fr: 'saharien aride', en: 'Saharan arid' }, humidity: 'very low' },
    steppe_highland: { label: { ar: 'هضاب عليا/سهبي', fr: 'hauts plateaux/steppe', en: 'steppe / high plateaus' }, humidity: 'low (dry, cold winters)' },
    tell_temperate: { label: { ar: 'تلّي معتدل', fr: 'tellien tempéré', en: 'temperate Tell' }, humidity: 'moderate' },
};

const TIPS: Record<ClimateZone, string[]> = {
    coastal_humid: [
        'prefer gel / gel-cream textures and fluid or aqua SPF in summer',
        'avoid heavy petrolatum-style occlusives that trap sweat and can clog pores or feed fungal-prone skin',
        'humectants (hyaluronic acid, glycerin) work well here without a heavy seal',
    ],
    arid_saharan: [
        'humectants alone (hyaluronic acid, glycerin) can pull moisture out of skin into very dry air and worsen flaking — apply on DAMP skin and seal immediately with a ceramide / shea / squalane cream',
        'prefer richer moisturizers and barrier support (ceramides, panthenol); avoid harsh foaming cleansers',
        'strong sun: high-SPF, reapply; keep products away from heat (>40°C degrades actives such as vitamin C and retinol)',
    ],
    steppe_highland: [
        'dry, cold winter wind strips lipids — favour barrier-repair balms (ceramides, cholesterol, panthenol, shea) and gentle cleansers in winter',
        'high-altitude UV is strong even in cool weather — keep daily SPF',
        'go slower with exfoliating acids and retinoids in winter',
    ],
    tell_temperate: [
        'adapt textures to the season: lighter gels in summer, richer creams in winter',
        'daily SPF year-round',
    ],
};

const SUMMER_HEAT: Record<ClimateZone, string> = {
    coastal_humid: 'summer heat + humidity: store actives (vitamin C, retinol) in a cool place',
    arid_saharan: 'extreme summer heat: store products in a cool, dark place',
    steppe_highland: 'hot dry summers: store actives in a cool place',
    tell_temperate: 'hot summers: store actives in a cool place',
};

export function climateTips(zone: ClimateZone, season: Season): string[] {
    const tips = [...TIPS[zone]];
    if (season === 'summer') tips.push(SUMMER_HEAT[zone]);
    return tips;
}

/** The [Context: …] line handed to the model; null when the climate is unknown. */
export function buildClimateContext(profile: { city?: string; climateZone?: ClimateZone }, season: Season): string | null {
    if (!profile.climateZone) return null;
    const z = ZONE_LABEL[profile.climateZone];
    const tips = climateTips(profile.climateZone, season);
    return `[Context: Climate=${z.label.en} (${profile.city || 'region'}) | Humidity=${z.humidity} | Season=${season}. Apply when recommending hydration, sunscreen, cleansers, occlusives or strong actives: ${tips.join(' ; ')}. Never invent product concentrations.]`;
}
