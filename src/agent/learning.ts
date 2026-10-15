/**
 * Community learning — "the agent learns new facts from users, safely".
 *
 * Flow (nightly worker, or on demand):
 *   staged insight ─▶ JUDGE (LLM: accept / reject / needs_review + risk + clean wording)
 *                  ─▶ EMBED (same Cohere model the retriever queries with!)
 *                  ─▶ MERGE with near-duplicates (cosine ≥ 0.92) → `supports + 1`, never a 2nd vector
 *                  ─▶ POLICY:
 *                        confident (≥0.8) & no medical/safety risk  → learned (priority 30, source "user_taught")
 *                        medical / safety / unsure                  → review queue for a human
 *                        3+ independent sessions agree (conf ≥0.6, no risk) → auto-promoted
 *
 * Learned facts are labelled "reported by users" at retrieval time and rank BELOW
 * every curated fact; safety contraindications are never auto-learned.
 *
 * All I/O (LLM judge, embedder, files) is injectable so it is fully testable offline.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { KNOWLEDGE_FILE, REVIEW_QUEUE_FILE } from '../paths';

export const AUTO_CONFIDENCE = 0.8;
export const MERGE_SIMILARITY = 0.92;
export const SUPPORT_THRESHOLD = 3;
export const SUPPORT_MIN_CONFIDENCE = 0.6;
export const COMMUNITY_PRIORITY = 30;

export interface StagedItem { id: string; category: string; insight: string; sessionId?: string }
export interface Judgement {
    id: string;
    verdict: 'accept' | 'reject' | 'needs_review';
    /** concise, neutral, third-person restatement (same language as the insight) */
    text: string;
    confidence: number;
    risk: 'none' | 'medical' | 'safety';
    reason?: string;
}
export type Judge = (items: StagedItem[]) => Promise<Judgement[]>;
export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface LearnDeps {
    judge: Judge;
    embed: Embedder;
    now?: () => Date;
    knowledgeFile?: string;
    reviewFile?: string;
}

export interface LearnResult {
    learned: string[];
    merged: string[];
    queuedForReview: string[];
    rejected: string[];
    failed: string[];
    /** staging ids that are finished (everything except `failed`) */
    processedIds: string[];
}

export interface ReviewItem {
    id: string;
    text: string;
    category: string;
    confidence: number;
    risk: 'none' | 'medical' | 'safety';
    reason?: string;
    supports: number;
    sessionHashes: string[];
    vector?: number[];
    createdAt: string;
    status: 'pending' | 'approved' | 'rejected';
    decidedAt?: string;
}

const hash12 = (s: string) => crypto.createHash('sha1').update(String(s || 'anon')).digest('hex').slice(0, 12);

function readJson<T>(file: string, fallback: T): T {
    try {
        if (fs.existsSync(file)) {
            const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
            return (v ?? fallback) as T;
        }
    } catch (e: any) {
        console.warn(`[LEARNING] could not parse ${path.basename(file)}: ${e.message}`);
    }
    return fallback;
}

function writeJson(file: string, data: any) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

export function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function nearest<T extends { vector?: number[] }>(vec: number[], pool: T[]): { item: T; sim: number } | null {
    let best: { item: T; sim: number } | null = null;
    for (const it of pool) {
        if (!it.vector) continue;
        const sim = cosine(vec, it.vector);
        if (!best || sim > best.sim) best = { item: it, sim };
    }
    return best;
}

function newEntry(j: Judgement, vector: number[], sessionHash: string, now: Date, idx: number) {
    return {
        id: `fact_user_${now.getTime()}_${idx}`,
        category: 'community_knowledge',
        priority: COMMUNITY_PRIORITY,
        source: 'user_taught',
        text: j.text,
        vector,
        supports: 1,
        sessionHashes: [sessionHash],
        confidence: j.confidence,
        learnedAt: now.toISOString(),
        updatedAt: now.toISOString(),
    };
}

export async function learnFromStaged(items: StagedItem[], deps: LearnDeps): Promise<LearnResult> {
    const now = (deps.now || (() => new Date()))();
    const kFile = deps.knowledgeFile || KNOWLEDGE_FILE;
    const rFile = deps.reviewFile || REVIEW_QUEUE_FILE;
    const res: LearnResult = { learned: [], merged: [], queuedForReview: [], rejected: [], failed: [], processedIds: [] };
    if (items.length === 0) return res;

    // ── 1. judge ─────────────────────────────────────────────────────────────
    let judgements: Judgement[] = [];
    try {
        for (let i = 0; i < items.length; i += 20) judgements.push(...await deps.judge(items.slice(i, i + 20)));
    } catch (e: any) {
        console.error('[LEARNING] judge failed:', e.message);
        res.failed.push(...items.map(i => i.id));
        return res;
    }
    const byId = new Map(judgements.map(j => [j.id, j]));
    const keep: Array<{ item: StagedItem; j: Judgement }> = [];
    for (const item of items) {
        const j = byId.get(item.id);
        if (!j) { res.failed.push(item.id); continue; }
        const text = String(j.text || '').trim();
        if (j.verdict === 'reject' || text.length < 8 || text.length > 500) { res.rejected.push(item.id); continue; }
        keep.push({ item, j: { ...j, text } });
    }
    if (keep.length === 0) { res.processedIds = items.map(i => i.id).filter(id => !res.failed.includes(id)); return res; }

    // ── 2. embed ─────────────────────────────────────────────────────────────
    let vectors: number[][];
    try {
        vectors = await deps.embed(keep.map(k => k.j.text));
        if (vectors.length !== keep.length) throw new Error('embedding count mismatch');
    } catch (e: any) {
        console.error('[LEARNING] embedding failed:', e.message);
        res.failed.push(...keep.map(k => k.item.id));
        res.processedIds = items.map(i => i.id).filter(id => !res.failed.includes(id));
        return res;
    }

    // ── 3. merge / classify ──────────────────────────────────────────────────
    const knowledge: any[] = readJson<any[]>(kFile, []);
    const review: ReviewItem[] = readJson<ReviewItem[]>(rFile, []);
    let dirtyK = false, dirtyR = false;

    keep.forEach(({ item, j }, idx) => {
        const vec = vectors[idx];
        const sh = hash12(item.sessionId || item.id);

        // a) near-duplicate of something already learned → support, not a new vector
        const nk = nearest(vec, knowledge.filter(k => k.source === 'user_taught' || k.supports !== undefined));
        if (nk && nk.sim >= MERGE_SIMILARITY) {
            const e = nk.item;
            e.sessionHashes = Array.from(new Set([...(e.sessionHashes || []), sh])).slice(-20);
            e.supports = e.sessionHashes.length;
            e.updatedAt = now.toISOString();
            dirtyK = true; res.merged.push(item.id); return;
        }
        // …or of a curated fact: nothing to learn
        const curated = nearest(vec, knowledge.filter(k => k.source !== 'user_taught' && k.supports === undefined));
        if (curated && curated.sim >= MERGE_SIMILARITY) { res.merged.push(item.id); return; }

        // b) near-duplicate of a pending review item → +1 support (maybe promote)
        const nr = nearest(vec, review.filter(r => r.status === 'pending'));
        if (nr && nr.sim >= MERGE_SIMILARITY) {
            const r = nr.item;
            r.sessionHashes = Array.from(new Set([...r.sessionHashes, sh]));
            r.supports = r.sessionHashes.length;
            r.confidence = Math.max(r.confidence, j.confidence);
            dirtyR = true;
            if (r.supports >= SUPPORT_THRESHOLD && r.risk === 'none' && r.confidence >= SUPPORT_MIN_CONFIDENCE) {
                knowledge.push({ ...newEntry({ ...j, text: r.text, confidence: r.confidence }, r.vector || vec, r.sessionHashes[0], now, idx), supports: r.supports, sessionHashes: r.sessionHashes });
                r.status = 'approved'; r.decidedAt = now.toISOString();
                dirtyK = true; res.learned.push(item.id);
            } else res.merged.push(item.id);
            return;
        }

        // c) brand new
        if (j.verdict === 'accept' && j.confidence >= AUTO_CONFIDENCE && j.risk === 'none') {
            knowledge.push(newEntry(j, vec, sh, now, idx));
            dirtyK = true; res.learned.push(item.id);
        } else {
            review.push({
                id: `rev_${now.getTime()}_${idx}`, text: j.text, category: item.category, confidence: j.confidence, risk: j.risk,
                reason: j.risk !== 'none' ? `${j.risk} claim — human review required` : (j.reason || 'low confidence — waiting for more reports'),
                supports: 1, sessionHashes: [sh], vector: vec, createdAt: now.toISOString(), status: 'pending',
            });
            dirtyR = true; res.queuedForReview.push(item.id);
        }
    });

    if (dirtyK) writeJson(kFile, knowledge);
    if (dirtyR) writeJson(rFile, review);
    res.processedIds = items.map(i => i.id).filter(id => !res.failed.includes(id));
    return res;
}

// ── admin: human review of queued items ──────────────────────────────────────
export function listReviewQueue(file = REVIEW_QUEUE_FILE): Array<Omit<ReviewItem, 'vector'>> {
    return readJson<ReviewItem[]>(file, []).filter(r => r.status === 'pending').map(({ vector, ...rest }) => rest);
}

export function decideReview(id: string, decision: 'approve' | 'reject', opts: { text?: string; now?: Date; knowledgeFile?: string; reviewFile?: string; embedText?: Embedder } = {}):
    Promise<{ ok: boolean; error?: string }> {
    return (async () => {
        const rFile = opts.reviewFile || REVIEW_QUEUE_FILE;
        const kFile = opts.knowledgeFile || KNOWLEDGE_FILE;
        const review = readJson<ReviewItem[]>(rFile, []);
        const r = review.find(x => x.id === id && x.status === 'pending');
        if (!r) return { ok: false, error: 'not_found' };
        const now = opts.now || new Date();
        if (decision === 'reject') { r.status = 'rejected'; r.decidedAt = now.toISOString(); writeJson(rFile, review); return { ok: true }; }

        const text = (opts.text || r.text).trim();
        let vector = r.vector;
        if (text !== r.text || !vector) {
            if (!opts.embedText) return { ok: false, error: 'embedder_required' };
            vector = (await opts.embedText([text]))[0];
        }
        const knowledge = readJson<any[]>(kFile, []);
        knowledge.push({
            id: `fact_user_${now.getTime()}_rev`, category: 'community_knowledge', priority: COMMUNITY_PRIORITY, source: 'user_taught',
            text, vector, supports: r.supports, sessionHashes: r.sessionHashes, confidence: r.confidence,
            reviewedByHuman: true, learnedAt: now.toISOString(), updatedAt: now.toISOString(),
        });
        r.status = 'approved'; r.decidedAt = now.toISOString();
        writeJson(kFile, knowledge);
        writeJson(rFile, review);
        return { ok: true };
    })();
}
