/**
 * check_compatibility — can these actives/products be used together?
 *
 * Deterministic rule lookup (see ingredientKnowledge.INTERACTION_RULES) over
 *   • products (catalog IDs → full INCI list), and/or
 *   • free-text actives ("retinol + vitamin C").
 * Also proposes an AM/PM split and flags the missing-sunscreen case.
 */
import { getProduct } from './getProduct';
import {
    CONCEPTS, getConcept, detectConcepts, resolveAllConcepts, findRule,
    placementOf, PHOTOSENSITIZING, PREGNANCY_NOTE, L10n, Placement, Severity,
} from '../ingredientKnowledge';

export interface CheckCompatibilityArgs {
    productIds?: string[];
    /** Free-text actives, any language: ["ريتينول", "vitamin c"] or "retinol with aha". */
    actives?: string[];
}

interface Item {
    label: string;
    keys: string[];
    productId?: string;
}

// concepts that participate in rules or placement
const RELEVANT_KEYS = Array.from(new Set([
    'retinoid', 'vitc', 'aha', 'bha', 'pha', 'benzoyl', 'niacinamide', 'uv_filter',
    ...CONCEPTS.filter(c => ['retinoid', 'vitc', 'aha', 'bha', 'benzoyl', 'uv_filter'].includes(c.key)).map(c => c.key),
]));

function itemPlacement(keys: string[]): Placement {
    const ps = keys.map(placementOf);
    const hasAM = ps.includes('AM');
    const hasPM = ps.includes('PM');
    if (hasAM && hasPM) return 'either';
    if (hasPM) return 'PM';
    if (hasAM) return 'AM';
    return 'either';
}

export async function checkCompatibility(args: CheckCompatibilityArgs) {
    const items: Item[] = [];
    const unresolved: string[] = [];

    // 1. Catalog products → concepts from the FULL ingredient list
    const ids = Array.from(new Set((args.productIds || []).filter(Boolean))).slice(0, 8);
    const lookups = await Promise.all(ids.map(id => getProduct({ productId: id })));
    lookups.forEach((r, i) => {
        if (!r.found || !r.product) { unresolved.push(ids[i]); return; }
        const found = detectConcepts(r.product.ingredientList, RELEVANT_KEYS);
        items.push({
            label: `${r.product.brand} ${r.product.name}`.trim(),
            keys: [...found.keys()],
            productId: r.product.id,
        });
    });

    // 2. Free-text actives → one virtual item per recognized concept
    const seen = new Set<string>();
    for (const raw of args.actives || []) {
        const concepts = resolveAllConcepts(raw);
        if (concepts.length === 0) { unresolved.push(raw); continue; }
        for (const c of concepts) {
            if (seen.has(c.key)) continue;
            seen.add(c.key);
            items.push({ label: c.label.ar, keys: [c.key] });
        }
    }

    if (items.length < 2) {
        return {
            error: items.length === 0
                ? 'لم أتعرف على أي مكوّن فعّال أو منتج للمقارنة. اذكر مكوّنين على الأقل (مثال: ريتينول وفيتامين سي).'
                : 'أحتاج إلى مكوّنين أو منتجين على الأقل للتحقق من التوافق.',
            unresolved: unresolved.length ? unresolved : undefined,
        };
    }

    // 3. Pairwise rule scan across items (not within one product)
    const conflicts: Array<{ between: [string, string]; concepts: [string, string]; severity: Severity; advice: L10n }> = [];
    const okNotes: Array<{ between: [string, string]; advice: L10n }> = [];
    const dedupe = new Set<string>();

    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            for (const ka of items[i].keys) {
                for (const kb of items[j].keys) {
                    if (ka === kb) continue;
                    const rule = findRule(ka, kb);
                    if (!rule) continue;
                    const id = [ka, kb].sort().join('|') + `|${i}|${j}`;
                    if (dedupe.has(id)) continue;
                    dedupe.add(id);
                    if (rule.severity === 'ok') {
                        okNotes.push({ between: [items[i].label, items[j].label], advice: rule.advice });
                    } else {
                        conflicts.push({
                            between: [items[i].label, items[j].label],
                            concepts: [getConcept(ka)?.label.ar || ka, getConcept(kb)?.label.ar || kb],
                            severity: rule.severity,
                            advice: rule.advice,
                        });
                    }
                }
            }
        }
    }

    // 4. Placement plan
    const plan: { AM: string[]; PM: string[]; flexible: string[] } = { AM: [], PM: [], flexible: [] };
    for (const it of items) {
        const p = itemPlacement(it.keys);
        (p === 'AM' ? plan.AM : p === 'PM' ? plan.PM : plan.flexible).push(it.label);
    }

    const allKeys = new Set(items.flatMap(i => i.keys));
    const needsSunscreen = PHOTOSENSITIZING.some(k => allKeys.has(k)) && !allKeys.has('uv_filter');

    const overall: 'ok' | 'caution' | 'avoid_together' =
        conflicts.some(c => c.severity === 'avoid_together') ? 'avoid_together'
        : conflicts.length > 0 ? 'caution' : 'ok';

    return {
        itemsChecked: items.map(i => ({ label: i.label, productId: i.productId, actives: i.keys.map(k => getConcept(k)?.label.ar || k) })),
        overall,
        conflicts,
        compatibleNotes: okNotes,
        placement: plan,
        needsSunscreen,
        pregnancyNote: allKeys.has('retinoid') ? PREGNANCY_NOTE : undefined,
        unresolved: unresolved.length ? unresolved : undefined,
        disclaimer: 'إرشاد عام وليس بديلاً عن استشارة طبيب الجلدية، خصوصاً مع البشرة الحساسة أو الحمل.',
    };
}
