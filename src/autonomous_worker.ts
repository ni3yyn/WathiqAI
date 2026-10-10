import fs from 'fs';
import path from 'path';
import { google } from '@ai-sdk/google';
import { generateObject, embedMany } from 'ai';
import { z } from 'zod';

import { STAGING_FILE, LEARNED_TAXONOMY_FILE as TAXONOMY_FILE, KNOWLEDGE_FILE } from './paths';

// Legacy location (before paths.ts): merged in once so nothing already
// learned is lost when the file moves to the shared path.
const LEGACY_TAXONOMY_FILE = path.join(__dirname, 'learned_taxonomy.json');

// The exact allowed canonical claims from your taxonomy
const ALLOWED_CLAIMS = [
    'تفتيح البشرة', 'مضاد لحب الشباب', 'تنقية المسام', 'توازن الزيوت',
    'مكافحة التجاعيد', 'شد البشرة', 'ترطيب مكثف', 'مهدئ', 'تنظيف عميق'
];

// Canonical claim -> taxonomy JSON key. The old keyMap was missing four of the
// nine allowed claims (تنقية المسام، تنظيف عميق، توازن الزيوت partially…), so
// the worker silently DROPPED valid learned dialects for them.
const CLAIM_TO_TAXONOMY_KEY: Record<string, string> = {
    'شد البشرة': 'anti_aging',
    'مكافحة التجاعيد': 'anti_aging',
    'مضاد لحب الشباب': 'anti_acne',
    'توازن الزيوت': 'anti_acne',
    'تنقية المسام': 'anti_acne',
    'تفتيح البشرة': 'brightening',
    'ترطيب مكثف': 'hydration',
    'مهدئ': 'soothing',
    'تنظيف عميق': 'cleansing_exfoliating',
};

const MAX_ATTEMPTS = 3; // give up on a staging item after 3 failed runs

// ─── NORMALIZATION (for dedupe comparisons only) ─────────────────────────────
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

function readJsonFile<T>(filePath: string, fallback: T): T {
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return parsed ?? fallback;
        }
    } catch (e: any) {
        console.warn(`[AUTO-WORKER] Could not parse ${path.basename(filePath)}: ${e.message}`);
    }
    return fallback;
}

/**
 * Atomic-ish queue update: re-read the queue file right before writing and
 * merge our status changes into whatever is on disk NOW. The old worker read
 * the file once, processed for minutes, then wrote an EMPTY array — wiping
 * every insight users staged while it was working.
 */
function updateQueue(mutate: (queue: any[]) => any[]) {
    const current = readJsonFile<any[]>(STAGING_FILE, []);
    const next = mutate(Array.isArray(current) ? current : []);
    fs.writeFileSync(STAGING_FILE, JSON.stringify(next, null, 2));
}

export async function runAutonomousWorker() {
    console.log('🌙 [AUTO-WORKER] Waking up to process staging queue...');

    if (!fs.existsSync(STAGING_FILE)) {
        console.log('🌙 [AUTO-WORKER] Staging queue is empty. Going back to sleep.');
        return;
    }

    let queue: any[] = [];
    try {
        queue = JSON.parse(fs.readFileSync(STAGING_FILE, 'utf-8'));
        if (!Array.isArray(queue)) queue = [];
    } catch (e) {
        console.error('🌙 [AUTO-WORKER] Failed to read staging queue.', e);
        return;
    }

    const pendingItems = queue.filter(q => q.status === 'pending');
    if (pendingItems.length === 0) {
        console.log('🌙 [AUTO-WORKER] No pending items. Going back to sleep.');
        return;
    }

    const dialects = pendingItems.filter(i => i.category === 'dialect');
    const knowledge = pendingItems.filter(i => i.category === 'cosmetic_science' || i.category === 'brand_info');

    const processedIds = new Set<string>();
    const failedIds = new Set<string>();

    // 1. PROCESS DIALECTS (Map Darija -> Canonical taxonomy)
    if (dialects.length > 0) {
        console.log(`🌙 [AUTO-WORKER] Processing ${dialects.length} dialect items...`);
        try {
            const { object } = await generateObject({
                model: google('gemini-3.5-flash-lite'),
                schema: z.object({
                    validMappings: z.array(z.object({
                        slangTerm: z.string(),
                        canonicalTarget: z.string(),
                        isValid: z.boolean(),
                        reason: z.string()
                    }))
                }),
                prompt: `
                You are an expert in Algerian Darija and skincare. Review these user-submitted slang terms:
                ${JSON.stringify(dialects.map(d => d.insight))}

                For each term, determine if it is a valid skincare term. If it is a troll/insult, set isValid to false.
                If valid, map it to the single most appropriate canonical claim from this list ONLY:
                ${JSON.stringify(ALLOWED_CLAIMS)}
                `
            });

            // Load existing learned taxonomy
            let learnedTaxonomy: any = readJsonFile(TAXONOMY_FILE, {});
            if (fs.existsSync(LEGACY_TAXONOMY_FILE) && LEGACY_TAXONOMY_FILE !== TAXONOMY_FILE) {
                const legacy: any = readJsonFile(LEGACY_TAXONOMY_FILE, {});
                for (const [k, arr] of Object.entries(legacy)) {
                    if (!Array.isArray(arr)) continue;
                    learnedTaxonomy[k] = Array.from(new Set([...(learnedTaxonomy[k] || []), ...(arr as string[])]));
                }
            }

            // Patch the taxonomy locally
            object.validMappings.forEach(mapping => {
                if (mapping.isValid && ALLOWED_CLAIMS.includes(mapping.canonicalTarget)) {
                    const jsonKey = CLAIM_TO_TAXONOMY_KEY[mapping.canonicalTarget];

                    if (jsonKey) {
                        if (!learnedTaxonomy[jsonKey]) learnedTaxonomy[jsonKey] = [];
                        if (!learnedTaxonomy[jsonKey].includes(mapping.slangTerm)) {
                            learnedTaxonomy[jsonKey].push(mapping.slangTerm);
                            console.log(`✅ [AUTO-WORKER] Learned new dialect: "${mapping.slangTerm}" -> ${jsonKey}`);
                        }
                    }
                }
            });

            fs.mkdirSync(path.dirname(TAXONOMY_FILE), { recursive: true });
            fs.writeFileSync(TAXONOMY_FILE, JSON.stringify(learnedTaxonomy, null, 2));
            dialects.forEach(d => processedIds.add(d.id));
        } catch (err) {
            console.error('🌙 [AUTO-WORKER] Failed to process dialects.', err);
            dialects.forEach(d => failedIds.add(d.id));
        }
    }

    // 2. PROCESS COSMETIC KNOWLEDGE (Vector Embeddings)
    if (knowledge.length > 0) {
        console.log(`🌙 [AUTO-WORKER] Processing ${knowledge.length} knowledge items...`);
        try {
            let existingKnowledge: any[] = readJsonFile(KNOWLEDGE_FILE, []);
            if (!Array.isArray(existingKnowledge)) existingKnowledge = [];

            // Dedupe against what's already stored (normalized text compare) —
            // the same fact staged twice must not become two near-identical
            // vectors fighting each other at retrieval time.
            const existingNorm = new Set(existingKnowledge.map(k => normalizeForMatch(k.text || '')));
            const newItems = knowledge.filter(item => {
                const n = normalizeForMatch(item.insight || '');
                if (!n || existingNorm.has(n)) {
                    console.log(`⏭️ [AUTO-WORKER] Skipping duplicate knowledge: "${String(item.insight).slice(0, 40)}..."`);
                    processedIds.add(item.id);
                    return false;
                }
                return true;
            });

            if (newItems.length > 0) {
                // Batch embeddings: ONE API call for the whole run instead of
                // one call per item — faster and much friendlier to rate limits.
                // (embed() one-by-one was the old behaviour; N staged insights
                //  cost N sequential network round-trips.)
                const { embeddings } = await embedMany({
                    model: google.textEmbeddingModel('gemini-embedding-001'),
                    values: newItems.map(item => String(item.insight)),
                });

                newItems.forEach((item, idx) => {
                    existingKnowledge.push({
                        // Unique even for same-millisecond batches.
                        id: `fact_auto_${Date.now()}_${idx}`,
                        category: item.category,
                        text: item.insight,
                        vector: embeddings[idx]
                    });
                    console.log(`✅ [AUTO-WORKER] Embedded new knowledge: "${String(item.insight).substring(0, 30)}..."`);
                });

                fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(existingKnowledge, null, 2));
                newItems.forEach(item => processedIds.add(item.id));
            }
        } catch (err) {
            console.error('🌙 [AUTO-WORKER] Failed to process knowledge.', err);
            knowledge.forEach(k => { if (!processedIds.has(k.id)) failedIds.add(k.id); });
        }
    }

    // 3. UPDATE STAGING QUEUE — surgically.
    // Remove processed items, keep failures with an attempt counter (retried
    // next run, dropped after MAX_ATTEMPTS), and PRESERVE anything staged
    // while this worker was running (the old code destroyed those).
    updateQueue(current => {
        return current
            .map(item => {
                if (processedIds.has(item.id)) return null; // done → remove
                if (failedIds.has(item.id)) {
                    const attempts = (item.attempts || 0) + 1;
                    if (attempts >= MAX_ATTEMPTS) {
                        console.warn(`🗑️ [AUTO-WORKER] Dropping item after ${attempts} failed attempts: "${String(item.insight).slice(0, 40)}..."`);
                        return null;
                    }
                    return { ...item, attempts }; // stays 'pending' for next run
                }
                return item; // untouched (staged mid-run or other status)
            })
            .filter(Boolean);
    });

    console.log(`🌙 [AUTO-WORKER] Nightly processing complete. Processed: ${processedIds.size}, failed (retrying): ${failedIds.size}.`);
}
