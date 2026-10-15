/**
 * What the agent knows about a signed-in user, read from the app's own Firestore:
 *
 *   profiles/{uid}                      settings{name,gender,skinType,scalpType,language,goals[],conditions[],allergies[]}, routines{am,pm}
 *   profiles/{uid}/savedProducts/{id}   productName, productImage, marketingClaims[], productType, analysisStatus, createdAt, analysisData{…OilGuard result…}
 *
 * This module (1) maps/compacts those documents into a small `UserContext`
 * (push tokens and raw analysis blobs are NEVER kept), and (2) serves it from a
 * RAM cache: LRU, fresh/stale windows, stale-while-revalidate, single-flight loads,
 * and entries that die with the Firebase token. Nothing here writes to Firestore.
 */
import crypto from 'crypto';
import type { AuthIdentity } from './verifyToken';
import type { FirestoreClient, RestDoc } from './firestoreRest';
import type { AuthConfig } from './config';

// ═════════════════ types ═════════════════════════════════════════════════════
export type Gender = 'female' | 'male';
export type Lang = 'ar' | 'fr' | 'en';

export interface ShelfEntry {
    docId: string;
    name: string;
    type?: string;                 // the app's productType id
    claims: string[];
    image?: string;
    createdAt?: number;            // epoch ms
    analysisStatus?: string;
    score?: number;                // oilGuardScore
    verdict?: string;
    safety?: number;
    efficacy?: number;
    ingredients: string[];         // detected + unknown INCI names (capped)
    alerts: string[];              // user-specific alerts (capped)
    /** catalog match resolved by the agent (strong matches only) */
    match?: { productId: string; brand: string; name: string; priceMin?: number; priceMax?: number; currency?: string; category?: string } | null;
}

export interface UserContext {
    uid: string;
    version: string;               // hash of the content; changes when profile/shelf change
    fetchedAt: number;
    profile: {
        name?: string;
        gender?: Gender;
        language?: Lang;
        skinType?: string;         // raw id as stored by the app
        scalpType?: string;
        goals: string[];
        conditions: string[];
        allergies: string[];
        onboardingComplete?: boolean;
    };
    /** EXACTLY what the app sends to evaluate.js (raw ids) so agent scores equal in-app scores */
    backendProfile: { allergies: string[]; conditions: string[]; skinType?: string; scalpType?: string };
    routines: { am: RoutineStepLite[]; pm: RoutineStepLite[] };
    shelf: ShelfEntry[];
    degraded?: boolean;            // true when Firestore could not be read (identity is still valid)
}

export interface RoutineStepLite { id?: string; name?: string; productName?: string; productId?: string; type?: string }

// ═════════════════ option mapping (ids → meaning) ════════════════════════════
const low = (s: any) => String(s ?? '').trim().toLowerCase();

const SKIN: Array<[RegExp, string]> = [
    [/oily|gras|دهن/, 'بشرة دهنية'], [/dry|s[èe]che|جاف/, 'بشرة جافة'],
    [/combin|mixed|mixte|مختلط/, 'بشرة مختلطة'], [/sensitiv|sensible|حساس/, 'بشرة حساسة'], [/normal|عادي/, 'بشرة عادية'],
];
const SCALP: Array<[RegExp, string]> = [
    [/oily|gras|دهن/, 'فروة دهنية'], [/dry|s[èe]che|جاف/, 'فروة جافة'], [/sensitiv|sensible|حساس/, 'فروة حساسة'],
    [/dandruff|pellic|قشرة/, 'فروة بقشرة'], [/normal|عادي/, 'فروة عادية'],
];
/** app allergy/condition ids → the agent's canonical avoid tokens (unknown ids pass through lowercased) */
const AVOID: Array<[RegExp, string]> = [
    [/fragrance|parfum|perfume|عطر/, 'fragrance'], [/alcohol|كحول/, 'alcohol'], [/paraben|بارابين/, 'paraben'],
    [/sulfate|sulphate|sls|كبريتات|سلفات/, 'sulfate'], [/silicone|سيليكون/, 'silicone'],
    [/essential.?oil|زيوت.?عطرية/, 'essential oil'], [/coconut|جوز.?الهند/, 'coconut'],
];

export function mapSkinLabel(id?: string): string | undefined {
    const s = low(id); if (!s) return undefined;
    return SKIN.find(([re]) => re.test(s))?.[1];
}
export function mapScalpLabel(id?: string): string | undefined {
    const s = low(id); if (!s) return undefined;
    return SCALP.find(([re]) => re.test(s))?.[1];
}
export function mapAvoidToken(id: string): string {
    const s = low(id);
    return AVOID.find(([re]) => re.test(s))?.[1] || s;
}
export function mapGender(g: any): Gender | undefined {
    const s = low(g);
    if (/^(أنثى|انثى|female|f|femme|woman)$/.test(s)) return 'female';
    if (/^(ذكر|male|m|homme|man)$/.test(s)) return 'male';
    return undefined;
}
const strArr = (v: any): string[] => (Array.isArray(v) ? v.map(x => String(x)).filter(Boolean).slice(0, 40) : []);
const lang = (v: any): Lang | undefined => (v === 'ar' || v === 'fr' || v === 'en' ? v : undefined);

/** the app's productType id → the agent's category vocabulary */
export function mapProductType(t?: string): string | undefined {
    const s = low(t); if (!s) return undefined;
    if (/cleans|wash|غسول|nettoy/.test(s)) return 'cleanser';
    if (/moistur|cream|lotion|مرطب|hydrat/.test(s)) return 'lotion_cream';
    if (/sun|spf|واقي|solaire/.test(s)) return 'sunscreen';
    if (/serum|سيروم|sérum/.test(s)) return 'skin_serum';
    if (/toner|تونر|tonique/.test(s)) return 'toner';
    if (/mask|ماسك|masque/.test(s)) return 'mask';
    if (/shampoo|شامبو|shampoing/.test(s)) return 'shampoo';
    return s;
}

// ═════════════════ compaction ════════════════════════════════════════════════
const MAX_INGREDIENTS = 150;

function ingredientNames(list: any): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const it of list) {
        const n = typeof it === 'string' ? it : (it?.name || it?.inci || it?.id || '');
        if (n && typeof n === 'string') out.push(n.trim());
        if (out.length >= MAX_INGREDIENTS) break;
    }
    return out;
}

export function compactSavedProduct(doc: RestDoc): ShelfEntry | null {
    const d = doc.data;
    const name = typeof d.productName === 'string' ? d.productName.trim() : '';
    if (!name) return null;
    const a = d.analysisData && typeof d.analysisData === 'object' ? d.analysisData : {};
    const ingredients = Array.from(new Set([...ingredientNames(a.detected_ingredients), ...ingredientNames(a.unknown_ingredients)])).slice(0, MAX_INGREDIENTS);
    const alerts = (Array.isArray(a.user_specific_alerts) ? a.user_specific_alerts : [])
        .map((x: any) => (typeof x === 'string' ? x : x?.message || x?.text || '')).filter(Boolean).slice(0, 3).map((s: string) => s.slice(0, 200));
    return {
        docId: doc.id,
        name: name.slice(0, 160),
        type: typeof d.productType === 'string' ? d.productType : undefined,
        claims: strArr(d.marketingClaims).slice(0, 8),
        image: typeof d.productImage === 'string' && /^https:\/\//.test(d.productImage) ? d.productImage.slice(0, 400) : undefined,
        createdAt: typeof d.createdAt === 'number' ? d.createdAt : undefined,
        analysisStatus: typeof d.analysisStatus === 'string' ? d.analysisStatus : undefined,
        score: typeof a.oilGuardScore === 'number' ? a.oilGuardScore : undefined,
        verdict: typeof a.finalVerdict === 'string' ? a.finalVerdict.slice(0, 200) : undefined,
        safety: typeof a.safety?.score === 'number' ? a.safety.score : undefined,
        efficacy: typeof a.efficacy?.score === 'number' ? a.efficacy.score : undefined,
        ingredients, alerts, match: undefined,
    };
}

function compactRoutine(list: any): RoutineStepLite[] {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 12).map((s: any) => {
        if (typeof s === 'string') return { name: s.slice(0, 80) };
        const pick = (k: string) => (typeof s?.[k] === 'string' ? s[k].slice(0, 100) : undefined);
        return { id: pick('id'), name: pick('name') || pick('title') || pick('stepName'), productName: pick('productName') || pick('product'), productId: pick('productId'), type: pick('type') || pick('category') };
    });
}

export function buildUserContext(uid: string, profileDoc: RestDoc | null, shelfDocs: RestDoc[], now = Date.now()): UserContext {
    const p = profileDoc?.data || {};
    const s = (p.settings && typeof p.settings === 'object') ? p.settings : {};
    const profile = {
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : undefined,
        gender: mapGender(s.gender),
        language: lang(s.language),
        skinType: typeof s.skinType === 'string' ? s.skinType : undefined,
        scalpType: typeof s.scalpType === 'string' ? s.scalpType : undefined,
        goals: strArr(s.goals), conditions: strArr(s.conditions), allergies: strArr(s.allergies),
        onboardingComplete: p.onboardingComplete === true,
    };
    const shelf = shelfDocs.map(compactSavedProduct).filter((x): x is ShelfEntry => !!x)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 200);
    const routines = { am: compactRoutine(p.routines?.am), pm: compactRoutine(p.routines?.pm) };
    const backendProfile = {
        allergies: profile.allergies, conditions: profile.conditions,
        skinType: profile.skinType, scalpType: profile.scalpType,
    };
    const version = crypto.createHash('sha1').update(JSON.stringify({ profile, routines, shelf: shelf.map(x => [x.docId, x.score, x.name]) })).digest('hex').slice(0, 12);
    return { uid, version, fetchedAt: now, profile, backendProfile, routines, shelf };
}

// ═════════════════ cache service ═════════════════════════════════════════════
export const PROFILE_MASK = ['settings', 'routines', 'onboardingComplete'];            // NOT the push tokens
export const SHELF_MASK = [
    'productName', 'productImage', 'marketingClaims', 'productType', 'analysisStatus', 'createdAt',
    'analysisData.oilGuardScore', 'analysisData.finalVerdict', 'analysisData.safety', 'analysisData.efficacy',
    'analysisData.detected_ingredients', 'analysisData.unknown_ingredients', 'analysisData.user_specific_alerts',
];

export type ShelfMatcher = (entries: ShelfEntry[]) => Promise<void>;

interface Entry { ctx: UserContext; fetchedAt: number; hardExpiry: number }

export interface UserDataServiceOptions {
    config: Pick<AuthConfig, 'freshMs' | 'staleMs' | 'cacheMax'>;
    firestore: FirestoreClient;
    matcher?: ShelfMatcher;
    now?: () => number;
    log?: (msg: string) => void;
}

export class UserDataService {
    private cache = new Map<string, Entry>();
    private inflight = new Map<string, Promise<UserContext | null>>();
    private recentAuth = new Map<string, number>();       // uid → expiry (ms): "this uid authenticated recently"
    private now: () => number;
    private sweeper?: NodeJS.Timeout;
    stats = { hits: 0, stale: 0, loads: 0, errors: 0, evictions: 0 };

    constructor(private o: UserDataServiceOptions) {
        this.now = o.now || Date.now;
        this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
        this.sweeper.unref?.();
    }

    stop() { if (this.sweeper) clearInterval(this.sweeper); }

    /** mark the uid as authenticated until the token's expiry (even if Firestore is down) */
    markAuthenticated(uid: string, expiresAtMs: number) { this.recentAuth.set(uid, expiresAtMs); }
    isKnown(uid: string): boolean {
        const e = this.recentAuth.get(uid);
        if (e && e > this.now()) return true;
        const c = this.cache.get(uid);
        return !!c && c.hardExpiry > this.now();
    }

    /** synchronous read for the agent turn (never triggers I/O) */
    peek(uid: string): UserContext | null {
        const e = this.cache.get(uid);
        if (!e || e.hardExpiry <= this.now()) return null;
        return e.ctx;
    }

    purge(uid: string) { this.cache.delete(uid); this.inflight.delete(uid); this.recentAuth.delete(uid); }

    async get(identity: AuthIdentity, token: string, opts: { force?: boolean } = {}): Promise<UserContext | null> {
        const uid = identity.uid;
        const tokenExpiryMs = identity.expiresAt * 1000;
        this.markAuthenticated(uid, tokenExpiryMs);

        const e = this.cache.get(uid);
        const t = this.now();
        if (e && e.hardExpiry > t && !opts.force) {
            const age = t - e.fetchedAt;
            if (age < this.o.config.freshMs) { this.stats.hits++; this.touch(uid, e); return e.ctx; }
            // stale but usable: answer now, refresh in the background with THIS request's token
            this.stats.stale++; this.touch(uid, e);
            void this.load(identity, token).catch(() => undefined);
            return e.ctx;
        }
        const loaded = await this.load(identity, token);
        if (loaded) return loaded;
        // load failed: fall back to whatever (even stale) data we still have
        const fallback = this.cache.get(uid);
        if (fallback && fallback.hardExpiry > this.now()) return fallback.ctx;
        return null;
    }

    private touch(uid: string, e: Entry) { this.cache.delete(uid); this.cache.set(uid, e); }

    private load(identity: AuthIdentity, token: string): Promise<UserContext | null> {
        const uid = identity.uid;
        const running = this.inflight.get(uid);
        if (running) return running;                                   // single-flight
        const p = (async () => {
            this.stats.loads++;
            try {
                const [profileDoc, shelfDocs] = await Promise.all([
                    this.o.firestore.getDocument(`profiles/${uid}`, token, PROFILE_MASK),
                    this.o.firestore.listDocuments(`profiles/${uid}/savedProducts`, token, { maskPaths: SHELF_MASK, pageSize: 100, maxPages: 2, orderBy: 'createdAt desc' }),
                ]);
                const ctx = buildUserContext(uid, profileDoc, shelfDocs, this.now());
                // carry over catalog matches already resolved for unchanged docs
                const prev = this.cache.get(uid)?.ctx;
                if (prev) {
                    const byId = new Map(prev.shelf.map(s => [`${s.docId}|${s.name}`, s.match]));
                    for (const s of ctx.shelf) { const m = byId.get(`${s.docId}|${s.name}`); if (m !== undefined) s.match = m; }
                }
                if (this.o.matcher) { try { await this.o.matcher(ctx.shelf.filter(s => s.match === undefined)); } catch (e: any) { this.o.log?.(`shelf match failed: ${e.message}`); } }
                const t = this.now();
                const entry: Entry = { ctx, fetchedAt: t, hardExpiry: Math.min(t + this.o.config.staleMs, identity.expiresAt * 1000) };
                this.cache.delete(uid); this.cache.set(uid, entry);
                this.evict();
                return ctx;
            } catch (e: any) {
                this.stats.errors++;
                this.o.log?.(`user data load failed (${e?.status ?? e?.message})`);
                return null;
            } finally {
                this.inflight.delete(uid);
            }
        })();
        this.inflight.set(uid, p);
        return p;
    }

    private evict() {
        while (this.cache.size > this.o.config.cacheMax) {
            const oldest = this.cache.keys().next().value as string;
            this.cache.delete(oldest); this.stats.evictions++;
        }
    }
    private sweep() {
        const t = this.now();
        for (const [uid, e] of this.cache) if (e.hardExpiry <= t) this.cache.delete(uid);
        for (const [uid, exp] of this.recentAuth) if (exp <= t) this.recentAuth.delete(uid);
    }
    size() { return this.cache.size; }
}
