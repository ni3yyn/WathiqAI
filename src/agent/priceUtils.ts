/**
 * Wathiq Intelligence — Unified Price Resolution
 *
 * The raw catalog stores price in several inconsistent shapes depending on how each
 * product was ingested: a plain number, a numeric string ("1200 DA"), or an object
 * with any of {min, max, amount, value, val, price}. Every consumer used to re-parse
 * this ad-hoc (getProduct.ts, searchProducts.ts, buildRoutine.ts each had their own
 * slightly different version). This module is the single source of truth — fix a
 * parsing edge case here once, and every tool benefits.
 */

export interface PriceBounds {
    min?: number;
    max?: number;
    currency: string;
}

const DEFAULT_CURRENCY = 'DZD';

function coerceNumber(v: any): number | null {
    if (typeof v === 'number' && !isNaN(v) && v > 0) return v;
    if (typeof v === 'string') {
        const parsed = parseFloat(v.replace(/[^0-9.]/g, ''));
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
}

/**
 * Resolves min/max price bounds + currency from any raw price shape found in the catalog.
 * Returns an empty bounds object (no min/max) rather than throwing when the price is
 * missing or unparseable — callers decide how to treat "unknown price".
 */
export function resolvePriceBounds(raw: any): PriceBounds {
    if (raw === null || raw === undefined) return { currency: DEFAULT_CURRENCY };

    if (typeof raw === 'number' || typeof raw === 'string') {
        const v = coerceNumber(raw);
        return v !== null ? { min: v, max: v, currency: DEFAULT_CURRENCY } : { currency: DEFAULT_CURRENCY };
    }

    if (typeof raw === 'object') {
        const currency = raw.currency || DEFAULT_CURRENCY;
        const candidates = [raw.min, raw.max, raw.amount, raw.value, raw.val, raw.price]
            .map(coerceNumber)
            .filter((v): v is number => v !== null);

        if (candidates.length === 0) return { currency };
        return { min: Math.min(...candidates), max: Math.max(...candidates), currency };
    }

    return { currency: DEFAULT_CURRENCY };
}

/**
 * Single representative numeric price for arithmetic (budget math, "cheaper than"
 * comparisons, sorting). Prefers `min` — the cheapest realistic price point — so
 * budget filtering stays conservative rather than over-estimating cost.
 */
export function getRepresentativePrice(product: any): number {
    const bounds = resolvePriceBounds(product?.price);
    return bounds.min ?? bounds.max ?? 0;
}

/**
 * Human-readable price string for UI display: "1200" for a fixed price,
 * "1200 – 1500" for a ranged price, "" when the price is unknown.
 */
export function formatPriceDisplay(bounds: PriceBounds): string {
    if (bounds.min !== undefined && bounds.max !== undefined) {
        return bounds.min === bounds.max ? `${bounds.min}` : `${bounds.min} – ${bounds.max}`;
    }
    if (bounds.min !== undefined) return `${bounds.min}`;
    if (bounds.max !== undefined) return `${bounds.max}`;
    return '';
}