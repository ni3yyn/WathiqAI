/**
 * Active fingerprints of well-known IMPORTED products (the ones Algerian users
 * quote prices for in parapharmacies), so "a local dupe for X" can be answered
 * even though X is not in the catalog.
 *
 * ⚠️ APPROXIMATE — the key-active lists summarize publicly documented formulas
 * and brands reformulate. They are used only to rank local candidates by shared
 * actives; the reply must never state concentrations that are not in the
 * catalog, and the result carries `approximate: true`. Review/extend this list.
 */
// Local folding (not imported from intents.ts, which imports this module).
const foldMessage = (raw: string): string => String(raw || '')
    .normalize('NFKC')
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export interface ReferenceFingerprint {
    /** lowercase, folded name fragments; the longest matching one wins */
    names: string[];
    label: string;
    category?: string;
    /** ingredientKnowledge concept keys */
    actives: string[];
}

export const REFERENCES: ReferenceFingerprint[] = [
    { names: ['effaclar duo', 'effaclar'], label: 'La Roche-Posay Effaclar Duo+', category: 'lotion_cream', actives: ['niacinamide', 'bha'] },
    { names: ['cerave moisturizing cream', 'cerave moisturising cream', 'cerave cream'], label: 'CeraVe Moisturizing Cream', category: 'lotion_cream', actives: ['ceramide', 'hyaluronic'] },
    { names: ['cerave foaming', 'cerave foaming cleanser'], label: 'CeraVe Foaming Cleanser', category: 'cleanser', actives: ['ceramide', 'niacinamide'] },
    { names: ['ordinary niacinamide', 'the ordinary niacinamide'], label: 'The Ordinary Niacinamide 10% + Zinc 1%', category: 'skin_serum', actives: ['niacinamide', 'zinc'] },
    { names: ['ordinary glycolic', 'the ordinary glycolic'], label: 'The Ordinary Glycolic Acid Toner', category: 'toner', actives: ['aha'] },
    { names: ['ordinary retinol', 'the ordinary retinol'], label: 'The Ordinary Retinol Serum', category: 'skin_serum', actives: ['retinoid'] },
    { names: ['ordinary azelaic', 'the ordinary azelaic'], label: 'The Ordinary Azelaic Acid Suspension', category: 'skin_serum', actives: ['azelaic'] },
    { names: ['cosrx bha', 'blackhead power liquid'], label: 'COSRX BHA Blackhead Power Liquid', category: 'toner', actives: ['bha'] },
    { names: ['cosrx aha/bha', 'cosrx aha bha', 'clarifying treatment toner'], label: 'COSRX AHA/BHA Clarifying Treatment Toner', category: 'toner', actives: ['aha', 'bha'] },
    { names: ['cicaplast', 'cicaplast baume'], label: 'La Roche-Posay Cicaplast Baume B5', category: 'lotion_cream', actives: ['panthenol', 'centella'] },
    { names: ['hyalu b5', 'hyalu b5 serum'], label: 'La Roche-Posay Hyalu B5', category: 'skin_serum', actives: ['hyaluronic', 'panthenol'] },
    { names: ['vichy mineral 89', 'mineral 89'], label: 'Vichy Minéral 89', category: 'skin_serum', actives: ['hyaluronic'] },
    { names: ['skinceuticals', 'c e ferulic'], label: 'SkinCeuticals C E Ferulic', category: 'skin_serum', actives: ['vitc', 'tocopherol'] },
    { names: ['photoderm', 'bioderma photoderm'], label: 'Bioderma Photoderm', category: 'sunscreen', actives: ['uv_filter'] },
    { names: ['anthelios', 'la roche-posay anthelios', 'la roche posay anthelios'], label: 'La Roche-Posay Anthelios', category: 'sunscreen', actives: ['uv_filter'] },
];

const INDEX = REFERENCES
    .flatMap(r => r.names.map(n => ({ n: foldMessage(n).replace(/[-']/g, ' '), r })))
    .sort((a, b) => b.n.length - a.n.length);

export function matchReference(text: string): ReferenceFingerprint | null {
    const t = foldMessage(text || '').replace(/[-'’]/g, ' ');
    if (!t) return null;
    for (const { n, r } of INDEX) if (t.includes(n)) return r;
    return null;
}

/** "4800 دج", "4 800 DA", "4800 dzd" → 4800 */
export function parsePriceFromText(text: string): number | undefined {
    const m = String(text || '').replace(/(\d)[\s,.](?=\d{3}\b)/g, '$1').match(/(\d{3,6})\s*(?:دج|دينار|da\b|dzd|dz\b)/i);
    return m ? parseInt(m[1], 10) : undefined;
}
