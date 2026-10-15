import fs from 'fs';
import { embed } from 'ai';
import { cohere } from '@ai-sdk/cohere';
import dotenv from 'dotenv';
dotenv.config();

import { KNOWLEDGE_FILE, STAGING_FILE } from './paths';

// ─── TYPES ────────────────────────────────────────────────────────────────────
export type KnowledgeCategory =
    | 'safety_contraindication' // Critical: Pregnancy, allergies, skin burns
    | 'ingredient_interaction' // Clashes: Retinol + AHA/BHA, Vit C + Niacinamide
    | 'climate_storage'        // Summer heat, light, oxidation
    | 'routine_guideline'      // Application order, timing
    | 'brand_market_intel'    // Local market formulations, verified dupes
    | 'community_knowledge';   // Learned from users (judged + supported/reviewed) — lowest priority

export interface KnowledgeItem {
    id: string;
    category: KnowledgeCategory;
    priority: number;          // 100 = Medical/Safety, 70 = Interaction, 50 = Climate, 40 = Routine
    text: string;
    triggers?: string[];       // Hard keyword triggers that bypass vector threshold
    vector?: number[];
    updatedAt: string;
    /** 'user_taught' = learned from users (see learning.ts); absent = curated */
    source?: 'user_taught';
    supports?: number;
}

// ─── KNOWLEDGE FILE CACHE (mtime-keyed) ──────────────────────────────────────
// The retriever used to readFileSync + JSON.parse the whole knowledge base on
// EVERY chat query. The file only changes when the nightly worker writes it,
// so cache the parsed array and invalidate on mtime change. Trigger strings
// are pre-normalized once at load time instead of per query.
interface PreparedKnowledgeItem extends KnowledgeItem {
    _normTriggers: string[];
    _normText: string;
}

let cachedKnowledge: PreparedKnowledgeItem[] | null = null;
let cachedKnowledgeMtime = -1;

function normalizeForMatch(s: string): string {
    return String(s || '')
        .normalize('NFKC')
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/[ىئ]/g, 'ي')
        .replace(/ؤ/g, 'و')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function loadKnowledgeBase(): PreparedKnowledgeItem[] {
    try {
        if (!fs.existsSync(KNOWLEDGE_FILE)) return [];
        const mtime = fs.statSync(KNOWLEDGE_FILE).mtimeMs;
        if (cachedKnowledge && cachedKnowledgeMtime === mtime) return cachedKnowledge;

        const rawData = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
        const parsed: KnowledgeItem[] = JSON.parse(rawData);
        if (!Array.isArray(parsed)) return [];

        cachedKnowledge = parsed.map(item => ({
            ...item,
            _normTriggers: (item.triggers || []).map(t => normalizeForMatch(t)).filter(Boolean),
            _normText: normalizeForMatch(item.text),
        }));
        cachedKnowledgeMtime = mtime;
        return cachedKnowledge;
    } catch (e: any) {
        console.warn('[KNOWLEDGE] Failed to load knowledge file:', e.message);
        return cachedKnowledge || [];
    }
}

// ─── IN-MEMORY LRU QUERY EMBEDDING CACHE (0ms for repeat questions) ───────────
const embeddingCache = new Map<string, { vector: number[]; expiresAt: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

// ─── COSINE SIMILARITY MATH (Dynamic length, handles 1024 dimensions) ─────────
function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0, normA = 0, normB = 0;
    const len = Math.min(vecA.length, vecB.length);
    for (let i = 0; i < len; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── COHERE QUERY EMBEDDER (WITH LRU CACHING) ─────────────────────────────────
async function getQueryEmbedding(query: string): Promise<number[] | null> {
    const key = query.trim().toLowerCase();
    const cached = embeddingCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.vector;
    }

    try {
        const { embedding } = await embed({
            model: cohere.textEmbeddingModel('embed-multilingual-v3.0'),
            value: query,
        });

        if (embeddingCache.size > 300) {
            // Evict expired entries first, then oldest — the old code deleted
            // the map's first key regardless of expiry, which could drop a
            // hot entry while expired ones lingered.
            const now = Date.now();
            for (const [k, v] of embeddingCache) {
                if (v.expiresAt < now) embeddingCache.delete(k);
            }
            if (embeddingCache.size > 300) {
                const oldestKey = embeddingCache.keys().next().value;
                if (oldestKey) embeddingCache.delete(oldestKey);
            }
        }
        embeddingCache.set(key, { vector: embedding, expiresAt: Date.now() + CACHE_TTL_MS });

        return embedding;
    } catch (err: any) {
        console.warn(`[KNOWLEDGE] ⚠️ Cohere embedding failed: ${err.message}`);
        return null;
    }
}

// ─── KEYWORD OVERLAP FALLBACK ────────────────────────────────────────────────
// When Cohere is down (quota, network), retrieval used to degrade to trigger
// hits only. Token-overlap scoring against the normalized fact text keeps
// multilingual knowledge flowing with zero network dependency.
function keywordScore(queryNorm: string, item: PreparedKnowledgeItem): number {
    const qTokens = queryNorm.split(' ').filter(t => t.length > 2);
    if (qTokens.length === 0) return 0;
    let hits = 0;
    for (const tok of qTokens) {
        if (item._normText.includes(tok)) hits++;
    }
    const ratio = hits / qTokens.length;
    return ratio >= 0.5 ? ratio * 0.85 : 0; // below 50% overlap = not relevant
}

// ─── SMART HYBRID RETRIEVER ──────────────────────────────────────────────────
export interface RetrieveOptions {
    /**
     * Run ONLY the zero-network hard keyword triggers (pregnancy, burns,
     * allergies…). Used for tool-style queries, where the vector lookup is
     * skipped for speed but safety triggers must still fire — "I'm pregnant,
     * recommend a retinol serum" is a search query AND a safety question.
     */
    triggersOnly?: boolean;
}

export async function findRelevantKnowledge(
    userMessage: string,
    maxFacts = 2,
    options: RetrieveOptions = {}
): Promise<string | null> {
    try {
        const knowledgeBase = loadKnowledgeBase();
        if (!knowledgeBase || knowledgeBase.length === 0) return null;

        // Normalize the query ONCE with Arabic orthographic folding — a
        // diacritized trigger or a Darija-spelled query (بشره/بشرة) must
        // still hit. The old code matched raw lowercase strings only.
        const cleanMsg = normalizeForMatch(userMessage);
        const matchedFacts: Array<{ item: KnowledgeItem; score: number; reason: string }> = [];

        // 1. HARD TRIGGER OVERRIDES (Zero-Failure Safety Net for Pregnancy & Burns)
        for (const item of knowledgeBase) {
            if (item._normTriggers.length > 0) {
                const hit = item._normTriggers.some(trig => cleanMsg.includes(trig));
                if (hit) {
                    matchedFacts.push({
                        item,
                        score: 1.0,
                        reason: `Keyword trigger match (${item.category})`
                    });
                }
            }
        }

        // 2. COHERE MULTILINGUAL VECTOR MATCH (skipped in triggers-only mode)
        const queryVector = options.triggersOnly ? null : await getQueryEmbedding(userMessage);

        if (queryVector) {
            for (const item of knowledgeBase) {
                if (!item.vector || matchedFacts.some(m => m.item.id === item.id)) continue;

                const sim = cosineSimilarity(queryVector, item.vector);

                // DYNAMIC THRESHOLD:
                // Safety items use 0.70 to easily catch slang/typos. General advice uses 0.76.
                // Community-taught facts need a closer match (less noise); curated ones keep their thresholds.
                const threshold = item.category === 'safety_contraindication' ? 0.70 : item.source === 'user_taught' ? 0.80 : 0.76;

                if (sim >= threshold) {
                    matchedFacts.push({ item, score: sim, reason: `Cohere match (${(sim * 100).toFixed(1)}%)` });
                }
            }
        } else if (!options.triggersOnly) {
            // 2b. EMBEDDING DOWN → keyword overlap fallback (safety net #2)
            for (const item of knowledgeBase) {
                if (matchedFacts.some(m => m.item.id === item.id)) continue;
                const kScore = keywordScore(cleanMsg, item);
                if (kScore > 0) {
                    matchedFacts.push({ item, score: kScore, reason: `Keyword fallback (${(kScore * 100).toFixed(0)}%)` });
                }
            }
        }

        if (matchedFacts.length === 0) return null;

        // 3. SORT BY PRIORITY (Medical rules ALWAYS come before storage rules!)
        // `?? 30`: entries written by the old worker had no priority → NaN comparisons
        // made the order unstable. Missing priority now ranks as community-level (30).
        const pri = (x: KnowledgeItem) => (typeof x.priority === 'number' ? x.priority : 30);
        matchedFacts.sort((a, b) => {
            if (pri(b.item) !== pri(a.item)) {
                return pri(b.item) - pri(a.item);
            }
            return b.score - a.score;
        });

        // Safety contraindications always get through, even beyond maxFacts —
        // a pregnancy warning must never be cut because two storage tips ranked.
        const topPicks = matchedFacts.slice(0, maxFacts);
        const extraSafety = matchedFacts
            .slice(maxFacts)
            .filter(m => m.item.category === 'safety_contraindication')
            .slice(0, 1);
        const finalPicks = [...topPicks, ...extraSafety];

        console.log(`[KNOWLEDGE] 🧠 Injected ${finalPicks.length} verified facts for query:`);
        finalPicks.forEach(p => console.log(`            ↳ [${p.item.category} | Pri:${p.item.priority}] ${p.reason}: "${p.item.text.slice(0, 45)}..."`));

        return finalPicks.map(p => p.item.source === 'user_taught'
            ? `• [COMMUNITY — reported by users, not clinically verified; hedge accordingly]: ${p.item.text}`
            : `• [${p.item.category.toUpperCase()}]: ${p.item.text}`).join('\n');

    } catch (err: any) {
        console.error('[KNOWLEDGE] Retrieval error:', err.message);
        return null;
    }
}

// ─── SHADOW STAGING QUEUE (FOR AUTONOMOUS WORKER) ─────────────────────────────
const MAX_STAGED_ITEMS = 500;

export function stageNewLearning(category: string, insight: string, sessionId: string) {
    try {
        const cleanInsight = String(insight || '').trim();
        if (cleanInsight.length < 4 || cleanInsight.length > 500) return; // junk guard

        let queue: any[] = [];
        if (fs.existsSync(STAGING_FILE)) {
            queue = JSON.parse(fs.readFileSync(STAGING_FILE, 'utf-8'));
        }
        if (!Array.isArray(queue)) queue = [];

        // Dedupe: identical pending insight from the same category → skip.
        const normInsight = normalizeForMatch(cleanInsight);
        const dupe = queue.some(q =>
            q.status === 'pending' &&
            q.category === category &&
            normalizeForMatch(q.insight || '') === normInsight
        );
        if (dupe) {
            console.log(`[LEARNING] ⏭️ Insight already staged, skipping: "${cleanInsight.slice(0, 40)}..."`);
            return;
        }

        // Cap the queue — drop the oldest pending entries beyond the cap.
        if (queue.length >= MAX_STAGED_ITEMS) {
            queue = queue.slice(queue.length - MAX_STAGED_ITEMS + 1);
        }

        queue.push({
            id: `stg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            sessionId,
            category,
            insight: cleanInsight,
            status: 'pending',
            attempts: 0
        });

        fs.writeFileSync(STAGING_FILE, JSON.stringify(queue, null, 2));
        console.log(`[LEARNING] 📥 Staged new insight safely: "${cleanInsight.slice(0, 40)}..."`);
    } catch (err: any) {
        console.error('[LEARNING] Staging error:', err.message);
    }
}
