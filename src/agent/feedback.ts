/**
 * Feedback that teaches — and a data source for evals.
 *
 * 👍/👎 on a reply (optionally with a reason and a correction):
 *   • is appended to data/feedback.jsonl WITHOUT the user's message text — only
 *     a session hash, the lane/tools that produced the reply, rating and reason;
 *   • a 👎 that includes a correction ("actually, niacinamide + AHA is fine")
 *     is staged as a learning candidate — it goes through the same judge /
 *     support / human-review policy as everything else (never straight into memory).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { FEEDBACK_FILE } from '../paths';
import { stageNewLearning } from '../memory';

export type Rating = 'up' | 'down';
export const REASONS = ['wrong_info', 'not_relevant', 'too_long', 'too_short', 'bad_dialect', 'unsafe', 'other'] as const;
export type Reason = typeof REASONS[number];

export interface MessageMeta { lane?: string; tools?: string[]; at: number }
const RING_MAX = 500;
const ring = new Map<string, MessageMeta>();

/** Called when a response is produced, so later feedback can be attributed to a lane/tool. */
export function registerMessage(messageId: string, meta: Omit<MessageMeta, 'at'>) {
    ring.set(messageId, { ...meta, at: Date.now() });
    if (ring.size > RING_MAX) ring.delete(ring.keys().next().value as string);
}

export const newMessageId = () => `m_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export interface FeedbackInput {
    sessionId: string;
    messageId?: string;
    rating: Rating;
    reason?: string;
    /** the user's own correction/explanation (optional, ≤500 chars) */
    correction?: string;
}

export function recordFeedback(input: FeedbackInput, file = FEEDBACK_FILE): { ok: boolean; staged: boolean; error?: string } {
    if (!input || (input.rating !== 'up' && input.rating !== 'down')) return { ok: false, staged: false, error: 'invalid_rating' };
    if (!input.sessionId) return { ok: false, staged: false, error: 'missing_sessionId' };
    const meta = input.messageId ? ring.get(input.messageId) : undefined;
    const reason: Reason | undefined = (REASONS as readonly string[]).includes(String(input.reason)) ? (input.reason as Reason) : (input.reason ? 'other' : undefined);
    const row = {
        t: new Date().toISOString(),
        s: hash(input.sessionId),
        m: input.messageId || null,
        rating: input.rating,
        reason: reason || null,
        lane: meta?.lane || null,
        tools: meta?.tools || [],
        hadCorrection: !!(input.correction && input.correction.trim().length >= 8),
    };
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (e: any) {
        return { ok: false, staged: false, error: e.message };
    }
    let staged = false;
    const c = String(input.correction || '').trim();
    if (input.rating === 'down' && c.length >= 8 && c.length <= 500) {
        stageNewLearning('cosmetic_science', c, input.sessionId);     // judged + reviewed before it can ever be retrieved
        staged = true;
    }
    return { ok: true, staged };
}

export interface FeedbackStats {
    total: number; up: number; down: number; satisfaction: number | null;
    byLane: Record<string, { up: number; down: number }>;
    byTool: Record<string, { up: number; down: number }>;
    byReason: Record<string, number>;
    corrections: number;
}

export function feedbackStats(file = FEEDBACK_FILE): FeedbackStats {
    const stats: FeedbackStats = { total: 0, up: 0, down: 0, satisfaction: null, byLane: {}, byTool: {}, byReason: {}, corrections: 0 };
    try {
        if (!fs.existsSync(file)) return stats;
        for (const line of fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)) {
            let r: any; try { r = JSON.parse(line); } catch { continue; }
            stats.total++;
            r.rating === 'up' ? stats.up++ : stats.down++;
            const bump = (m: Record<string, { up: number; down: number }>, k: string) => { (m[k] ||= { up: 0, down: 0 })[r.rating === 'up' ? 'up' : 'down']++; };
            bump(stats.byLane, r.lane || 'unknown');
            for (const t of (r.tools?.length ? r.tools : ['none'])) bump(stats.byTool, t);
            if (r.reason) stats.byReason[r.reason] = (stats.byReason[r.reason] || 0) + 1;
            if (r.hadCorrection) stats.corrections++;
        }
        stats.satisfaction = stats.total ? Math.round((stats.up / stats.total) * 100) : null;
    } catch (e: any) {
        console.warn('[FEEDBACK] stats failed:', e.message);
    }
    return stats;
}
