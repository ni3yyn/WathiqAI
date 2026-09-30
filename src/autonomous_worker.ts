import fs from 'fs';
import path from 'path';
import { google } from '@ai-sdk/google';
import { generateObject, embed } from 'ai';
import { z } from 'zod';

const STAGING_FILE = path.join(__dirname, 'staging_queue.json');
const TAXONOMY_FILE = path.join(__dirname, 'learned_taxonomy.json');
const KNOWLEDGE_FILE = path.join(__dirname, 'knowledge_embeddings.json');

// The exact allowed canonical claims from your taxonomy
const ALLOWED_CLAIMS = [
    'تفتيح البشرة', 'مضاد لحب الشباب', 'تنقية المسام', 'توازن الزيوت', 
    'مكافحة التجاعيد', 'شد البشرة', 'ترطيب مكثف', 'مهدئ', 'تنظيف عميق'
];

export async function runAutonomousWorker() {
    console.log('🌙 [AUTO-WORKER] Waking up to process staging queue...');

    if (!fs.existsSync(STAGING_FILE)) {
        console.log('🌙 [AUTO-WORKER] Staging queue is empty. Going back to sleep.');
        return;
    }

    let queue: any[] = [];
    try {
        queue = JSON.parse(fs.readFileSync(STAGING_FILE, 'utf-8'));
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
            let learnedTaxonomy: any = {};
            if (fs.existsSync(TAXONOMY_FILE)) {
                learnedTaxonomy = JSON.parse(fs.readFileSync(TAXONOMY_FILE, 'utf-8'));
            }

            // Patch the taxonomy locally
            object.validMappings.forEach(mapping => {
                if (mapping.isValid && ALLOWED_CLAIMS.includes(mapping.canonicalTarget)) {
                    // Match our taxonomy keys
                    const keyMap: any = {
                        'شد البشرة': 'anti_aging',
                        'مكافحة التجاعيد': 'anti_aging',
                        'مضاد لحب الشباب': 'anti_acne',
                        'توازن الزيوت': 'anti_acne',
                        'تفتيح البشرة': 'brightening',
                        'ترطيب مكثف': 'hydration',
                        'مهدئ': 'soothing'
                    };
                    const jsonKey = keyMap[mapping.canonicalTarget];
                    
                    if (jsonKey) {
                        if (!learnedTaxonomy[jsonKey]) learnedTaxonomy[jsonKey] = [];
                        if (!learnedTaxonomy[jsonKey].includes(mapping.slangTerm)) {
                            learnedTaxonomy[jsonKey].push(mapping.slangTerm);
                            console.log(`✅ [AUTO-WORKER] Learned new dialect: "${mapping.slangTerm}" -> ${jsonKey}`);
                        }
                    }
                }
            });

            fs.writeFileSync(TAXONOMY_FILE, JSON.stringify(learnedTaxonomy, null, 2));
        } catch (err) {
            console.error('🌙 [AUTO-WORKER] Failed to process dialects.', err);
        }
    }

    // 2. PROCESS COSMETIC KNOWLEDGE (Vector Embeddings)
    if (knowledge.length > 0) {
        console.log(`🌙 [AUTO-WORKER] Processing ${knowledge.length} knowledge items...`);
        try {
            let existingKnowledge: any[] = [];
            if (fs.existsSync(KNOWLEDGE_FILE)) {
                existingKnowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf-8'));
            }

            for (const item of knowledge) {
                // Generate the mathematical vector for the new rule
                const { embedding } = await embed({
                    model: google.textEmbeddingModel('gemini-embedding-001'),
                    value: item.insight,
                });

                existingKnowledge.push({
                    id: `fact_auto_${Date.now()}`,
                    category: item.category,
                    text: item.insight,
                    vector: embedding
                });
                console.log(`✅ [AUTO-WORKER] Embedded new knowledge: "${item.insight.substring(0, 30)}..."`);
            }

            fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(existingKnowledge, null, 2));
        } catch (err) {
            console.error('🌙 [AUTO-WORKER] Failed to process knowledge.', err);
        }
    }

    // 3. CLEAR STAGING QUEUE (Mark as processed by clearing the file)
    fs.writeFileSync(STAGING_FILE, JSON.stringify([], null, 2));
    console.log('🌙 [AUTO-WORKER] Nightly processing complete. Staging queue cleared.');
}