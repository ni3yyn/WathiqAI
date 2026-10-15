/**
 * filter_by_inci_rules — mature, production-grade INCI rule engine
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHAT THIS TOOL DOES
 * ──────────────────────────────────────────────────────────────────────────────
 * Applies hard binary filters on product INCI lists — every rule must pass,
 * no soft scoring. Designed for precision business use cases:
 *
 *   • "All Algerian serums that are fragrance-free, non-comedogenic, and have
 *     niacinamide in the first 5 ingredients"
 *   • "Cleaners with no SLS/SLES, no soap, and no drying alcohols for
 *     sensitive skin"
 *   • "Sunscreens with only mineral UV filters (no chemical UV), no PEG,
 *     safe in pregnancy"
 *   • "Show me the compliance score and active profile of every oily-skin
 *     serum from Algeria"
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * INPUT PARAMETERS
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * skin_profile (preset bundles — auto-expand to exclude_groups)
 *   "oily"        → exclude: occlusive, comedogenic, heavy_emollient, drying_alcohol
 *   "acne_prone"  → exclude: occlusive, comedogenic, heavy_emollient, fragrance, essential_oil, sensitizer
 *   "sensitive"   → exclude: fragrance, essential_oil, sensitizer, sulfate, soap, drying_alcohol
 *   "dry"         → exclude: sulfate, soap, drying_alcohol
 *   "mature"      → exclude: fragrance, sulfate, soap, drying_alcohol, sensitizer
 *   "clean_beauty"→ exclude: fragrance, paraben, sulfate, formaldehyde_releaser, peg, microplastic
 *   "reef_safe"   → exclude: chemical_uv (reef-toxic filters), microplastic
 *   "pregnancy_safe" → exclude: retinoid group (checked separately via pregnancy_safe_only flag)
 *
 * exclude_groups (20 named groups — see INGREDIENT_GROUPS below)
 * must_not_have  (raw INCI tokens / free-of phrases with alias resolution)
 * must_have      (actives that MUST appear, optionally within first N positions)
 * country, category, skin_type, hair_type, required_claims
 * pregnancy_safe_only (boolean — excludes products with retinoids)
 * price_min / price_max (number in catalog currency)
 * sort_by: "compliance" | "price_asc" | "price_desc" | "active_concentration"
 * offset (number — for pagination)
 * limit (number — max results, default 10)
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * OUTPUT PER PRODUCT
 * ──────────────────────────────────────────────────────────────────────────────
 * complianceScore       0–100 (% of 20 key groups that are ABSENT)
 * skinProfileScore      0–100 (suitability for the requested skin_profile)
 * suitabilityBadges     ["✓ Fragrance-free", "⚠ Contains essential oils", …]
 * activeProfile         [{conceptKey, label, foundAt[], firstPosition}]  sorted
 * detectedGroups        [{group, label, riskLevel, detectedIngredients[]}]
 * formulationClass      "water-based" | "oil-based" | "emulsion" | "gel" | "unknown"
 * phContextNotes        ["Vitamin C is pH-sensitive; optimal below 3.5", …]
 * pregnancyFlags        ["Contains retinol — avoid during pregnancy"] or []
 * warnings              readable risk strings for medium/high groups present
 */

import { getProducts } from '../../wathiq/backendClient';
import {
    normalizeArabicText,
    normalizeCountry,
    normalizeCategory,
    matchesMultilingualCondition,
    expandToCatalogClaims,
} from '../taxonomy';
import { resolvePriceBounds, formatPriceDisplay } from '../priceUtils';
import { getSearchEntry } from './searchIndex';
import { CONCEPTS } from '../ingredientKnowledge';

// ═════════════════════════════════════════════════════════════════════════════
// § 1  INGREDIENT GROUP LIBRARY  (20 groups)
// ═════════════════════════════════════════════════════════════════════════════

export interface IngredientGroup {
    key: string;
    label: string;
    labelAr: string;
    labelFr: string;
    aliases: string[];
    test: (inci: string) => boolean;
    riskLevel: 'high' | 'medium' | 'low' | 'info';
    explanation: string;
    /** Optional: link to a regulatory/scientific reference */
    reference?: string;
}

const r = (re: RegExp) => (s: string) => re.test(s);
const FATTY_ALCOHOL_RE = /(cetyl|stearyl|cetearyl|behenyl|arachidyl|myristyl|isostearyl|lanolin|coconut)\s*alcohol/i;

export const INGREDIENT_GROUPS: IngredientGroup[] = [

    // ── Skin-barrier occlusives ────────────────────────────────────────────────
    {
        key: 'occlusive',
        label: 'Occlusive ingredients',
        labelAr: 'مكونات انسدادية (مسدّة للمسام)',
        labelFr: 'Ingrédients occlusifs',
        aliases: ['occlusive', 'occlusive-free', 'non-occlusive', 'non occlusive', 'بدون مسدات', 'sans occlusif'],
        riskLevel: 'medium',
        explanation: 'Occlusives seal moisture via a physical barrier. On oily or congested skin they can trap sebum, worsen blackheads, and increase breakouts.',
        reference: 'Draelos ZD. Cosmeceuticals. 2nd ed. Elsevier, 2009.',
        test: r(/petrolatum|mineral oil|paraffinum liquidum|ceresin|ozokerite|microcrystalline wax|lanolin(?! alcohol)|beeswax|cera alba|carnauba|candelilla wax|hydrogenated polyisobutene|polyethylene\b|vaseline|white petrolatum|paraffin(?! acid)/i),
    },

    // ── High-comedogenicity oils / esters ─────────────────────────────────────
    {
        key: 'comedogenic',
        label: 'Potentially comedogenic ingredients',
        labelAr: 'مكونات قد تسد المسام',
        labelFr: 'Ingrédients potentiellement comédogènes',
        aliases: ['comedogenic', 'comedogenic-free', 'non-comedogenic', 'non comedogenic', 'بدون مسدات مسام', 'non comedogenique'],
        riskLevel: 'high',
        explanation: 'Comedogenic rating ≥ 3/5. Strongly linked to clogged pores and acne. Coconut oil rates 4/5; isopropyl myristate 5/5.',
        reference: 'Kligman AM, Mills OH. Acta Derm Venereol. 1972.',
        test: r(/cocos nucifera(?! (fruit|water|shell))|isopropyl myristate|isopropyl palmitate|isopropyl isostearate|butyl stearate|oleyl alcohol|myristyl myristate|decyl oleate|wheat germ oil|triticum vulgare germ oil|soybean oil|glycine soja oil|linseed oil|linum usitatissimum oil|flaxseed oil/i),
    },

    // ── Heavy emollients (too rich for oily skin) ─────────────────────────────
    {
        key: 'heavy_emollient',
        label: 'Heavy emollients',
        labelAr: 'مرطبات ثقيلة (غير مناسبة للبشرة الدهنية)',
        labelFr: 'Émollients lourds',
        aliases: ['heavy-emollient', 'heavy emollient', 'heavy-emollient-free', 'بدون زيوت ثقيلة', 'leger', 'light formula', 'oil-free texture'],
        riskLevel: 'medium',
        explanation: 'Rich plant butters and heavy fixed oils leave a greasy residue and increase trans-pore occlusion, particularly problematic for type-IV oily skin.',
        test: r(/butyrospermum parkii|shea butter|mangifera indica seed butter|mango butter|theobroma cacao|cocoa butter|avocado oil|persea gratissima(?! leaf)|castor oil|ricinus communis|olive oil|olea europaea(?! (leaf|bark|fruit))|palm oil|elaeis guineensis/i),
    },

    // ── Drying / astringent alcohols ──────────────────────────────────────────
    {
        key: 'drying_alcohol',
        label: 'Drying alcohols',
        labelAr: 'كحولات مجففة',
        labelFr: 'Alcools desséchants',
        aliases: ['drying-alcohol', 'drying alcohol free', 'alcohol-free', 'sans alcool', 'بدون كحول مجفف', 'no alcohol'],
        riskLevel: 'medium',
        explanation: 'C1–C3 and denatured alcohols dissolve lipid components of the stratum corneum, raising TEWL, reducing barrier competence, and triggering rebound sebum production.',
        reference: 'Fluhr JW et al. Br J Dermatol. 2004.',
        test: (s: string) =>
            !FATTY_ALCOHOL_RE.test(s) &&
            /\balcohol\b|ethanol\b|alcohol denat|isopropyl alcohol|sd alcohol|denatured alcohol|alcohol sd/i.test(s),
    },

    // ── Synthetic fragrance & parfum ──────────────────────────────────────────
    {
        key: 'fragrance',
        label: 'Synthetic fragrance / parfum',
        labelAr: 'عطر صناعي / بارفان',
        labelFr: 'Parfum synthétique',
        aliases: ['fragrance', 'fragrance-free', 'parfum-free', 'sans parfum', 'unscented', 'بدون عطر', 'خالي من العطر', 'non parfume', 'non-fragranced'],
        riskLevel: 'high',
        explanation: 'Ranked #1 allergen in dermatology patch-test series. "Parfum/Fragrance" on INCI can conceal up to 3,000 individual chemicals. EU Cosmetics Regulation restricts 82 fragrance allergens.',
        reference: 'SCCS/1540/14. Scientific Committee on Consumer Safety, EU.',
        test: r(/\bparfum\b|fragrance(?! acid)|aroma\b/i),
    },

    // ── EU 26 fragrance allergens ─────────────────────────────────────────────
    {
        key: 'sensitizer',
        label: 'Fragrance allergens (EU 26 / SCCS list)',
        labelAr: 'مسببات الحساسية العطرية (القائمة الأوروبية)',
        labelFr: 'Allergènes de parfum réglementés (UE)',
        aliases: ['sensitizer', 'sensitizer-free', 'allergen-free', 'hypoallergenic', 'بدون مسببات حساسية عطرية', 'zero allergen'],
        riskLevel: 'medium',
        explanation: 'EU-listed fragrance allergens must be declared individually above 0.001% (rinse-off) / 0.01% (leave-on). Cause IgE-mediated and T-cell-mediated contact reactions.',
        reference: 'EU Regulation 1223/2009 Annex III, as amended 2023.',
        test: r(/limonene|linalool|citral|eugenol|geraniol|citronellol|coumarin|farnesol|benzyl (alcohol|salicylate|benzoate)|isoeugenol|amyl cinnam(al|yl)|cinnamyl|anise alcohol|hydroxycitronellal|methyl 2-octynoate|alpha-isomethyl ionone|evernia|lilial|lyral|methyl eugenol/i),
    },

    // ── Natural essential oils ─────────────────────────────────────────────────
    {
        key: 'essential_oil',
        label: 'Essential oils',
        labelAr: 'زيوت عطرية طبيعية',
        labelFr: 'Huiles essentielles',
        aliases: ['essential-oil', 'essential oil free', 'بدون زيوت عطرية', 'sans huile essentielle', 'eo-free'],
        riskLevel: 'medium',
        explanation: 'Natural EOs are complex terpene mixtures. Citrus EOs are potently phototoxic; many (peppermint, tea tree) trigger contact sensitization in atopic individuals.',
        test: r(/\bessential oil\b|lavandula (angustifolia|officinalis)|mentha (piperita|spicata|arvensis)|eucalyptus (globulus|radiata)|melaleuca alternifolia|rosmarinus officinalis|thymus vulgaris|citrus (aurantium|limon|sinensis|paradisi|bergamia)|pelargonium graveolens|cananga odorata|ylang-ylang|peppermint oil|spearmint oil|origanum (vulgare|compactum)|lemongrass/i),
    },

    // ── Sulfates ──────────────────────────────────────────────────────────────
    {
        key: 'sulfate',
        label: 'Sulfate surfactants (SLS/SLES)',
        labelAr: 'السلفات (SLS/SLES)',
        labelFr: 'Tensioactifs sulfatés (SLS/SLES)',
        aliases: ['sulfate', 'sulfate-free', 'sls-free', 'sles-free', 'sans sulfate', 'بدون سلفات', 'sls free'],
        riskLevel: 'medium',
        explanation: 'Anionic surfactants with a critical micelle concentration that strips the acid mantle (pH 4.5–5.5), impairs barrier lipid synthesis, and disrupts the skin microbiome.',
        reference: 'Loden M et al. Contact Dermatitis. 1996.',
        test: r(/sodium (lauryl|laureth|coco(-peg)?|myreth) sulf|ammonium lauryl sulf|tea-lauryl sulf|sulphate|triethanolamine lauryl sulfate/i),
    },

    // ── Parabens ──────────────────────────────────────────────────────────────
    {
        key: 'paraben',
        label: 'Parabens',
        labelAr: 'البارابين',
        labelFr: 'Parabènes',
        aliases: ['paraben', 'paraben-free', 'sans parabene', 'بدون بارابين', 'no parabens'],
        riskLevel: 'medium',
        explanation: 'Xenoestrogens with demonstrated estrogen receptor agonism. Propyl- and butylparaben are restricted in EU rinse-off products for children < 3. Breast tissue bioaccumulation documented.',
        reference: 'Darbre PD. J Appl Toxicol. 2004; EU Reg 358/2014.',
        test: r(/methylparaben|ethylparaben|propylparaben|butylparaben|isobutylparaben|isopropylparaben|benzylparaben|heptylparaben/i),
    },

    // ── Silicones ─────────────────────────────────────────────────────────────
    {
        key: 'silicone',
        label: 'Silicones',
        labelAr: 'السيليكون',
        labelFr: 'Silicones',
        aliases: ['silicone', 'silicone-free', 'sans silicone', 'بدون سيليكون', 'no silicones'],
        riskLevel: 'low',
        explanation: 'Film-forming organosilicon polymers. Not harmful but environmentally persistent (D4/D5 cyclic siloxanes are SVHC under REACH). Create occlusive film on hair that causes build-up.',
        reference: 'European Chemicals Agency, SVHC candidate list 2018.',
        test: r(/dimethicone|cyclopentasiloxane|cyclomethicone|trimethylsiloxysilicate|methicone|phenyl trimethicone|siloxane|amodimethicone|bis-peg.*silicone|divinyldimethicone|caprylyl methicone/i),
    },

    // ── PEG compounds ─────────────────────────────────────────────────────────
    {
        key: 'peg',
        label: 'PEG / polyethylene glycol compounds',
        labelAr: 'مركبات PEG / البولي إيثيلين غليكول',
        labelFr: 'Composés PEG',
        aliases: ['peg', 'peg-free', 'ether-free', 'بدون PEG', 'no peg', 'ethoxylate-free'],
        riskLevel: 'low',
        explanation: 'Ethoxylated emulsifiers may contain residual 1,4-dioxane (IARC Group 2B carcinogen) and ethylene oxide depending on purification quality. A precautionary avoidance for "clean beauty" formulations.',
        reference: 'FDA Advisory. 1,4-Dioxane in Cosmetic Products. 2022.',
        test: r(/\bpeg-\d|polyethylene glycol|polysorbate \d|steareth-\d|ceteth-\d|laureth-\d|oleth-\d|trideceth|beheneth|peg-\d+ castor|ceteareth-\d/i),
    },

    // ── Formaldehyde releasers ────────────────────────────────────────────────
    {
        key: 'formaldehyde_releaser',
        label: 'Formaldehyde-releasing preservatives',
        labelAr: 'مطلقات الفورمالديهايد',
        labelFr: 'Libérateurs de formaldéhyde',
        aliases: ['formaldehyde', 'formaldehyde-free', 'بدون فورمالديهايد', 'dmdm free', 'no formaldehyde'],
        riskLevel: 'high',
        explanation: 'Release formaldehyde in-use as a bacteriostatic mechanism. Formaldehyde is IARC Group 1 carcinogen and a common sensitizer. EU restricts maximum 0.001% free formaldehyde (0.2% for nail hardeners).',
        reference: 'IARC Monograph 100F; EU Cosm. Reg. Annex V No. 14.',
        test: r(/dmdm hydantoin|imidazolidinyl urea|diazolidinyl urea|quaternium-15|sodium hydroxymethylglycinate|bronopol|2-bromo-2-nitropropane|benzylhemiformal|methenamine|5-bromo-5-nitro-1,3-dioxane/i),
    },

    // ── Soap / high-pH cleansers ──────────────────────────────────────────────
    {
        key: 'soap',
        label: 'Soap / high-pH surfactants',
        labelAr: 'الصابون / منظفات عالية الحموضة',
        labelFr: 'Savon / nettoyants à pH élevé',
        aliases: ['soap', 'soap-free', 'sans savon', 'بدون صابون', 'ph-balanced', 'syndet'],
        riskLevel: 'medium',
        explanation: 'Saponified soap has pH 9–10+, far above the skin\'s optimal acid mantle (pH 4.5–5.5). Alkaline cleansing elevates skin pH for hours, activating serine proteases that degrade barrier proteins.',
        reference: 'Schmid-Wendtner MH, Korting HC. Skin Pharmacol Physiol. 2006.',
        test: r(/sodium (palmate|stearate|cocoate|tallowate|olivate|hydroxide(?!\s*methyl))|potassium (palmate|stearate|cocoate|hydroxide(?!\s*methyl))|saponified|sodium castorate|sodium sunflowerate/i),
    },

    // ── Chemical UV filters ───────────────────────────────────────────────────
    {
        key: 'chemical_uv',
        label: 'Organic (chemical) UV filters',
        labelAr: 'فلاتر الشمس الكيميائية العضوية',
        labelFr: 'Filtres UV chimiques',
        aliases: ['chemical-uv', 'chemical uv', 'chemical sunscreen', 'بدون فلاتر كيميائية', 'organic uv filter', 'non-chemical spf'],
        riskLevel: 'low',
        explanation: 'Absorb UV photons via organic chromophores. Oxybenzone (benzophenone-3) detected in blood and breast milk; octinoxate and oxybenzone banned by Hawaii for reef toxicity.',
        reference: 'Matta MK et al. JAMA. 2019; Hawaii HB 2571.',
        test: r(/avobenzone|octocrylene|octinoxate|ethylhexyl methoxycinnamate|homosalate|oxybenzone|benzophenone-\d|ensulizole|mexoryl sx|tinosorb (s|m)|uvinul (a plus|t 150)|diethylamino hydroxybenzoyl hexyl benzoate|bis-ethylhexyloxyphenol methoxyphenyl triazine|camphor benzalkonium methosulfate/i),
    },

    // ── Microplastics & synthetic polymers ───────────────────────────────────
    {
        key: 'microplastic',
        label: 'Microplastics / synthetic solid polymers',
        labelAr: 'البلاستيك الدقيق / البوليمرات الاصطناعية الصلبة',
        labelFr: 'Microplastiques / polymères synthétiques solides',
        aliases: ['microplastic', 'microplastic-free', 'plastic-free', 'بدون بلاستيك دقيق', 'no microbeads', 'biodegradable exfoliant'],
        riskLevel: 'high',
        explanation: 'EU REACH restriction (effective Oct 2023) bans intentionally added microplastics in cosmetics. Marine persistence, ingestion by marine life, bioaccumulation in food chains.',
        reference: 'ECHA. REACH restriction on microplastics. 2023.',
        test: r(/polyethylene(?! glycol)|polypropylene|nylon-\d+|polymethyl methacrylate|pmma|acrylates copolymer(?! water)|polyurethane|polystyrene|polyquaternium-(?!7|10|11|22|47|55)/i),
    },

    // ── Endocrine disruptors (suspected) ─────────────────────────────────────
    {
        key: 'endocrine_disruptor',
        label: 'Suspected endocrine-disrupting chemicals (EDCs)',
        labelAr: 'مواد كيميائية مشتبه بها في تعطيل الجهاز الهرموني',
        labelFr: 'Perturbateurs endocriniens suspectés',
        aliases: ['endocrine-disruptor', 'endocrine disruptor free', 'edc-free', 'hormone-safe', 'بدون ناخر هرموني'],
        riskLevel: 'high',
        explanation: 'Substances with evidence for estrogenic, androgenic, or thyroid-disrupting activity. Includes butylparaben, benzophenone-3, triclosan, and certain phthalates. Subject to EU EDC criteria (Reg 2017/2100).',
        reference: 'EU Reg 2017/2100; WHO/UNEP. EDC Report 2013.',
        test: r(/butylparaben|isobutylparaben|benzophenone-3|oxybenzone|triclosan|triclocarban|resorcinol|bisphenol|phthal|diethylhexyl phthalate|dibutyl phthalate|bha\b(?! acid)|butylhydroxyanisole/i),
    },

    // ── Artificial colorants / synthetic dyes ────────────────────────────────
    {
        key: 'artificial_colorant',
        label: 'Artificial colorants / synthetic dyes',
        labelAr: 'الأصباغ الاصطناعية',
        labelFr: 'Colorants artificiels',
        aliases: ['colorant', 'colorant-free', 'dye-free', 'no artificial colors', 'بدون أصباغ اصطناعية', 'sans colorant artificiel'],
        riskLevel: 'low',
        explanation: 'Azo dyes (CI 1–9999) and coal-tar dyes may be contaminated with carcinogenic aromatic amines or themselves be sensitizers. Banned azo dyes listed in EU Reg 1223/2009 Annex IV.',
        test: r(/\bci \d{4,6}\b|fd&c|d&c (red|yellow|blue|green|orange|violet)|tartrazine|erythrosine|brilliant blue|sunset yellow|ponceau|amaranth dye|malachite green|basic (red|blue|yellow|violet) \d/i),
    },

    // ── Propylene glycol (high-dose irritant) ─────────────────────────────────
    {
        key: 'propylene_glycol',
        label: 'Propylene glycol',
        labelAr: 'البروبيلين غليكول',
        labelFr: 'Propylène glycol',
        aliases: ['propylene glycol', 'propylene-glycol-free', 'pg-free', 'بدون بروبيلين غليكول'],
        riskLevel: 'low',
        explanation: 'Safe humectant at low concentrations (<15%) but a primary irritant and rare sensitizer at higher levels. Avoided by some sensitive skin consumers and in "clean beauty" contexts.',
        test: r(/propylene glycol(?! (alginate|acrylate|stearate|dilaurate|caprylate))|1,2-propanediol/i),
    },

    // ── Hydroquinone (prescription-level depigmenter) ─────────────────────────
    {
        key: 'hydroquinone',
        label: 'Hydroquinone',
        labelAr: 'الهيدروكينون',
        labelFr: 'Hydroquinone',
        aliases: ['hydroquinone', 'hydroquinone-free', 'بدون هيدروكينون', 'sans hydroquinone'],
        riskLevel: 'high',
        explanation: 'Potent tyrosinase inhibitor. Banned as OTC cosmetic ingredient in EU (Annex II) and many countries. Linked to ochronosis with prolonged use, especially on dark skin phototypes.',
        reference: 'EU Reg 1223/2009 Annex II No. 1339.',
        test: r(/hydroquinone|quinol\b|p-dihydroxybenzene/i),
    },

    // ── Retinoids (pregnancy contraindicated) ─────────────────────────────────
    {
        key: 'retinoid',
        label: 'Retinoids / vitamin A derivatives',
        labelAr: 'الريتينويدات / مشتقات فيتامين أ',
        labelFr: 'Rétinoïdes / dérivés de la vitamine A',
        aliases: ['retinoid', 'retinol', 'retinoid-free', 'بدون ريتينويد', 'sans retinol', 'pregnancy safe retinol free'],
        riskLevel: 'medium',
        explanation: 'Teratogenic when systemic. EU recommends caution for retinol >0.05% in face products and restricts it at higher levels. Any retinoid should be avoided during pregnancy.',
        reference: 'SCCS/1576/16; EU Reg 2023/1490.',
        test: r(/retinol|retinal\b|retinyl (palmitate|acetate|propionate)|hydroxypinacolone retinoate|granactive retinoid|retinoate|retinaldehyde|adapalene/i),
    },
];

// Build lookup structures
const GROUP_BY_KEY = new Map(INGREDIENT_GROUPS.map(g => [g.key, g]));
const GROUP_ALIAS_INDEX = INGREDIENT_GROUPS
    .flatMap(g => g.aliases.map(a => ({ alias: normalizeArabicText(a.toLowerCase()), group: g })))
    .sort((a, b) => b.alias.length - a.alias.length);

function resolveGroup(raw: string): IngredientGroup | null {
    const t = normalizeArabicText(raw.toLowerCase().trim());
    if (GROUP_BY_KEY.has(t)) return GROUP_BY_KEY.get(t)!;
    for (const { alias, group } of GROUP_ALIAS_INDEX) {
        if (t === alias || t.includes(alias) || alias.includes(t)) return group;
    }
    return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// § 2  SKIN PROFILE PRESETS
// Each preset defines a label and a set of group keys to auto-exclude.
// ═════════════════════════════════════════════════════════════════════════════

export const SKIN_PROFILES: Record<string, { label: string; excludeGroups: string[]; description: string }> = {
    oily: {
        label: 'Oily skin',
        excludeGroups: ['occlusive', 'comedogenic', 'heavy_emollient', 'drying_alcohol'],
        description: 'Excludes occlusives, comedogenic oils, heavy butters, and drying alcohols — all of which exacerbate sebum production or clog pores.',
    },
    acne_prone: {
        label: 'Acne-prone skin',
        excludeGroups: ['occlusive', 'comedogenic', 'heavy_emollient', 'fragrance', 'essential_oil', 'sensitizer'],
        description: 'Acne protocol: excludes pore-clogging agents, fragrance, and sensitizers that trigger inflammation.',
    },
    sensitive: {
        label: 'Sensitive skin',
        excludeGroups: ['fragrance', 'essential_oil', 'sensitizer', 'sulfate', 'soap', 'drying_alcohol'],
        description: 'Prioritizes barrier-compatible, low-irritant formulations: no fragrance allergens, no harsh surfactants.',
    },
    dry: {
        label: 'Dry skin',
        excludeGroups: ['sulfate', 'soap', 'drying_alcohol'],
        description: 'Avoids barrier-stripping agents that worsen dehydration. Allows rich emollients and occlusives.',
    },
    mature: {
        label: 'Mature skin',
        excludeGroups: ['fragrance', 'sulfate', 'soap', 'drying_alcohol', 'sensitizer'],
        description: 'For aged or thinned skin: anti-irritant focus. Allows rich emollients and retinoids (when tolerated).',
    },
    clean_beauty: {
        label: 'Clean beauty',
        excludeGroups: ['fragrance', 'paraben', 'sulfate', 'formaldehyde_releaser', 'peg', 'microplastic'],
        description: 'Consumer-facing "clean" standard: free of the most commonly blacklisted ingredients.',
    },
    reef_safe: {
        label: 'Reef-safe',
        excludeGroups: ['chemical_uv', 'microplastic'],
        description: 'No chemical UV filters linked to coral bleaching; no microplastics. Mineral UV filters (ZnO/TiO2) are compliant.',
    },
    pregnancy_safe: {
        label: 'Pregnancy-safe',
        excludeGroups: ['retinoid', 'hydroquinone'],
        description: 'Excludes retinoids (teratogenic) and hydroquinone (EU-banned OTC). Combine with pregnancy_safe_only:true for full enforcement.',
    },
};

const PROFILE_ALIASES: Array<[RegExp, string]> = [
    [/oily|دهني|grasse/i, 'oily'],
    [/acne|حبوب|acnee|bouton/i, 'acne_prone'],
    [/sensiti|حساس|sensible/i, 'sensitive'],
    [/dry|جاف|seche|sèche/i, 'dry'],
    [/matur|aging|anti.age|كبير السن|vieilli/i, 'mature'],
    [/clean|نظيف|propre/i, 'clean_beauty'],
    [/reef|شعاب/i, 'reef_safe'],
    [/pregnan|حامل|حمل|enceinte|grossesse/i, 'pregnancy_safe'],
];

function resolveSkinProfile(raw?: string): string | null {
    if (!raw) return null;
    const t = normalizeArabicText(raw.toLowerCase());
    if (SKIN_PROFILES[t]) return t;
    for (const [re, key] of PROFILE_ALIASES) {
        if (re.test(raw) || re.test(t)) return key;
    }
    return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// § 3  ACTIVE INGREDIENT ALIASES
// ═════════════════════════════════════════════════════════════════════════════

const INCI_ALIAS: Array<[RegExp, string[]]> = [
    [/niacinamide|nicotinamide|نياسيناميد/,         ['niacinamide', 'nicotinamide']],
    [/vitamin.?c|فيتامين.?سي|ascorbic/,              ['ascorbic acid', 'sodium ascorbyl phosphate', 'magnesium ascorbyl phosphate', 'ascorbyl glucoside', 'ascorbyl tetraisopalmitate', '3-o-ethyl ascorbic acid']],
    [/retinol(?! free)|ريتينول/,                     ['retinol', 'retinyl', 'retinal', 'hydroxypinacolone retinoate']],
    [/salicylic|ساليسيليك|\bbha\b/,                  ['salicylic acid', 'betaine salicylate', 'willow bark extract']],
    [/hyaluronic|هيالورونيك/,                        ['hyaluronic acid', 'sodium hyaluronate', 'hydrolyzed hyaluronic acid', 'sodium acetylated hyaluronate']],
    [/glycolic|\baha\b|جليكوليك/,                    ['glycolic acid', 'lactic acid', 'mandelic acid', 'malic acid']],
    [/ceramide|سيراميد/,                             ['ceramide']],
    [/peptide|بيبتيد/,                               ['peptide', 'palmitoyl', 'tripeptide', 'hexapeptide', 'acetyl hexapeptide', 'matrixyl', 'argireline']],
    [/azelaic|أزيليك/,                               ['azelaic acid', 'azeloglycine']],
    [/zinc pca|\bzinc\b|زنك/,                        ['zinc pca', 'zinc gluconate', 'zinc sulfate', 'zinc oxide']],
    [/benzoyl.?peroxide|بنزويل/,                     ['benzoyl peroxide']],
    [/aloe.?vera|صبار/,                              ['aloe barbadensis', 'aloe vera']],
    [/centella|سنتيلا|cica/,                         ['centella asiatica', 'madecassoside', 'asiaticoside', 'asiatic acid']],
    [/kojic/,                                        ['kojic acid']],
    [/tranexamic/,                                   ['tranexamic acid']],
    [/lactic.?acid|حمض.?لاكتيك/,                   ['lactic acid', 'sodium lactate']],
    [/panthenol|provitamin.?b5|بانثينول/,           ['panthenol', 'd-panthenol', 'pantothenol']],
    [/allantoin|الانتوين/,                          ['allantoin']],
    [/arbutin/,                                     ['arbutin', 'alpha-arbutin', 'beta-arbutin']],
    [/vitamin.?e|توكوفيرول/,                        ['tocopherol', 'tocopheryl acetate', 'tocotrienol']],
    [/caffeine|كافيين/,                             ['caffeine']],
    [/squalane|سكوالين/,                            ['squalane', 'squalene']],
    [/glycerin|جليسرين/,                            ['glycerin', 'glycerol']],
    [/urea|يوريا/,                                  ['urea']],
    [/sulfur|كبريت/,                                ['sulfur', 'sulphur']],
    [/licorice|عرق.?السوس/,                        ['glycyrrhiza', 'licorice', 'glabridin', 'dipotassium glycyrrhizate']],
    [/resveratrol/,                                 ['resveratrol']],
    [/collagen|كولاجين/,                            ['collagen', 'hydrolyzed collagen', 'soluble collagen']],
    [/niacinamide|نياسيناميد/,                      ['niacinamide']],
    [/bakuchiol/,                                   ['bakuchiol']],
    [/ectoin|إيكتوين/,                              ['ectoin', 'hydroxyectoine']],
    [/mushroom|버섯|버섯|niacinamide|beta glucan/,  ['beta-glucan', 'saccharomyces', 'tremella']],
    [/ferulic/,                                     ['ferulic acid']],
];

function resolveIngredientAliases(raw: string): string[] {
    const lower = raw.toLowerCase().trim();
    const norm  = normalizeArabicText(lower);
    for (const [re, inci] of INCI_ALIAS) {
        if (re.test(lower) || re.test(norm)) return inci;
    }
    return [norm || lower];
}

// ═════════════════════════════════════════════════════════════════════════════
// § 4  RAW TOKEN EXCLUSION ALIASES
// ═════════════════════════════════════════════════════════════════════════════

const EXCLUDE_ALIAS_MAP: Array<[RegExp, string[]]> = [
    [/fragrance.?free|sans.?parfum|بدون.?عطر|parfum.?free|unscented|non.?fragranced/i, ['parfum', 'fragrance', 'aroma']],
    [/alcohol.?free|بدون.?كحول|sans.?alcool/i,                                        ['alcohol denat', 'ethanol', 'sd alcohol', 'isopropyl alcohol']],
    [/paraben.?free|sans.?parabene|بدون.?بارابين/i,                                   ['paraben']],
    [/sulfate.?free|sls.?free|sles.?free|sans.?sulfate|بدون.?سلفات/i,                ['sodium lauryl sulfate', 'sodium laureth sulfate', 'sulphate']],
    [/silicone.?free|sans.?silicone|بدون.?سيليكون/i,                                 ['dimethicone', 'siloxane', 'cyclomethicone', 'methicone']],
    [/oil.?free|sans.?huile|بدون.?زيت\b/i,                                           ['mineral oil', 'petrolatum', 'paraffinum liquidum']],
    [/essential.?oil.?free|بدون.?زيت.?عطري/i,                                       ['essential oil', 'lavandula', 'mentha']],
    [/peg.?free|بدون.?peg/i,                                                         ['peg-']],
    [/soap.?free|sans.?savon|بدون.?صابون/i,                                          ['sodium palmate', 'sodium stearate', 'saponified']],
    [/hydroquinone.?free|بدون.?هيدروكينون/i,                                        ['hydroquinone']],
    [/microplastic.?free|no.?microbeads|بدون.?بلاستيك/i,                            ['polyethylene', 'polypropylene', 'nylon']],
];

function resolveExcludeTokens(raw: string): string[] {
    const t = normalizeArabicText(raw);
    for (const [re, tokens] of EXCLUDE_ALIAS_MAP) {
        if (re.test(raw) || re.test(t)) return tokens;
    }
    if (t.length >= 3) return [t];
    return [];
}

// ═════════════════════════════════════════════════════════════════════════════
// § 5  HELPERS
// ═════════════════════════════════════════════════════════════════════════════

export function parseIngredientArray(raw: any): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((i: any) => String(i).toLowerCase().trim()).filter(s => s.length > 1);
    if (typeof raw === 'string') {
        return raw.split(/[,،;؛\n]+/)
            .map((s: string) => s.replace(/[.*()]/g, '').trim().toLowerCase())
            .filter((s: string) => s.length > 1);
    }
    return [];
}

function splitConditions(raw?: string): string[] {
    if (!raw) return [];
    return raw.split(/\s*(?:،|,|\/|\s+or\s+|\s+ou\s+|\s+و\s+|\s+and\s+)\s*/i)
        .map(s => s.trim()).filter(s => s.length > 1);
}

// ═════════════════════════════════════════════════════════════════════════════
// § 6  FORMULATION CLASSIFIER
// Infers base formulation type from the first 5 INCI entries.
// ═════════════════════════════════════════════════════════════════════════════

type FormulationClass = 'water-based' | 'oil-based' | 'emulsion' | 'gel' | 'suspension' | 'unknown';

const WATER_MARKERS = /\bwater\b|aqua|eau|hydrosol|floral water|aloe vera juice|infusion|decoction/i;
const OIL_MARKERS   = /oil(?! free)|butter|wax|ester|isopropyl|triglyceride|jojoba|argan|marula|rosehip|squalane|squalene/i;
const GEL_MARKERS   = /carbomer|xanthan gum|cellulose|gum|acrylate|sodium polyacrylate|hydroxyethylcellulose|carrageenan/i;
const EMUL_MARKERS  = /emulsif|stearate|cetearyl|glyceryl stearate|peg-\d+ stearate|polysorbate|lecithin|stearic acid|behenic acid/i;
const SUSP_MARKERS  = /kaolin|titanium dioxide|zinc oxide|talc|mica|silica|clay|bentonite/i;

function classifyFormulation(ingTop5: string[]): FormulationClass {
    const head = ingTop5.join(' ');
    if (WATER_MARKERS.test(head)) {
        if (OIL_MARKERS.test(head) || EMUL_MARKERS.test(head)) return 'emulsion';
        if (GEL_MARKERS.test(head)) return 'gel';
        return 'water-based';
    }
    if (OIL_MARKERS.test(head) && !WATER_MARKERS.test(head)) return 'oil-based';
    if (SUSP_MARKERS.test(head)) return 'suspension';
    return 'unknown';
}

// ═════════════════════════════════════════════════════════════════════════════
// § 7  pH CONTEXT NOTES
// Surfaces formulation context for pH-sensitive actives
// ═════════════════════════════════════════════════════════════════════════════

interface PhNote { active: string; note: string }

function buildPhContextNotes(activeKeys: Set<string>): PhNote[] {
    const notes: PhNote[] = [];
    if (activeKeys.has('vitc'))
        notes.push({ active: 'Vitamin C (L-ascorbic acid)', note: 'Most potent at pH < 3.5. Sodium ascorbyl phosphate/ascorbyl glucoside are stable at pH 4–7 but less bioavailable.' });
    if (activeKeys.has('aha'))
        notes.push({ active: 'AHA acids', note: 'Exfoliating at pH 3–4. Neutralised above pH 5 — check product pH for efficacy.' });
    if (activeKeys.has('bha'))
        notes.push({ active: 'BHA / salicylic acid', note: 'Optimal keratolytic action at pH 3–4. Efficacy drops significantly above pH 4.5.' });
    if (activeKeys.has('azelaic'))
        notes.push({ active: 'Azelaic acid', note: 'Stable across a wide pH range (3.5–6.5). Less dependent on formulation pH than AHA/BHA.' });
    if (activeKeys.has('retinoid'))
        notes.push({ active: 'Retinol / retinoids', note: 'Unstable in light and air; requires opaque, airtight packaging and a low-oxygen environment to preserve activity.' });
    return notes;
}

// ═════════════════════════════════════════════════════════════════════════════
// § 8  PREGNANCY FLAGS
// ═════════════════════════════════════════════════════════════════════════════

function buildPregnancyFlags(ingArray: string[]): string[] {
    const flags: string[] = [];
    const retGroup = INGREDIENT_GROUPS.find(g => g.key === 'retinoid')!;
    const hqGroup  = INGREDIENT_GROUPS.find(g => g.key === 'hydroquinone')!;
    if (ingArray.some(i => retGroup.test(i)))
        flags.push('⚠ Contains retinoid(s) — avoid during pregnancy and breastfeeding (EU SCCS, 2016).');
    if (ingArray.some(i => hqGroup.test(i)))
        flags.push('⚠ Contains hydroquinone — banned as OTC cosmetic in EU; avoid during pregnancy.');
    if (ingArray.some(i => /benzoyl peroxide/i.test(i)))
        flags.push('ℹ Contains benzoyl peroxide — limited safety data in pregnancy; consult a physician.');
    if (ingArray.some(i => /salicylic acid/i.test(i)))
        flags.push('ℹ High-dose salicylic acid (>2%) is not recommended during pregnancy; low-dose topical is generally considered low-risk.');
    return flags;
}

// ═════════════════════════════════════════════════════════════════════════════
// § 9  PER-PRODUCT INGREDIENT PROFILE BUILDER
// ═════════════════════════════════════════════════════════════════════════════

interface GroupHit {
    group: string;
    label: string;
    labelAr: string;
    riskLevel: string;
    explanation: string;
    reference?: string;
    detectedIngredients: string[];
}

interface ActiveHit {
    conceptKey: string;
    label: string;
    foundAt: string[];
    firstPosition: number;   // 1-based
    concentrationSignal: 'high' | 'moderate' | 'trace';
}

export interface IngredientProfile {
    formulationClass: FormulationClass;
    detectedGroups: GroupHit[];
    activeProfile: ActiveHit[];
    suitabilityBadges: string[];
    phContextNotes: PhNote[];
    pregnancyFlags: string[];
    warnings: string[];
    complianceScore: number;     // 0–100: % of COMPLIANCE_KEYS absent
    skinProfileScores: Record<string, number>;  // per skin_profile key → 0–100
}

/** Groups counted in the clean-beauty compliance score */
const COMPLIANCE_KEYS = [
    'fragrance', 'sulfate', 'paraben', 'formaldehyde_releaser',
    'comedogenic', 'occlusive', 'drying_alcohol', 'sensitizer',
    'essential_oil', 'soap', 'heavy_emollient', 'peg',
    'microplastic', 'hydroquinone', 'endocrine_disruptor', 'artificial_colorant',
];

function buildIngredientProfile(ingArray: string[]): IngredientProfile {
    const detectedGroups: GroupHit[] = [];
    const activeProfile: ActiveHit[] = [];

    // Scan groups
    for (const group of INGREDIENT_GROUPS) {
        const hits = ingArray.filter(i => group.test(i));
        if (hits.length > 0) {
            detectedGroups.push({
                group: group.key,
                label: group.label,
                labelAr: group.labelAr,
                riskLevel: group.riskLevel,
                explanation: group.explanation,
                reference: group.reference,
                detectedIngredients: hits.slice(0, 5),
            });
        }
    }

    // Scan actives using the shared CONCEPTS system
    for (const concept of CONCEPTS) {
        if (!concept.active) continue;
        const hits: string[] = [];
        let firstPos = -1;
        for (let i = 0; i < ingArray.length; i++) {
            if (concept.test(ingArray[i])) {
                if (firstPos === -1) firstPos = i;
                hits.push(ingArray[i]);
            }
        }
        if (hits.length > 0) {
            const pos = firstPos + 1;
            activeProfile.push({
                conceptKey: concept.key,
                label: concept.label.en,
                foundAt: hits.slice(0, 3),
                firstPosition: pos,
                concentrationSignal: pos <= 5 ? 'high' : pos <= 15 ? 'moderate' : 'trace',
            });
        }
    }
    activeProfile.sort((a, b) => a.firstPosition - b.firstPosition);

    const detectedKeys = new Set(detectedGroups.map(g => g.group));
    const activeKeys   = new Set(activeProfile.map(a => a.conceptKey));

    // Suitability badges
    const suitabilityBadges: string[] = [];
    if (!detectedKeys.has('fragrance'))              suitabilityBadges.push('✓ Fragrance-free');
    if (!detectedKeys.has('paraben'))                suitabilityBadges.push('✓ Paraben-free');
    if (!detectedKeys.has('sulfate'))                suitabilityBadges.push('✓ Sulfate-free');
    if (!detectedKeys.has('comedogenic'))            suitabilityBadges.push('✓ Non-comedogenic oils');
    if (!detectedKeys.has('occlusive'))              suitabilityBadges.push('✓ Non-occlusive');
    if (!detectedKeys.has('drying_alcohol'))         suitabilityBadges.push('✓ No drying alcohols');
    if (!detectedKeys.has('formaldehyde_releaser'))  suitabilityBadges.push('✓ No formaldehyde releasers');
    if (!detectedKeys.has('soap'))                   suitabilityBadges.push('✓ Soap-free');
    if (!detectedKeys.has('peg'))                    suitabilityBadges.push('✓ PEG-free');
    if (!detectedKeys.has('microplastic'))           suitabilityBadges.push('✓ Microplastic-free');
    if (!detectedKeys.has('hydroquinone'))           suitabilityBadges.push('✓ Hydroquinone-free');
    if (!detectedKeys.has('endocrine_disruptor'))    suitabilityBadges.push('✓ No suspected EDCs');
    if (!detectedKeys.has('chemical_uv'))            suitabilityBadges.push('✓ Mineral UV only (if SPF)');
    if (detectedKeys.has('silicone'))                suitabilityBadges.push('ℹ Contains silicones');
    if (detectedKeys.has('sensitizer'))              suitabilityBadges.push('⚠ EU fragrance allergens detected');
    if (detectedKeys.has('essential_oil'))           suitabilityBadges.push('⚠ Contains essential oils');
    if (detectedKeys.has('heavy_emollient'))         suitabilityBadges.push('⚠ Heavy emollients (may not suit oily/acne-prone skin)');
    if (detectedKeys.has('artificial_colorant'))     suitabilityBadges.push('ℹ Contains artificial colorants');
    if (activeKeys.has('retinoid'))                  suitabilityBadges.push('⚠ Retinoid — avoid in pregnancy; use SPF next AM');

    // Compliance score (out of COMPLIANCE_KEYS)
    const absentCount    = COMPLIANCE_KEYS.filter(k => !detectedKeys.has(k)).length;
    const complianceScore = Math.round((absentCount / COMPLIANCE_KEYS.length) * 100);

    // Skin profile scores — per preset, % of that profile's exclude_groups that are absent
    const skinProfileScores: Record<string, number> = {};
    for (const [profileKey, profile] of Object.entries(SKIN_PROFILES)) {
        const absent = profile.excludeGroups.filter(k => !detectedKeys.has(k)).length;
        skinProfileScores[profileKey] = Math.round((absent / profile.excludeGroups.length) * 100);
    }

    // pH notes
    const phContextNotes = buildPhContextNotes(activeKeys);

    // Pregnancy flags
    const pregnancyFlags = buildPregnancyFlags(ingArray);

    // Warnings
    const warnings: string[] = [];
    for (const g of detectedGroups) {
        if (g.riskLevel === 'high' || g.riskLevel === 'medium') {
            warnings.push(`${g.label}: ${g.detectedIngredients.join(', ')}`);
        }
    }

    // Formulation class
    const formulationClass = classifyFormulation(ingArray.slice(0, 5));

    return {
        formulationClass,
        detectedGroups,
        activeProfile,
        suitabilityBadges,
        phContextNotes,
        pregnancyFlags,
        warnings,
        complianceScore,
        skinProfileScores,
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// § 10  TYPE DEFINITIONS
// ═════════════════════════════════════════════════════════════════════════════

export interface InciMustHaveRule {
    ingredient: string;
    /** Ingredient must appear within the first N positions (1-based, meaningful concentration). */
    within_first?: number;
}

export type SortOption = 'compliance' | 'price_asc' | 'price_desc' | 'active_concentration';

export interface FilterByInciRulesArgs {
    /**
     * Preset skin profile — auto-expands to the appropriate exclude_groups bundle.
     * Values: "oily" | "acne_prone" | "sensitive" | "dry" | "mature" | "clean_beauty" | "reef_safe" | "pregnancy_safe"
     * Also accepts multilingual phrases: "grasse", "دهني", "sensible", "hypoallergenic", etc.
     */
    skin_profile?: string;

    /**
     * Named ingredient groups to EXCLUDE (hard filter, all AND-ed).
     * Keys: occlusive, comedogenic, heavy_emollient, drying_alcohol, fragrance, sensitizer,
     *       essential_oil, sulfate, paraben, silicone, peg, formaldehyde_releaser, soap,
     *       chemical_uv, microplastic, endocrine_disruptor, artificial_colorant,
     *       propylene_glycol, hydroquinone, retinoid.
     * Also accepts free-form phrases: "occlusive-free", "non-comedogenic", "fragrance-free", etc.
     */
    exclude_groups?: string[];

    /** Raw INCI / free-of strings that must NOT appear. Alias-resolved. */
    must_not_have?: string[];

    /** Actives that MUST all be present, optionally within first N positions. */
    must_have?: InciMustHaveRule[];

    /**
     * When true, products containing retinoids or hydroquinone are excluded.
     * Use for pregnancy-safe filtering even without skin_profile.
     */
    pregnancy_safe_only?: boolean;

    /** Country of origin, any language. */
    country?: string;

    /** Product category. */
    category?: string;

    /** Skin type / concern (used for tag-based filtering, any language). */
    skin_type?: string;

    /** Hair type filter. */
    hair_type?: string;

    /** Marketing claims ALL of which must be present. */
    required_claims?: string[];

    /** Minimum price (inclusive, catalog currency). */
    price_min?: number;

    /** Maximum price (inclusive, catalog currency). */
    price_max?: number;

    /**
     * Sort order for results.
     * "compliance"           — highest compliance score first (default)
     * "price_asc"            — cheapest first
     * "price_desc"           — most expensive first
     * "active_concentration" — products with required actives earliest in INCI list first
     */
    sort_by?: SortOption;

    /** Pagination offset (default 0). */
    offset?: number;

    /** Max results per page (default 10, max 30). */
    limit?: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// § 11  MAIN EXPORT
// ═════════════════════════════════════════════════════════════════════════════

export async function filterByInciRules(args: FilterByInciRulesArgs) {
    const products = await getProducts();
    const limit  = Math.min(Math.max(args.limit  || 10, 1), 30);
    const offset = Math.max(args.offset || 0, 0);
    const appliedRules: string[] = [];

    // ── Resolve skin_profile preset ───────────────────────────────────────────
    const profileKey    = resolveSkinProfile(args.skin_profile);
    const profilePreset = profileKey ? SKIN_PROFILES[profileKey] : null;
    const profileGroupKeys = profilePreset?.excludeGroups || [];

    // ── Resolve group exclusions (preset + explicit, deduplicated) ────────────
    const allGroupRaws = [
        ...profileGroupKeys,
        ...(args.exclude_groups || []),
    ];
    const resolvedExcludeGroups: IngredientGroup[] = [];
    const unrecognizedGroups: string[] = [];
    for (const raw of allGroupRaws) {
        const g = resolveGroup(raw);
        if (g && !resolvedExcludeGroups.find(x => x.key === g.key)) {
            resolvedExcludeGroups.push(g);
        } else if (!g) {
            unrecognizedGroups.push(raw);
        }
    }

    // ── Pregnancy gate (also force-exclude retinoid & hydroquinone groups) ────
    const pregnancySafe = args.pregnancy_safe_only || profileKey === 'pregnancy_safe';
    if (pregnancySafe) {
        for (const key of ['retinoid', 'hydroquinone']) {
            const g = GROUP_BY_KEY.get(key);
            if (g && !resolvedExcludeGroups.find(x => x.key === key)) {
                resolvedExcludeGroups.push(g);
            }
        }
    }

    // ── Raw token exclusions ──────────────────────────────────────────────────
    const rawExcludeTokens = (args.must_not_have || []).flatMap(resolveExcludeTokens).filter(Boolean);

    // ── Structural filters ────────────────────────────────────────────────────
    const targetCountry    = normalizeCountry(args.country);
    const targetCat        = normalizeCategory(args.category);
    const expandedClaims   = args.required_claims?.length ? expandToCatalogClaims(args.required_claims) : [];
    const skinConditions   = splitConditions(args.skin_type);
    const hairConditions   = splitConditions(args.hair_type);
    const targetConditions = [...skinConditions, ...hairConditions];

    type ScoredProduct = { product: any; positionScore: number; profile: IngredientProfile };
    const matched: ScoredProduct[] = [];

    for (const p of products) {
        const entry = getSearchEntry(p);
        if (!entry.hasIngredients) continue;

        // Country gate
        if (targetCountry && entry.countryCanon !== targetCountry.toLowerCase()) continue;

        // Category gate
        if (targetCat) {
            const c = entry.catCanon, ct = targetCat.toLowerCase();
            if (c !== ct && !c.includes(ct) && !ct.includes(c)) continue;
        }

        // Price gate
        const bounds = entry.bounds;
        const midPrice = bounds.min != null ? ((bounds.min + (bounds.max ?? bounds.min)) / 2) : null;
        if (args.price_min != null && midPrice != null && midPrice < args.price_min) continue;
        if (args.price_max != null && midPrice != null && midPrice > args.price_max) continue;

        const ingArray = parseIngredientArray(p.ingredients);

        // Group exclusion gate
        let groupFail = false;
        for (const group of resolvedExcludeGroups) {
            if (ingArray.some(i => group.test(i))) { groupFail = true; break; }
        }
        if (groupFail) continue;

        // Raw token exclusion gate
        if (rawExcludeTokens.length > 0 && rawExcludeTokens.some(tok => entry.pIng.includes(tok))) continue;

        // Must-have gate
        let mustHaveFail  = false;
        let totalPosScore = 0;
        for (const rule of (args.must_have || [])) {
            const tokens = resolveIngredientAliases(rule.ingredient);
            let foundIdx = -1;
            for (let i = 0; i < ingArray.length; i++) {
                if (tokens.some(tok => ingArray[i].includes(tok))) { foundIdx = i; break; }
            }
            if (foundIdx === -1) {
                if (!tokens.some(tok => entry.pIng.includes(tok))) { mustHaveFail = true; break; }
                foundIdx = ingArray.length;
            }
            if (rule.within_first !== undefined && rule.within_first > 0 && foundIdx >= rule.within_first) {
                mustHaveFail = true; break;
            }
            totalPosScore += foundIdx;
        }
        if (mustHaveFail) continue;

        // Skin/hair condition tag gate (≥ half must match)
        if (targetConditions.length > 0) {
            const hits = targetConditions.filter(cond =>
                entry.allTags.some(t => matchesMultilingualCondition(t, cond))
            ).length;
            if (hits < Math.ceil(targetConditions.length / 2)) continue;
        }

        // Required claims gate
        if (expandedClaims.length > 0) {
            const claimsMet = expandedClaims.every(claim => {
                const ec = normalizeArabicText(claim);
                return entry.allTagsNorm.some(t => t.includes(ec) || ec.includes(t));
            });
            if (!claimsMet) continue;
        }

        const profile = buildIngredientProfile(ingArray);
        matched.push({ product: p, positionScore: totalPosScore, profile });
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    const sortBy = args.sort_by || 'compliance';
    matched.sort((a, b) => {
        switch (sortBy) {
            case 'price_asc': {
                const pa = a.product.price?.min ?? a.product.price?.value ?? 0;
                const pb = b.product.price?.min ?? b.product.price?.value ?? 0;
                return pa - pb;
            }
            case 'price_desc': {
                const pa = a.product.price?.min ?? a.product.price?.value ?? 0;
                const pb = b.product.price?.min ?? b.product.price?.value ?? 0;
                return pb - pa;
            }
            case 'active_concentration':
                return (a.positionScore - b.positionScore) ||
                       (b.profile.complianceScore - a.profile.complianceScore);
            default: // compliance
                return (b.profile.complianceScore - a.profile.complianceScore) ||
                       (a.positionScore - b.positionScore);
        }
    });

    // ── Pagination ────────────────────────────────────────────────────────────
    const totalMatched = matched.length;
    const paged        = matched.slice(offset, offset + limit);
    const hasMore      = (offset + paged.length) < totalMatched;

    // ── Build applied-rules summary ───────────────────────────────────────────
    if (profilePreset)                  appliedRules.push(`skin_profile=${profileKey} (${profilePreset.excludeGroups.join(',')})`);
    if (resolvedExcludeGroups.length)   appliedRules.push(`exclude_groups=[${resolvedExcludeGroups.map(g => g.key).join(', ')}]`);
    if (rawExcludeTokens.length)        appliedRules.push(`must_not_have=[${(args.must_not_have || []).join(', ')}]`);
    if (args.must_have?.length)         appliedRules.push(`must_have=[${args.must_have.map(r => r.within_first ? `${r.ingredient}(top${r.within_first})` : r.ingredient).join(', ')}]`);
    if (pregnancySafe)                  appliedRules.push('pregnancy_safe_only=true');
    if (targetCountry)                  appliedRules.push(`country=${targetCountry}`);
    if (targetCat)                      appliedRules.push(`category=${targetCat}`);
    if (skinConditions.length)          appliedRules.push(`skin_type=${skinConditions.join('+')}`);
    if (hairConditions.length)          appliedRules.push(`hair_type=${hairConditions.join('+')}`);
    if (expandedClaims.length)          appliedRules.push(`required_claims=[${(args.required_claims || []).join(', ')}]`);
    if (args.price_min != null)         appliedRules.push(`price_min=${args.price_min}`);
    if (args.price_max != null)         appliedRules.push(`price_max=${args.price_max}`);
    if (sortBy !== 'compliance')        appliedRules.push(`sort_by=${sortBy}`);
    if (offset > 0)                     appliedRules.push(`offset=${offset}`);

    // ── Map results ───────────────────────────────────────────────────────────
    const results = paged.map(({ product: p, positionScore, profile }) => {
        const bounds       = resolvePriceBounds(p.price);
        const displayPrice = formatPriceDisplay(bounds);
        const ingArray     = parseIngredientArray(p.ingredients);
        let displayQty = '';
        if (typeof p.quantity === 'string') {
            displayQty = p.quantity;
        } else if (p.quantity && typeof p.quantity === 'object') {
            displayQty = `${p.quantity.qtyValue || ''} ${p.quantity.qtyUnit || ''}`.trim();
        }

        return {
            id: p.id,
            brand: p.brand,
            name: p.name,
            country: p.country,
            category: typeof p.category === 'object' ? (p.category?.id || p.category) : p.category,
            categoryLabel: typeof p.category === 'object' ? p.category?.label : null,
            quantity: displayQty,
            price: displayPrice,
            priceMin: bounds.min,
            priceMax: bounds.max,
            currency: bounds.currency,
            image: p.image,
            claims: p.marketingClaims || [],
            targetTypes: p.targetTypes || [],
            ingredientCount: ingArray.length,
            firstTenIngredients: ingArray.slice(0, 10),
            // ── Business-grade profile ─────────────────────────────────────
            complianceScore: profile.complianceScore,
            skinProfileScores: profile.skinProfileScores,
            formulationClass: profile.formulationClass,
            suitabilityBadges: profile.suitabilityBadges,
            activeProfile: profile.activeProfile,
            detectedGroups: profile.detectedGroups.map(g => ({
                group: g.group,
                label: g.label,
                labelAr: g.labelAr,
                riskLevel: g.riskLevel,
                explanation: g.explanation,
                reference: g.reference,
                detectedIngredients: g.detectedIngredients,
            })),
            phContextNotes: profile.phContextNotes,
            pregnancyFlags: profile.pregnancyFlags,
            warnings: profile.warnings,
            activePositionScore: positionScore,
        };
    });

    return {
        totalMatched,
        returnedCount: results.length,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + results.length : null,
        appliedRules,
        unrecognizedGroups,
        sortedBy: sortBy,
        resolvedSkinProfile: profilePreset ? {
            key: profileKey,
            label: profilePreset.label,
            description: profilePreset.description,
            autoExcludedGroups: profilePreset.excludeGroups,
        } : null,
        products: results,
        availableGroups: INGREDIENT_GROUPS.map(g => ({
            key: g.key,
            label: g.label,
            labelAr: g.labelAr,
            riskLevel: g.riskLevel,
            aliasExamples: g.aliases.slice(0, 3),
            explanation: g.explanation,
        })),
        availableSkinProfiles: Object.entries(SKIN_PROFILES).map(([key, p]) => ({
            key,
            label: p.label,
            excludeGroups: p.excludeGroups,
            description: p.description,
        })),
        fallbackMessage: results.length === 0
            ? `No products satisfy the specified rules. Applied: ${appliedRules.join(' | ')}. Suggestions: (1) remove a group from exclude_groups, (2) drop a within_first constraint, (3) widen the category or country, (4) check available stock with no filters.`
            : null,
    };
}
