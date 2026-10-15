/**
 * "My cabinet" — the products a user already owns / uses / tried.
 *
 * Why: most real questions are "what do I do with what I have?" — so layering
 * checks, routines and recommendations start from the cabinet, duplicates are
 * flagged ("you already own a niacinamide serum") and honest verdicts
 * ("this didn't suit me") steer later suggestions.
 *
 * Storage: data/cabinet.json  { users: { <sha256(salt+userId)>: { items, updatedAt } } }
 *   - written atomically (tmp file + rename), mode 0600, mtime-cached reads
 *   - rows are keyed by a salted hash of the client-supplied userId — the id acts
 *     as a bearer secret, so the frontend should use a long random id (UUID v4)
 *   - capped at MAX_ITEMS per user
 *
 * Pure logic (overlap, gaps, dislike insights…) is separate from I/O so it can be
 * tested without the filesystem.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getProduct } from './tools/getProduct';
import { detectActives, getConcept, CONCEPTS, matchConceptInList } from './ingredientKnowledge';
import { normalizeArabicText, normalizeCategory } from './taxonomy';
import { resolvePriceBounds } from './priceUtils';

const FILE = process.env.CABINET_FILE || path.join(process.cwd(), 'data', 'cabinet.json');
const SALT = process.env.CABINET_SALT || 'wathiq-cabinet-v1';
export const MAX_ITEMS = 80;

export type CabinetStatus = 'using' | 'finished' | 'wishlist' | 'stopped';
export type CabinetVerdict = 'loved' | 'ok' | 'didnt_suit';

export interface CabinetItem {
    id: string;
    productId?: string;
    brand: string;
    name: string;
    category?: string;
    categoryLabel?: string;
    source: 'catalog' | 'scan' | 'manual';
    ingredients?: string[];
    /** concept keys of the key actives found in `ingredients` */
    actives: string[];
    price?: { min?: number; max?: number; currency: string } | null;
    quantity?: string | null;
    image?: string;
    status: CabinetStatus;
    verdict?: CabinetVerdict;
    note?: string;
    reason?: string;
    addedAt: string;
    startedAt?: string;
    updatedAt: string;
}

export interface AddItemInput {
    productId?: string;
    productName?: string;
    brand?: string;
    name?: string;
    ingredientsText?: string;
    category?: string;
    status?: CabinetStatus;
    verdict?: CabinetVerdict;
    note?: string;
    source?: 'catalog' | 'scan' | 'manual';
    quantity?: string | null;
}

// ── validation ───────────────────────────────────────────────────────────────
export const USER_ID_RE = /^[A-Za-z0-9_\-:.@]{8,128}$/;
export const isValidUserId = (id: any): id is string => typeof id === 'string' && USER_ID_RE.test(id);
const STATUSES: CabinetStatus[] = ['using', 'finished', 'wishlist', 'stopped'];
const VERDICTS: CabinetVerdict[] = ['loved', 'ok', 'didnt_suit'];
const clip = (s: any, n: number) => String(s ?? '').trim().slice(0, n);

export function userKey(userId: string): string {
    return crypto.createHash('sha256').update(`${SALT}:${userId}`).digest('hex').slice(0, 32);
}

// ── pluggable shelf (signed-in users) ────────────────────────────────────────
/**
 * When the app's own shelf (Firestore savedProducts) is available for a user, the
 * cabinet logic runs on it instead of the JSON file store. See src/auth/shelfProvider.ts.
 * Guests / AUTH_MODE=off keep the original file-backed cabinet.
 */
export interface ShelfProvider {
    has(uid: string): boolean;
    list(uid: string): CabinetItem[];
    add(uid: string, item: CabinetItem): CabinetItem;
    update(uid: string, id: string, patch: Partial<CabinetItem>): CabinetItem | null;
    remove(uid: string, id: string): boolean;
    clear(uid: string): number;
    newId(): string;
}
let provider: ShelfProvider | null = null;
export function setShelfProvider(p: ShelfProvider | null) { provider = p; }
const via = (uid: string): ShelfProvider | null => (provider && provider.has(uid) ? provider : null);

// ── storage ──────────────────────────────────────────────────────────────────
interface Db { users: Record<string, { items: CabinetItem[]; updatedAt: string }> }
let cache: Db | null = null;
let cacheMtime = -1;

function readDb(): Db {
    try {
        if (!fs.existsSync(FILE)) return { users: {} };
        const mtime = fs.statSync(FILE).mtimeMs;
        if (cache && cacheMtime === mtime) return cache;
        const parsed = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
        cache = parsed && typeof parsed === 'object' && parsed.users ? parsed : { users: {} };
        cacheMtime = mtime;
        return cache!;
    } catch (e: any) {
        console.warn('[CABINET] read failed:', e.message);
        return cache || { users: {} };
    }
}

function writeDb(db: Db) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    cache = db;
    try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
}

export function listItems(userId: string): CabinetItem[] {
    const p = via(userId);
    if (p) return p.list(userId);
    if (!isValidUserId(userId)) return [];
    return [...(readDb().users[userKey(userId)]?.items || [])];
}

function saveItems(userId: string, items: CabinetItem[]) {
    const db = readDb();
    const next: Db = { users: { ...db.users, [userKey(userId)]: { items, updatedAt: new Date().toISOString() } } };
    writeDb(next);
}

export function clearCabinet(userId: string): number {
    const p = via(userId);
    if (p) return p.clear(userId);
    if (!isValidUserId(userId)) return 0;
    const db = readDb();
    const k = userKey(userId);
    const n = db.users[k]?.items.length || 0;
    if (!n) return 0;
    const users = { ...db.users }; delete users[k];
    writeDb({ users });
    return n;
}

// ── helpers ──────────────────────────────────────────────────────────────────
export function parseIngredientText(text?: string): string[] {
    return String(text || '')
        .replace(/^\s*(ingredients?|inci|المكونات|composition)\s*[:：]\s*/i, '')
        .split(/[,،;؛\n\r•·]+/)
        .map(s => s.replace(/\.$/, '').trim())
        .filter(s => s.length > 1 && !/^\d+$/.test(s))
        .slice(0, 150);
}

const sameName = (a: CabinetItem, brand: string, name: string) =>
    normalizeArabicText(a.brand) === normalizeArabicText(brand) && normalizeArabicText(a.name) === normalizeArabicText(name);

export type AddResult =
    | { ok: true; item: CabinetItem; created: boolean; overlap: OverlapNote[]; duplicateOf?: CabinetItem }
    | { ok: false; error: string; candidates?: any[] };

/**
 * Adds (or updates) an item. Catalog products are resolved with the same
 * exact → fuzzy → ambiguous machinery as everywhere else.
 */
export async function addItem(userId: string, input: AddItemInput): Promise<AddResult> {
    if (!isValidUserId(userId) && !via(userId)) return { ok: false, error: 'invalid_user' };
    const items = listItems(userId);
    const now = new Date().toISOString();
    const status: CabinetStatus = input.status && STATUSES.includes(input.status) ? input.status : 'using';
    const verdict = input.verdict && VERDICTS.includes(input.verdict) ? input.verdict : undefined;

    let item: CabinetItem | null = null;

    if (input.productId || input.productName) {
        const r = await getProduct({ productId: input.productId, productName: input.productName, query: input.productName });
        if (r.found && r.product) {
            const p = r.product;
            const bounds = resolvePriceBounds({ min: p.priceMin, max: p.priceMax, currency: p.currency });
            item = {
                id: '', productId: p.id, brand: p.brand, name: p.name,
                category: String(p.category || ''), categoryLabel: p.categoryLabel || undefined,
                source: input.source || 'catalog',
                ingredients: p.ingredientList, actives: [...detectActives(p.ingredientList).keys()],
                price: p.priceMin !== undefined || p.priceMax !== undefined ? { min: p.priceMin ?? undefined, max: p.priceMax ?? undefined, currency: bounds.currency } : null,
                quantity: p.quantity || null, image: p.image || undefined,
                status, verdict, note: input.note ? clip(input.note, 300) : undefined,
                addedAt: now, updatedAt: now, startedAt: status === 'using' ? now : undefined,
            };
        } else if (r.candidates?.length) {
            return { ok: false, error: 'ambiguous', candidates: r.candidates };
        } else if (!input.brand && !input.name) {
            return { ok: false, error: 'not_found' };
        }
    }

    if (!item) {
        const brand = clip(input.brand, 80), name = clip(input.name || input.productName, 120);
        if (!name) return { ok: false, error: 'missing_name' };
        const ingredients = parseIngredientText(input.ingredientsText);
        const cat = input.category ? (normalizeCategory(input.category) || clip(input.category, 40)) : undefined;
        item = {
            id: '', brand: brand || '—', name, category: cat, source: input.source || 'manual',
            ingredients: ingredients.length ? ingredients : undefined,
            actives: ingredients.length ? [...detectActives(ingredients).keys()] : [],
            price: null, quantity: input.quantity || null,
            status, verdict, note: input.note ? clip(input.note, 300) : undefined,
            addedAt: now, updatedAt: now, startedAt: status === 'using' ? now : undefined,
        };
    }

    // Duplicate → update the existing row instead of creating a second one.
    const dupe = items.find(i => (item!.productId && i.productId === item!.productId) || sameName(i, item!.brand, item!.name));
    if (dupe) {
        const merged: CabinetItem = { ...dupe, status, verdict: verdict ?? dupe.verdict, note: item.note ?? dupe.note, updatedAt: now,
            startedAt: status === 'using' ? (dupe.startedAt || now) : dupe.startedAt };
        const p = via(userId);
        if (p) { p.update(userId, dupe.id, { status, verdict: merged.verdict, note: merged.note }); }
        else saveItems(userId, items.map(i => (i.id === dupe.id ? merged : i)));
        return { ok: true, item: merged, created: false, overlap: [], duplicateOf: dupe };
    }

    if (items.length >= MAX_ITEMS) return { ok: false, error: 'cabinet_full' };
    const pv = via(userId);
    item.id = pv ? pv.newId() : `cab_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const overlap = overlapWithCabinet(items, item.actives, { exceptProductId: item.productId });
    if (pv) pv.add(userId, item); else saveItems(userId, [...items, item]);
    return { ok: true, item, created: true, overlap };
}

export interface UpdatePatch { status?: CabinetStatus; verdict?: CabinetVerdict | null; note?: string; reason?: string }

export function updateItem(userId: string, id: string, patch: UpdatePatch): CabinetItem | null {
    const pv = via(userId);
    if (pv) {
        const cur = pv.list(userId).find(i => i.id === id);
        if (!cur) return null;
        const p: Partial<CabinetItem> = {};
        if (patch.status && STATUSES.includes(patch.status)) p.status = patch.status;
        if (patch.verdict === null) p.verdict = undefined; else if (patch.verdict && VERDICTS.includes(patch.verdict)) p.verdict = patch.verdict;
        if (patch.note !== undefined) p.note = clip(patch.note, 300) || undefined;
        if (patch.reason !== undefined) p.reason = clip(patch.reason, 120) || undefined;
        return pv.update(userId, id, p);
    }
    if (!isValidUserId(userId)) return null;
    const items = listItems(userId);
    const cur = items.find(i => i.id === id);
    if (!cur) return null;
    const next: CabinetItem = { ...cur, updatedAt: new Date().toISOString() };
    if (patch.status && STATUSES.includes(patch.status)) {
        next.status = patch.status;
        if (patch.status === 'using' && !next.startedAt) next.startedAt = next.updatedAt;
    }
    if (patch.verdict === null) delete next.verdict;
    else if (patch.verdict && VERDICTS.includes(patch.verdict)) next.verdict = patch.verdict;
    if (patch.note !== undefined) next.note = clip(patch.note, 300) || undefined;
    if (patch.reason !== undefined) next.reason = clip(patch.reason, 120) || undefined;
    saveItems(userId, items.map(i => (i.id === id ? next : i)));
    return next;
}

export function removeItem(userId: string, id: string): boolean {
    const pv = via(userId);
    if (pv) return pv.remove(userId, id);
    if (!isValidUserId(userId)) return false;
    const items = listItems(userId);
    if (!items.some(i => i.id === id)) return false;
    saveItems(userId, items.filter(i => i.id !== id));
    return true;
}

/** Finds an item by id, product id, or (fuzzy) name — for chat commands like "I finished the Venus cleanser". */
export function findItem(items: CabinetItem[], ref: { id?: string; productId?: string; text?: string }): CabinetItem | null {
    if (ref.id) { const x = items.find(i => i.id === ref.id); if (x) return x; }
    if (ref.productId) { const x = items.find(i => i.productId === ref.productId); if (x) return x; }
    const t = normalizeArabicText(ref.text || '');
    if (t.length >= 3) {
        const hits = items.filter(i => {
            const full = normalizeArabicText(`${i.brand} ${i.name}`);
            return full.includes(t) || t.includes(normalizeArabicText(i.name)) && normalizeArabicText(i.name).length >= 4;
        });
        if (hits.length === 1) return hits[0];
    }
    return null;
}

// ═════════════════ pure logic (no I/O) ═════════════════════════════════════
export interface OverlapNote { item: CabinetItem; sharedActives: string[]; sameProduct: boolean }

/** Owned products (still in use / wishlisted excluded) that share key actives with a candidate. */
export function overlapWithCabinet(items: CabinetItem[], candidateActives: string[], opts: { exceptProductId?: string; includeStatuses?: CabinetStatus[] } = {}): OverlapNote[] {
    const statuses = opts.includeStatuses || ['using'];
    const out: OverlapNote[] = [];
    for (const it of items) {
        if (!statuses.includes(it.status)) continue;
        if (opts.exceptProductId && it.productId === opts.exceptProductId) continue;
        const shared = candidateActives.filter(a => it.actives.includes(a));
        if (shared.length > 0) out.push({ item: it, sharedActives: shared, sameProduct: false });
    }
    return out.sort((a, b) => b.sharedActives.length - a.sharedActives.length);
}

/** Does the user already own THIS product? */
export function ownsProduct(items: CabinetItem[], productId: string): CabinetItem | null {
    return items.find(i => i.productId === productId && (i.status === 'using' || i.status === 'finished')) || null;
}

const ESSENTIALS: Array<{ key: string; aliases: string[] }> = [
    { key: 'cleanser', aliases: ['cleanser', 'face_wash', 'body_wash'] },
    { key: 'lotion_cream', aliases: ['lotion_cream', 'moisturizer', 'cream', 'lotion'] },
    { key: 'sunscreen', aliases: ['sunscreen', 'spf'] },
];

/** Essential categories (cleanser / moisturizer / sunscreen) the user is NOT currently using. */
export function cabinetGaps(items: CabinetItem[]): string[] {
    const using = items.filter(i => i.status === 'using').map(i => (i.category || '').toLowerCase());
    return ESSENTIALS
        .filter(e => !using.some(c => e.aliases.some(a => c === a || c.includes(a))))
        .map(e => e.key);
}

export interface DislikeInsights {
    items: CabinetItem[];
    /** potent/irritant concepts shared by 2+ disliked products — a pattern worth mentioning */
    commonConcepts: string[];
}
const IRRITANT_KEYS = ['retinoid', 'aha', 'bha', 'benzoyl', 'vitc', 'fragrance', 'alcohol', 'essential_oil', 'sulfate'];

export function dislikeInsights(items: CabinetItem[]): DislikeInsights {
    const bad = items.filter(i => i.verdict === 'didnt_suit' || i.status === 'stopped');
    const counts = new Map<string, number>();
    for (const it of bad) {
        const keys = new Set<string>(it.actives.filter(a => IRRITANT_KEYS.includes(a)));
        for (const c of CONCEPTS) {
            if (IRRITANT_KEYS.includes(c.key) && it.ingredients && matchConceptInList(c, it.ingredients).length) keys.add(c.key);
        }
        keys.forEach(k => counts.set(k, (counts.get(k) || 0) + 1));
    }
    return { items: bad, commonConcepts: [...counts.entries()].filter(([, n]) => n >= 2).map(([k]) => k) };
}

const tokenSet = (list: string[]) => new Set(list.slice(0, 20).map(i => normalizeArabicText(i)).filter(Boolean));

/** INCI-list similarity (Jaccard over the first 20 entries) — to avoid "another one just like the one that burned me". */
export function similarity(a: string[], b: string[]): number {
    const A = tokenSet(a), B = tokenSet(b);
    if (!A.size || !B.size) return 0;
    let inter = 0; A.forEach(x => { if (B.has(x)) inter++; });
    return inter / (A.size + B.size - inter);
}

export function dislikedIngredientLists(items: CabinetItem[]): string[][] {
    return items.filter(i => (i.verdict === 'didnt_suit' || i.status === 'stopped') && i.ingredients?.length).map(i => i.ingredients!);
}

export function similarToDisliked(candidateList: string[], disliked: string[][], threshold = 0.7): boolean {
    return disliked.some(d => similarity(candidateList, d) >= threshold);
}

export interface CabinetSummary {
    total: number;
    byStatus: Record<CabinetStatus, number>;
    gaps: string[];
    /** summed catalog prices of items in use; unknown prices are counted, never guessed */
    valueInUse: { min: number; max: number; currency: string; unpriced: number };
    activesInUse: string[];
    dislikes: DislikeInsights;
}

export function summarizeCabinet(items: CabinetItem[]): CabinetSummary {
    const byStatus: Record<CabinetStatus, number> = { using: 0, finished: 0, wishlist: 0, stopped: 0 };
    let min = 0, max = 0, unpriced = 0;
    const actives = new Set<string>();
    for (const it of items) {
        byStatus[it.status]++;
        if (it.status !== 'using') continue;
        it.actives.forEach(a => actives.add(a));
        if (it.price && (it.price.min !== undefined || it.price.max !== undefined)) {
            min += it.price.min ?? it.price.max ?? 0;
            max += it.price.max ?? it.price.min ?? 0;
        } else unpriced++;
    }
    return {
        total: items.length, byStatus, gaps: cabinetGaps(items),
        valueInUse: { min, max, currency: 'DZD', unpriced },
        activesInUse: [...actives].map(k => getConcept(k)?.label.ar || k),
        dislikes: dislikeInsights(items),
    };
}

/** Catalog product IDs of items in use — one per category — to seed a routine "from what I own". */
export function routineSeedFromCabinet(items: CabinetItem[]): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const it of items) {
        if (it.status !== 'using' || !it.productId) continue;
        const cat = (it.category || it.productId).toLowerCase();
        if (seen.has(cat)) continue;
        seen.add(cat);
        ids.push(it.productId);
    }
    return ids;
}
