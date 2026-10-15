/**
 * Bridges the app's shelf (profiles/{uid}/savedProducts) into the agent's cabinet
 * logic, so every cabinet-based feature — duplicate-actives warnings, gaps,
 * "didn't suit me", compatibility over what you own, routine from what you own,
 * shopping list minus owned, triage candidates — runs on the user's REAL shelf.
 *
 * Read-only toward the app: annotations go to the overlay, never to Firestore.
 */
import crypto from 'crypto';
import { getProduct, norm } from '../agent/tools/getProduct';
import { detectActives } from '../agent/ingredientKnowledge';
import type { CabinetItem, ShelfProvider } from '../agent/cabinet';
import type { UserDataService, ShelfEntry, ShelfMatcher } from './userData';
import { mapProductType } from './userData';
import type { OverlayStore } from './overlay';

// ── shelf entry → catalog match (strong matches only) ─────────────────────────
const STRONG = /^(exact_id|partial_id|exact_name|unique_substring)/;

export function createCatalogShelfMatcher(concurrency = 6): ShelfMatcher {
    return async (entries: ShelfEntry[]) => {
        let i = 0;
        const worker = async () => {
            while (i < entries.length) {
                const e = entries[i++];
                try {
                    const r = await getProduct({ productName: e.name, query: e.name });
                    const strategy = r.matchStrategy || '';
                    const pct = parseInt(/\((\d+)%\)/.exec(strategy)?.[1] || '0', 10);
                    // strong lookup strategies, or a high-confidence fuzzy match that is corroborated
                    // (the same normalized name, or the catalog brand appears in the shelf name)
                    const corroborated = !!r.product && pct >= 88 && (norm(e.name) === norm(r.product.name) || norm(e.name).includes(norm(r.product.brand)));
                    if (r.found && r.product && (STRONG.test(strategy) || corroborated)) {
                        const p = r.product;
                        e.match = { productId: p.id, brand: p.brand, name: p.name, priceMin: p.priceMin ?? undefined, priceMax: p.priceMax ?? undefined, currency: p.currency, category: String(p.category || '') };
                    } else e.match = null;
                } catch { e.match = null; }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
    };
}

export function shelfEntryToItem(e: ShelfEntry, note?: { status?: any; verdict?: any; note?: string; reason?: string }): CabinetItem {
    const when = new Date(e.createdAt || Date.now()).toISOString();
    const ingredients = e.ingredients.length ? e.ingredients : undefined;
    return {
        id: e.docId,
        productId: e.match?.productId,
        brand: e.match?.brand || '',
        name: e.match?.name || e.name,
        category: mapProductType(e.type) || e.match?.category,
        source: e.match ? 'catalog' : 'scan',
        ingredients,
        actives: ingredients ? [...detectActives(ingredients).keys()] : [],
        price: e.match && (e.match.priceMin !== undefined || e.match.priceMax !== undefined)
            ? { min: e.match.priceMin, max: e.match.priceMax, currency: e.match.currency || 'DZD' } : null,
        image: e.image,
        // their shelf = products the user keeps; "using" unless the user said otherwise in chat
        status: note?.status || 'using',
        verdict: note?.verdict,
        note: note?.note,
        reason: note?.reason,
        addedAt: when, updatedAt: when,
    };
}

export function createShelfProvider(users: UserDataService, overlay: OverlayStore): ShelfProvider {
    const list = (uid: string): CabinetItem[] => {
        const ov = overlay.get(uid);
        const ctx = users.peek(uid);
        const fromShelf = (ctx?.shelf || [])
            .filter(e => !ov.notes[e.docId]?.hidden)
            .map(e => shelfEntryToItem(e, ov.notes[e.docId]));
        return [...fromShelf, ...ov.added];
    };

    return {
        has: uid => users.isKnown(uid),
        list,
        add(uid, item) {
            overlay.mutate(uid, o => { o.added.push(item); });
            return item;
        },
        update(uid, id, patch) {
            const isAdded = overlay.get(uid).added.some(i => i.id === id);
            overlay.mutate(uid, o => {
                if (isAdded) {
                    o.added = o.added.map(i => i.id === id ? { ...i, ...patch, updatedAt: new Date().toISOString() } : i);
                } else {
                    o.notes[id] = { ...(o.notes[id] || {}), ...patch, updatedAt: new Date().toISOString() };
                }
            });
            return list(uid).find(i => i.id === id) || null;
        },
        remove(uid, id) {
            const had = list(uid).some(i => i.id === id);
            if (!had) return false;
            overlay.mutate(uid, o => {
                if (o.added.some(i => i.id === id)) o.added = o.added.filter(i => i.id !== id);
                else o.notes[id] = { ...(o.notes[id] || {}), hidden: true, updatedAt: new Date().toISOString() };   // hidden from the AGENT only
            });
            return true;
        },
        clear(uid) {
            const n = list(uid).length;
            overlay.mutate(uid, o => {
                o.added = [];
                for (const e of users.peek(uid)?.shelf || []) o.notes[e.docId] = { ...(o.notes[e.docId] || {}), hidden: true, updatedAt: new Date().toISOString() };
            });
            return n;
        },
        newId: () => `agt_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    };
}
