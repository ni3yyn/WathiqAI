/**
 * Opt-in cross-session memory — durable facts only.
 *
 * Privacy design (deliberately boring and strict):
 *   • OFF unless LONGTERM_MEMORY=true on the server AND the client sends
 *     { userId, rememberMe: true } for that request (explicit, per-request consent).
 *   • Stores ONLY structured durable facts: skin/hair type, allergies, avoided
 *     ingredients, budget ceiling, preferred country, language. Never message
 *     text, product history or free-form content.
 *   • The raw userId is never written: rows are keyed by sha256(salt + userId).
 *   • File mode 0600, entries expire after LONGTERM_TTL_DAYS (default 180).
 *   • The user can erase everything at any time: POST /api/memory/forget, or by
 *     saying "forget me" / "انسَ كل شيء" / "oublie-moi" in chat.
 *
 * Storage: data/longterm.jsonl — append-only rows {h, t, facts, deleted?};
 * the last row per hash wins; the file is compacted when it grows.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { UserProfile } from './sessionMemory';

export const LONGTERM_ENABLED = process.env.LONGTERM_MEMORY === 'true';
const FILE = process.env.LONGTERM_FILE || path.join(process.cwd(), 'data', 'longterm.jsonl');
const SALT = process.env.LONGTERM_SALT || 'wathiq-longterm-v1';
const TTL_MS = parseInt(process.env.LONGTERM_TTL_DAYS || '180', 10) * 24 * 3600 * 1000;
const COMPACT_AT_LINES = 1500;

export interface LongtermFacts {
    skinType?: string;
    hairType?: string;
    allergies?: string[];
    avoidIngredients?: string[];
    budgetMax?: number;
    country?: string;
    language?: 'ar' | 'fr' | 'en';
    register?: 'darija' | 'msa';
    city?: string;
    climateZone?: 'coastal_humid' | 'arid_saharan' | 'steppe_highland' | 'tell_temperate';
}

interface Row { h: string; t: number; facts?: LongtermFacts; deleted?: boolean }

export function userHash(userId: string): string {
    return crypto.createHash('sha256').update(`${SALT}:${userId}`).digest('hex').slice(0, 32);
}

// ── tiny mtime-keyed cache ───────────────────────────────────────────────────
let cache: Map<string, Row> | null = null;
let cacheMtime = -1;
let lineCount = 0;

function readAll(): Map<string, Row> {
    try {
        if (!fs.existsSync(FILE)) { cache = new Map(); cacheMtime = -1; lineCount = 0; return cache; }
        const mtime = fs.statSync(FILE).mtimeMs;
        if (cache && cacheMtime === mtime) return cache;
        const map = new Map<string, Row>();
        const lines = fs.readFileSync(FILE, 'utf-8').split('\n').filter(Boolean);
        lineCount = lines.length;
        const cutoff = Date.now() - TTL_MS;
        for (const line of lines) {
            try {
                const row: Row = JSON.parse(line);
                if (!row.h) continue;
                if (row.deleted) map.delete(row.h);
                else if (row.t >= cutoff && row.facts) map.set(row.h, row);
            } catch { /* skip corrupt line */ }
        }
        cache = map; cacheMtime = mtime;
        return map;
    } catch (e: any) {
        console.warn('[LONGTERM] read failed:', e.message);
        return cache || new Map();
    }
}

function writeAll(map: Map<string, Row>) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const body = [...map.values()].map(r => JSON.stringify(r)).join('\n');
    fs.writeFileSync(FILE, body ? body + '\n' : '', { mode: 0o600 });
    cache = null; cacheMtime = -1;
}

// ── sanitizing ───────────────────────────────────────────────────────────────
const cleanList = (xs: any): string[] =>
    Array.from(new Set((Array.isArray(xs) ? xs : []).map(x => String(x).trim()).filter(x => x.length >= 2 && x.length <= 40))).slice(0, 10);

export function extractDurableFacts(profile: UserProfile): LongtermFacts {
    const f: LongtermFacts = {};
    if (profile.skinType) f.skinType = profile.skinType.slice(0, 40);
    if (profile.hairType) f.hairType = profile.hairType.slice(0, 40);
    const al = cleanList(profile.allergies); if (al.length) f.allergies = al;
    const av = cleanList(profile.avoidIngredients); if (av.length) f.avoidIngredients = av;
    if (profile.budgetMax && profile.budgetMax > 0 && profile.budgetMax < 1_000_000) f.budgetMax = Math.round(profile.budgetMax);
    if (profile.country) f.country = profile.country.slice(0, 40);
    if (profile.language) f.language = profile.language;
    if (profile.register) f.register = profile.register;
    if (profile.city) f.city = profile.city.slice(0, 40);
    if (profile.climateZone) f.climateZone = profile.climateZone;
    return f;
}

const sameFacts = (a?: LongtermFacts, b?: LongtermFacts) => JSON.stringify(a || {}) === JSON.stringify(b || {});

// ── public API ───────────────────────────────────────────────────────────────
export function loadFacts(userId: string): LongtermFacts | null {
    if (!LONGTERM_ENABLED || !userId) return null;
    const row = readAll().get(userHash(userId));
    return row?.facts && Object.keys(row.facts).length ? row.facts : null;
}

export function saveFacts(userId: string, facts: LongtermFacts): void {
    if (!LONGTERM_ENABLED || !userId) return;
    try {
        const h = userHash(userId);
        const existing = readAll().get(h);
        if (sameFacts(existing?.facts, facts)) return;            // nothing new to remember
        if (Object.keys(facts).length === 0) return;
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.appendFileSync(FILE, JSON.stringify({ h, t: Date.now(), facts } as Row) + '\n', { mode: 0o600 });
        cache = null; cacheMtime = -1;
        if (++lineCount > COMPACT_AT_LINES) writeAll(readAll());
    } catch (e: any) {
        console.warn('[LONGTERM] save failed (non-fatal):', e.message);
    }
}

/** Hard-deletes everything stored for this user. Works even if memory is currently disabled. */
export function forgetUser(userId: string): boolean {
    if (!userId) return false;
    try {
        if (!fs.existsSync(FILE)) return false;
        const h = userHash(userId);
        const map = new Map(readAll());
        const had = map.delete(h);
        writeAll(map);
        return had;
    } catch (e: any) {
        console.warn('[LONGTERM] forget failed:', e.message);
        return false;
    }
}

export const FORGET_RE = /انسَ?\s*(?:كل\s*شيء|كل\s*ما|بياناتي|تفضيلاتي)|امسح\s*(?:بياناتي|ذاكرتي|تفضيلاتي)|forget\s*(?:me|everything|my\s*(?:data|preferences))|delete\s*my\s*(?:data|preferences|memory)|oublie[- ]?moi|efface\s*mes\s*(?:donn[ée]es|pr[ée]f[ée]rences)/i;

/** Applies saved facts WITHOUT overriding anything the user already said this session. */
export function applyFactsToProfile(profile: UserProfile, facts: LongtermFacts): void {
    if (!profile.skinType && facts.skinType) profile.skinType = facts.skinType;
    if (!profile.hairType && facts.hairType) profile.hairType = facts.hairType;
    if (facts.allergies?.length) profile.allergies = Array.from(new Set([...profile.allergies, ...facts.allergies]));
    if (facts.avoidIngredients?.length) profile.avoidIngredients = Array.from(new Set([...profile.avoidIngredients, ...facts.avoidIngredients]));
    if (!profile.budgetMax && facts.budgetMax) profile.budgetMax = facts.budgetMax;
    if (!profile.country && facts.country) profile.country = facts.country;
    if (!profile.language && facts.language) profile.language = facts.language;
    if (!profile.register && facts.register) profile.register = facts.register;
    if (!profile.climateZone && facts.climateZone) { profile.climateZone = facts.climateZone; profile.city = profile.city || facts.city; }
}

export function describeFacts(lang: 'ar' | 'fr' | 'en', f: LongtermFacts): string {
    const j = lang === 'ar' ? '، ' : ', ';
    const parts: string[] = [];
    if (f.skinType) parts.push(f.skinType);
    if (f.hairType) parts.push(f.hairType);
    if (f.allergies?.length) parts.push(({ ar: 'حساسية: ', fr: 'allergies : ', en: 'allergies: ' })[lang] + f.allergies.join(j));
    if (f.avoidIngredients?.length) parts.push(({ ar: 'تتجنب: ', fr: 'évite : ', en: 'avoids: ' })[lang] + f.avoidIngredients.join(j));
    if (f.budgetMax) parts.push(({ ar: `ميزانية حتى ${f.budgetMax} دج`, fr: `budget ≤ ${f.budgetMax} DA`, en: `budget ≤ ${f.budgetMax} DZD` })[lang]);
    return parts.join(j);
}

export function welcomeBackNote(lang: 'ar' | 'fr' | 'en', f: LongtermFacts): string {
    const d = describeFacts(lang, f);
    if (!d) return '';
    return ({
        ar: `أهلاً بعودتك! أطبّق تفضيلاتك المحفوظة (${d}) — قل لي إن تغيّر شيء.`,
        fr: `Content de vous revoir ! J'applique vos préférences enregistrées (${d}) — dites-moi si quelque chose a changé.`,
        en: `Welcome back! I'm applying your saved preferences (${d}) — tell me if anything changed.`,
    })[lang];
}
