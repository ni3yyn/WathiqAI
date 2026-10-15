/**
 * Routine versions & undo.
 *
 * Every build/edit of a routine is recorded, so "go back to the first routine",
 * "undo that" and "compare the two versions" work — and a swap the user regrets
 * is never a dead end.
 */
import type { SessionState } from './sessionMemory';

export interface RoutineVersion {
    n: number;                 // 1-based, stable
    label: string;             // "build", "swap step 2", "add toner"…
    at: string;
    routine: any;
}

const MAX_VERSIONS = 12;
const idsOf = (r: any): string => (r?.steps || []).map((s: any) => s.product?.id).join('|');

export function recordRoutineVersion(state: SessionState, routine: any, label: string): RoutineVersion | null {
    if (!routine?.steps?.length) return null;
    const list: RoutineVersion[] = (state as any).routineVersions || [];
    if (list.length && idsOf(list[list.length - 1].routine) === idsOf(routine)) return null;     // nothing changed
    const n = (list[list.length - 1]?.n || 0) + 1;
    const v: RoutineVersion = { n, label, at: new Date().toISOString(), routine: JSON.parse(JSON.stringify(routine)) };
    (state as any).routineVersions = [...list, v].slice(-MAX_VERSIONS);
    return v;
}

export const versionsOf = (state: SessionState): RoutineVersion[] => (state as any).routineVersions || [];

/** The version currently shown (the last one whose steps equal state.lastRoutine). */
export function currentVersion(state: SessionState): RoutineVersion | null {
    const list = versionsOf(state);
    for (let i = list.length - 1; i >= 0; i--) if (idsOf(list[i].routine) === idsOf(state.lastRoutine)) return list[i];
    return list[list.length - 1] || null;
}

export function restoreVersion(state: SessionState, n: number): RoutineVersion | null {
    const v = versionsOf(state).find(x => x.n === n);
    if (!v) return null;
    state.lastRoutine = JSON.parse(JSON.stringify(v.routine));
    return v;
}

/** Undo = go to the version before the current one. */
export function undoRoutine(state: SessionState): RoutineVersion | null {
    const list = versionsOf(state);
    const cur = currentVersion(state);
    if (!cur) return null;
    const idx = list.findIndex(x => x.n === cur.n);
    if (idx <= 0) return null;
    return restoreVersion(state, list[idx - 1].n);
}

export interface RoutineDiff {
    from: number; to: number;
    added: Array<{ step: string; product: string }>;
    removed: Array<{ step: string; product: string }>;
    swapped: Array<{ step: string; from: string; to: string }>;
    totalFrom: number; totalTo: number; totalDelta: number;
    unchanged: number;
}

const pname = (p: any) => `${p?.brand || ''} ${p?.name || ''}`.trim();

export function diffRoutines(a: RoutineVersion, b: RoutineVersion): RoutineDiff {
    const byCat = (r: any) => new Map<string, any>((r.steps || []).map((s: any) => [String(s.category), s]));
    const A = byCat(a.routine), B = byCat(b.routine);
    const added: RoutineDiff['added'] = [], removed: RoutineDiff['removed'] = [], swapped: RoutineDiff['swapped'] = [];
    let unchanged = 0;
    for (const [cat, sb] of B) {
        const sa = A.get(cat);
        if (!sa) added.push({ step: sb.stepName, product: pname(sb.product) });
        else if (sa.product?.id !== sb.product?.id) swapped.push({ step: sb.stepName, from: pname(sa.product), to: pname(sb.product) });
        else unchanged++;
    }
    for (const [cat, sa] of A) if (!B.has(cat)) removed.push({ step: sa.stepName, product: pname(sa.product) });
    const totalFrom = a.routine.totalCost || 0, totalTo = b.routine.totalCost || 0;
    return { from: a.n, to: b.n, added, removed, swapped, totalFrom, totalTo, totalDelta: totalTo - totalFrom, unchanged };
}

// ── command parsing ──────────────────────────────────────────────────────────
export interface VersionCommand { action: 'undo' | 'restore' | 'compare' | 'list'; version?: number }

export function parseVersionCommand(raw: string): VersionCommand | null {
    const m = String(raw || '').normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g, '').toLowerCase();
    if (!m || m.length > 160) return null;
    if (/قارن\s*بين\s*(?:الروتينين|النسختين|النسخ)|compare\s*(?:the\s*)?(?:two\s*)?(?:routines|versions)|comparer\s*les\s*(?:deux\s*)?(?:routines|versions)|الفرق\s*بين\s*(?:الروتينين|النسختين)/i.test(m)) return { action: 'compare' };
    const first = /الاول|الأول|الاولى|الأولى|first|premi[eè]re?|original|الاصلي|الأصلي/i.test(m);
    const prev = /السابق|القديم|اللي\s*قبل|previous|last\s*one|before|précédent|precedent|d['’]?avant/i.test(m);
    if (/(?:ارجع|رجع|رجّع|رجعني|عود|reviens?|revenir|go\s*back|back\s*to|restore|retour)/i.test(m) && /روتين|نسخ|routine|version/i.test(m)) {
        const n = m.match(/(?:رقم|number|n[°o]?|version|نسخة)\s*(\d)/i);
        if (n) return { action: 'restore', version: parseInt(n[1], 10) };
        if (first) return { action: 'restore', version: 1 };
        return { action: 'undo' };
    }
    if (/^\s*(?:undo|annuler|تراجع|الغي|الغِ)\b/i.test(m) || /(?:undo|annule)\s*(?:that|ça|la\s*modification)|تراجع\s*عن\s*(?:التعديل|الاخير|الأخير)/i.test(m)) return { action: 'undo' };
    if (prev && /روتين|routine/i.test(m) && /ارجع|رجع|back|revien/i.test(m)) return { action: 'undo' };
    if (/(?:وريني|اعرض|show|list|voir|montre)\s*(?:كل\s*)?(?:النسخ|الإصدارات|الاصدارات|versions|my\s*routines|les\s*versions)/i.test(m)) return { action: 'list' };
    return null;
}
