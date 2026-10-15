/**
 * The agent's view of a SIGNED-IN user.
 *
 * The auth layer (src/auth) loads `UserContext` into RAM before each turn; the agent
 * only ever reads it synchronously through this module — it never does I/O for it and
 * never sees a token. Decoupled through a resolver so agent code has no dependency on
 * Firebase.
 */
import type { SessionState } from './sessionMemory';
import type { UserContext } from '../auth/userData';
import { mapSkinLabel, mapScalpLabel, mapAvoidToken } from '../auth/userData';

export type UserContextResolver = (uid: string) => UserContext | null;
export interface PrefsStore { get(uid: string): { register?: 'darija' | 'msa'; city?: string; climateZone?: string }; set(uid: string, p: { register?: 'darija' | 'msa'; city?: string; climateZone?: string }): void }

let resolver: UserContextResolver = () => null;
let prefs: PrefsStore | null = null;
export const setUserContextResolver = (fn: UserContextResolver) => { resolver = fn; };
export const setPrefsStore = (p: PrefsStore | null) => { prefs = p; };
export const getUserContext = (uid: string | undefined): UserContext | null => (uid ? resolver(uid) : null);
export const getUserPrefs = (uid: string) => prefs?.get(uid) || {};
export const saveUserPrefs = (uid: string, p: Parameters<PrefsStore['set']>[1]) => { try { prefs?.set(uid, p); } catch { /* non-fatal */ } };

/**
 * Applies the app profile to the session profile.
 * The app profile is the BASELINE; anything the user said in chat this session ("I'm
 * dry now", "I'm pregnant") overrides it for the session and is never written back.
 * Re-applied only when the underlying data changed (ctx.version), and a field is only
 * refreshed if chat has not changed it since the last baseline.
 */
export function applyUserContext(state: SessionState, ctx: UserContext): boolean {
    if (state.authVersion === ctx.version) return false;
    const p: any = state.profile;
    const base: Record<string, any> = {
        name: ctx.profile.name,
        gender: ctx.profile.gender,
        language: ctx.profile.language,
        skinType: mapSkinLabel(ctx.profile.skinType),
        hairType: mapScalpLabel(ctx.profile.scalpType),
    };
    const prev = state.authBaseline || {};
    for (const k of Object.keys(base)) {
        if (base[k] === undefined) continue;
        if (p[k] === undefined || p[k] === prev[k]) p[k] = base[k];          // chat did not override → follow the app
    }
    // list-like fields are unions (chat can add, the app's values are always included)
    const allergyTokens = ctx.profile.allergies.map(mapAvoidToken);
    p.allergies = Array.from(new Set([...(p.allergies || []).filter((a: string) => !(prev.allergyTokens || []).includes(a)), ...allergyTokens]));
    p.conditions = ctx.profile.conditions;
    p.goals = ctx.profile.goals;
    base.allergyTokens = allergyTokens;
    state.authBaseline = base;
    state.authVersion = ctx.version;
    return true;
}

/**
 * The `user_profile` payload for evaluate.js. For signed-in users this is EXACTLY what
 * the app itself sends (raw ids), so the agent's scores equal the in-app scores; the
 * session's chat-stated extras are appended.
 */
export function backendUserProfile(state: SessionState): { allergies: string[]; conditions: string[]; skinType?: string; scalpType?: string } {
    const ctx = getUserContext(state.userId);
    if (!ctx || !state.authenticated) {
        return {
            allergies: [...state.profile.allergies, ...state.profile.avoidIngredients],
            conditions: [], skinType: state.profile.skinType,
            scalpType: state.profile.hairType && state.profile.hairType.includes('فروة') ? state.profile.hairType : undefined,
        };
    }
    const appTokens = new Set(ctx.profile.allergies.map(mapAvoidToken));
    const extras = [...state.profile.allergies, ...state.profile.avoidIngredients].filter(a => !appTokens.has(a));
    const skinOverridden = state.authBaseline && state.profile.skinType !== undefined && state.profile.skinType !== state.authBaseline.skinType;
    const scalpOverridden = state.authBaseline && state.profile.hairType !== undefined && state.profile.hairType !== state.authBaseline.hairType;
    return {
        allergies: Array.from(new Set([...ctx.backendProfile.allergies, ...extras])),
        conditions: ctx.backendProfile.conditions,
        skinType: skinOverridden ? state.profile.skinType : ctx.backendProfile.skinType,
        scalpType: scalpOverridden ? state.profile.hairType : ctx.backendProfile.scalpType,
    };
}

/** Compact [Context: …] line for the LLM path (bounded size; no PII beyond first name). */
export function buildUserContextLine(state: SessionState): string | null {
    const ctx = getUserContext(state.userId);
    if (!ctx || !state.authenticated) return null;
    const p = ctx.profile;
    const bits: string[] = [];
    const first = p.name?.split(/\s+/)[0];
    if (first) bits.push(`name "${first}"${p.gender ? ` (${p.gender}${p.gender === 'female' ? ' — use feminine Arabic forms' : ' — use masculine Arabic forms'})` : ''}`);
    if (state.profile.skinType) bits.push(`skin: ${state.profile.skinType}`);
    if (state.profile.hairType) bits.push(`scalp: ${state.profile.hairType}`);
    if (p.goals.length) bits.push(`goals: ${p.goals.slice(0, 5).join(', ')}`);
    if (p.conditions.length) bits.push(`conditions: ${p.conditions.slice(0, 5).join(', ')}`);
    if (p.allergies.length) bits.push(`avoids/allergies: ${p.allergies.slice(0, 6).join(', ')}`);
    const shelf = ctx.shelf;
    if (shelf.length) {
        const top = shelf.slice(0, 6).map(s => `${s.name.slice(0, 40)}${s.score !== undefined ? ` (${s.score})` : ''}`).join('; ');
        bits.push(`shelf: ${shelf.length} saved products — ${top}`);
    } else bits.push('shelf: empty');
    if (ctx.routines.am.length || ctx.routines.pm.length) bits.push(`routines: AM ${ctx.routines.am.length} steps, PM ${ctx.routines.pm.length} steps`);
    if (ctx.degraded) bits.push('(profile data temporarily unavailable)');
    const greet = state.turnCount <= 1 && first ? ' Greet them by first name once.' : '';
    return `[Context: SIGNED-IN user — ${bits.join(' | ')}. Use this data instead of asking what they own or their skin type; saved shelf products already have OilGuard scores computed for THEIR profile.${greet}]`.slice(0, 1100);
}

/** A shelf product with a stored analysis → the answer to "how is my X?" without re-running the backend. */
export function findShelfAnalysis(state: SessionState, nameQuery: string) {
    const ctx = getUserContext(state.userId);
    if (!ctx || !state.authenticated) return null;
    const q = nameQuery.toLowerCase().replace(/\s+/g, ' ').trim();
    if (q.length < 3) return null;
    // only an UNAMBIGUOUS match counts ("venus" alone matches many shelf items → no answer from the shelf)
    const hits = ctx.shelf.filter(s => s.score !== undefined && (s.name.toLowerCase().includes(q) || (s.name.length >= 6 && q.includes(s.name.toLowerCase()))));
    return hits.length === 1 ? hits[0] : null;
}
