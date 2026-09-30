import fs from 'fs';
import path from 'path';
import { embed } from 'ai';
import { cohere } from '@ai-sdk/cohere';
import dotenv from 'dotenv';
dotenv.config();

const KNOWLEDGE_FILE = path.join(process.cwd(), 'src', 'knowledge_embeddings.json');
const STAGING_FILE = path.join(process.cwd(), 'src', 'staging_queue.json');

// ─── TYPES ────────────────────────────────────────────────────────────────────
export type KnowledgeCategory = 
    | 'safety_contraindication' // Critical: Pregnancy, allergies, skin burns
    | 'ingredient_interaction' // Clashes: Retinol + AHA/BHA, Vit C + Niacinamide
    | 'climate_storage'        // Summer heat, light, oxidation
    | 'routine_guideline'      // Application order, timing
    | 'brand_market_intel';    // Local market formulations, verified dupes

export interface KnowledgeItem {
    id: string;
    category: KnowledgeCategory;
    priority: number;          // 100 = Medical/Safety, 70 = Interaction, 50 = Climate, 40 = Routine
    text: string;
    triggers?: string[];       // Hard keyword triggers that bypass vector threshold
    vector?: number[];
    updatedAt: string;
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
            const oldestKey = embeddingCache.keys().next().value;
            if (oldestKey) embeddingCache.delete(oldestKey);
        }
        embeddingCache.set(key, { vector: embedding, expiresAt: Date.now() + CACHE_TTL_MS });

        return embedding;
    } catch (err: any) {
        console.warn(`[KNOWLEDGE] ⚠️ Cohere embedding failed: ${err.message}`);
        return null;
    }
}

// ─── SMART HYBRID RETRIEVER ──────────────────────────────────────────────────
export async function findRelevantKnowledge(
    userMessage: string, 
    maxFacts = 2
): Promise<string | null> {
    try {
        if (!fs.existsSync(KNOWLEDGE_FILE)) return null;

        const rawData = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
        const knowledgeBase: KnowledgeItem[] = JSON.parse(rawData);
        if (!knowledgeBase || knowledgeBase.length === 0) return null;

        const cleanMsg = userMessage.toLowerCase();
        const matchedFacts: Array<{ item: KnowledgeItem; score: number; reason: string }> = [];

        // 1. HARD TRIGGER OVERRIDES (Zero-Failure Safety Net for Pregnancy & Burns)
        for (const item of knowledgeBase) {
            if (item.triggers && item.triggers.length > 0) {
                const hit = item.triggers.some(trig => cleanMsg.includes(trig.toLowerCase()));
                if (hit) {
                    matchedFacts.push({ 
                        item, 
                        score: 1.0, 
                        reason: `Keyword trigger match (${item.category})` 
                    });
                }
            }
        }

        // 2. COHERE MULTILINGUAL VECTOR MATCH
        const queryVector = await getQueryEmbedding(userMessage);

        if (queryVector) {
            for (const item of knowledgeBase) {
                if (!item.vector || matchedFacts.some(m => m.item.id === item.id)) continue;
                
                const sim = cosineSimilarity(queryVector, item.vector);

                // DYNAMIC THRESHOLD:
                // Safety items use 0.70 to easily catch slang/typos. General advice uses 0.76.
                const threshold = item.category === 'safety_contraindication' ? 0.70 : 0.76;

                if (sim >= threshold) {
                    matchedFacts.push({ item, score: sim, reason: `Cohere match (${(sim * 100).toFixed(1)}%)` });
                }
            }
        }

        if (matchedFacts.length === 0) return null;

        // 3. SORT BY PRIORITY (Medical rules ALWAYS come before storage rules!)
        matchedFacts.sort((a, b) => {
            if (b.item.priority !== a.item.priority) {
                return b.item.priority - a.item.priority;
            }
            return b.score - a.score;
        });

        const topPicks = matchedFacts.slice(0, maxFacts);

        console.log(`[KNOWLEDGE] 🧠 Cohere injected ${topPicks.length} verified facts for query:`);
        topPicks.forEach(p => console.log(`            ↳ [${p.item.category} | Pri:${p.item.priority}] ${p.reason}: "${p.item.text.slice(0, 45)}..."`));

        return topPicks.map(p => `• [${p.item.category.toUpperCase()}]: ${p.item.text}`).join('\n');

    } catch (err: any) {
        console.error('[KNOWLEDGE] Retrieval error:', err.message);
        return null;
    }
}

// ─── SHADOW STAGING QUEUE (FOR AUTONOMOUS WORKER) ─────────────────────────────
export function stageNewLearning(category: string, insight: string, sessionId: string) {
    try {
        let queue = [];
        if (fs.existsSync(STAGING_FILE)) {
            queue = JSON.parse(fs.readFileSync(STAGING_FILE, 'utf-8'));
        }

        queue.push({
            id: `stg_${Date.now()}`,
            timestamp: new Date().toISOString(),
            sessionId,
            category,
            insight,
            status: 'pending'
        });

        fs.writeFileSync(STAGING_FILE, JSON.stringify(queue, null, 2));
        console.log(`[LEARNING] 📥 Staged new insight safely: "${insight.slice(0, 40)}..."`);
    } catch (err: any) {
        console.error('[LEARNING] Staging error:', err.message);
    }
}