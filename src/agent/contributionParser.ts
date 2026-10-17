import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

// ─── GEMINI KEY POOL ─────────────────────────────────────────────────────────
let lastVisionPrimaryKey = '';

/**
 * Fallback key-pool loader for standalone parser calls. Normal agent requests
 * pass their already-shuffled request key order into parseContributionImages,
 * so vision and agent model calls share the same order for that user message.
 */
function getAllGeminiApiKeys(): string[] {
    const keys: string[] = [];
    const add = (raw?: string) => {
        if (!raw) return;
        const normalized = raw.trim().replace(/^([\'"])([\s\S]*)\1$/, '$2');
        for (const part of normalized.split(',')) {
            const key = part.trim().replace(/^([\'"])([\s\S]*)\1$/, '$2').trim();
            if (key && !keys.includes(key)) keys.push(key);
        }
    };

    // GEMINI_API_KEYS is canonical. Do not mix a current pool with stale keys.
    add(process.env.GEMINI_API_KEYS);
    if (keys.length === 0) {
        add(process.env.GOOGLE_API_KEYS);
        add(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
        add(process.env.GEMINI_API_KEY);
        for (let i = 1; i <= 50; i++) add(process.env[`GEMINI_API_KEY_${i}`]);
    }
    if (keys.length === 0) return [''];

    for (let i = keys.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    if (keys.length > 1 && keys[0] === lastVisionPrimaryKey) {
        const swapIndex = 1 + crypto.randomInt(0, keys.length - 1);
        [keys[0], keys[swapIndex]] = [keys[swapIndex], keys[0]];
    }
    lastVisionPrimaryKey = keys[0];
    return keys;
}

// ─── SAFE IMAGE DECODER / FETCHER ────────────────────────────────────────────
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

type LoadedImage = { buffer: Buffer; mediaType: string };

function allowedImageHosts(): string[] {
    return (process.env.SCAN_ALLOWED_HOSTS || 'res.cloudinary.com')
        .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

async function fetchImageAsBuffer(source: string): Promise<LoadedImage | null> {
    try {
        if (typeof source !== 'string' || !source.trim()) return null;
        const value = source.trim();

        // The chat UI sends inline base64. Decode it locally instead of relying on
        // the runtime's fetch(data:) support, and validate the mime/size first.
        const dataMatch = value.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
        if (dataMatch) {
            const mediaType = dataMatch[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : dataMatch[1].toLowerCase();
            if (!ALLOWED_IMAGE_MIME.has(mediaType) || value.length > 8 * 1024 * 1024) return null;
            const buffer = Buffer.from(dataMatch[2].replace(/\s+/g, ''), 'base64');
            if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
            return { buffer, mediaType };
        }

        // URL fetching is restricted to configured trusted hosts to prevent SSRF.
        const url = new URL(value);
        if (url.protocol !== 'https:') return null;
        const host = url.hostname.toLowerCase();
        if (!allowedImageHosts().some(allowed => host === allowed || host.endsWith(`.${allowed}`))) return null;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
            if (!response.ok) return null;
            const mediaType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!ALLOWED_IMAGE_MIME.has(mediaType)) return null;
            const declaredLength = Number(response.headers.get('content-length') || 0);
            if (declaredLength > MAX_IMAGE_BYTES) return null;
            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_IMAGE_BYTES) return null;
            return { buffer: Buffer.from(arrayBuffer), mediaType: mediaType === 'image/jpg' ? 'image/jpeg' : mediaType };
        } finally {
            clearTimeout(timeout);
        }
    } catch (e: any) {
        console.warn(`[VISION] Could not load image: ${e?.message || e}`);
        return null;
    }
}

// ─── MAIN PARSER FUNCTION ────────────────────────────────────────────────────
export async function parseContributionImages(
    payload: {
        frontImage?: string;
        inciImage?: string;
        brandHint?: string;
        nameHint?: string;
    },
    requestGeminiKeys?: readonly string[],
) {
    console.log(`[VISION] 👁️ Starting Smart Parse for contribution...`);
    
    const parts: any[] = [{ 
        type: 'text', 
        text: `Analyze the provided cosmetic product image(s). The user suggested the brand might be "${payload.brandHint || 'unknown'}" and name "${payload.nameHint || 'unknown'}". Identify only what is actually visible on the package and transcribe any visible INCI list in its printed order. CRITICAL: never invent, infer, or reconstruct ingredients from a brand/product name or from general product knowledge. If no INCI list is visible/readable, return ingredients as an empty string. If only the front label is shown, extract the visible brand/name/size and leave ingredients empty. If text is partially unreadable, do not guess the missing words. Map visible category/claims to the strict taxonomy only when supported by the printed package.`
    }];

    // Fetch images into buffers so the AI SDK can process them seamlessly
    if (payload.frontImage) {
        const loaded = await fetchImageAsBuffer(payload.frontImage);
        if (loaded) {
            parts.push({ type: 'text', text: 'Package/front image: identify visible brand, exact product name, size, and printed claims. Read ingredients only if an ingredient list is actually visible in this image.' });
            parts.push({ type: 'image', image: loaded.buffer, mediaType: loaded.mediaType });
        }
    }
    if (payload.inciImage && payload.inciImage !== payload.frontImage) {
        const loaded = await fetchImageAsBuffer(payload.inciImage);
        if (loaded) {
            parts.push({ type: 'text', text: 'Back-label / INCI image: prioritize faithfully transcribing the complete visible ingredient list in printed order. Do not guess obscured words; set ingredient-read confidence to low if the list is incomplete or unclear.' });
            parts.push({ type: 'image', image: loaded.buffer, mediaType: loaded.mediaType });
        }
    }

    if (parts.length === 1) {
        throw new Error("No valid images provided for analysis.");
    }

    // ─── STRICT SCHEMA (WITH SAFETY FALLBACKS) ───────────────────────────────
    const schema = z.object({
        brand: z.string().default('غير محدد').describe('The official brand name extracted from the packaging (e.g., Belnco, Venus, CeraVe).'),
        name: z.string().default('منتج عناية').describe('The specific product name (e.g., Clarifying Serum, Gel Nettoyant).'),
        category: z.enum([
            'cleanser', 'lotion_cream', 'shampoo', 'body_wash', 'sunscreen', 'skin_serum', 
            'hair_serum', 'conditioner', 'hair_mask', 'mask', 'eye_cream', 'oil_blend', 
            'oil_replacement', 'toner', 'scrub', 'other'
        ]).default('other').describe('Classify the product into exactly one of these categories.'),
        quantity: z.string().nullable().optional().default('').describe('Extract volume/weight if visible (e.g., "50 ml", "200 g").'),
        ingredients: z.string().default('').describe('Transcribe the FULL Latin INCI ingredient list exactly as printed on the provided image. Comma separated and in printed order. Never fill unreadable or invisible words.'),
        ingredientsReadConfidence: z.enum(['high', 'medium', 'low']).default('low').describe('Confidence that the complete ingredient list is visibly present and transcribed faithfully: high=clearly legible; medium=mostly legible with some uncertainty; low=missing, obscured, partial, or inferred. Use low when INCI is not visibly readable.'),
        targetTypes: z.array(z.enum([
            'بشرة جافة', 'بشرة دهنية', 'بشرة مختلطة', 'بشرة عادية', 'بشرة حساسة', 'بشرة معرضة للحبوب', 
            'شعر جاف', 'شعر دهني', 'شعر عادي', 'شعر تالف', 'شعر مجعد', 'فروة حساسة'
        ])).default([]).describe('Select applicable target skin/hair types based on packaging claims.'),
        // Allow up to 8 so Zod doesn't crash if Gemini finds 5, then slice to 4 below
        marketingClaims: z.array(z.enum([
            'مضاد لتساقط الشعر', 'تعزيز النمو', 'تكثيف الشعر', 'فك التشابك', 'مرطب للشعر', 'مخصص للشعر الجاف', 
            'تغذية الشعر', 'ترطيب مكثف', 'مخصص للشعر الدهني', 'مضاد للقشرة', 'مكافحة التجعد', 'إصلاح الشعر المتضرر', 
            'تقوية الشعر', 'حماية من الحرارة', 'تلميع ولمعان', 'تنعيم الشعر', 'حماية اللون', 'تفتيح البشرة', 
            'توحيد لون البشرة', 'تفتيح البقع الداكنة', 'تفتيح تحت العين', 'مكافحة التجاعيد', 'شد البشرة', 
            'تحفيز الكولاجين', 'مضاد للأكسدة', 'مضاد لحب الشباب', 'مضاد للرؤوس السوداء', 'تنقية المسام', 
            'قابض للمسام', 'تنقية عميقة', 'توازن الدهون والزيوت', 'توازن الدهون و الزيوت', 'للبشرة الدهنية', 
            'للبشرة الجافة', 'مرطب للبشرة', 'للبشرة الحساس', 'للبشرة الحساسة', 'مهدئ', 'مضاد للالتهابات', 'تهدئة البشرة', 
            'تقشير لطيف', 'تقشير', 'تنظيف عميق', 'تنظيف لطيف', 'إزالة المكياج', 'توازن الحموضة', 'حماية من الشمس', 
            'حماية واسعة الطيف', 'مقاوم للماء', 'إزالة السيلوليت', 'شد الجسم'
        ])).max(8).default([]).describe('Select up to 4 exact marketing claims presented on the packaging.')
    });

    // The normal chat path passes one request-scoped, shuffled pool. Only
    // standalone calls need to create their own order here.
    const keys = requestGeminiKeys?.length ? [...requestGeminiKeys] : getAllGeminiApiKeys();
    const primaryModel = process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash';
    const fallbackModel = process.env.GEMINI_VISION_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
    const models = Array.from(new Set([primaryModel, fallbackModel].filter(Boolean)));

    let lastError: any = null;

    // ─── KEY FAILOVER & MODEL FALLBACK LOOP ──────────────────────────────────
    for (const modelName of models) {
        for (let i = 0; i < keys.length; i++) {
            const apiKey = keys[i];
            const googleProvider = apiKey ? createGoogleGenerativeAI({ apiKey }) : createGoogleGenerativeAI();
            const model = googleProvider(modelName);

            try {
                const { object } = await generateObject({
                    model,
                    schema,
                    messages: [{ role: 'user', content: parts }],
                    abortSignal: AbortSignal.timeout(25000)
                });

                // Enforce the strict 4-claims limit cleanly
                const finalClaims = (object.marketingClaims || []).slice(0, 4);

                console.log(`[VISION] ✅ Successfully extracted data for: ${object.brand} ${object.name}`);
                
                return {
                    brand: object.brand ? object.brand.trim() : 'غير محدد',
                    name: object.name ? object.name.trim() : 'منتج عناية',
                    category: object.category,
                    quantity: object.quantity ? String(object.quantity).trim() : null,
                    ingredients: object.ingredients ? object.ingredients.trim() : '',
                    ingredientsReadConfidence: object.ingredientsReadConfidence || 'low',
                    targetTypes: object.targetTypes || [],
                    marketingClaims: finalClaims
                };

            } catch (err: any) {
                lastError = err;
                console.warn(`[VISION] ⚠️ Attempt with model "${modelName}" on key [${i + 1}/${keys.length}] failed: ${err?.message || err}`);
                // Continue to next key or fallback model
            }
        }
    }

    console.error('[VISION] ❌ All models and keys exhausted during vision parse.');
    throw lastError || new Error("Failed to parse images with any available key or model.");
}