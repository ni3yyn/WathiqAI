import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

// ─── ROBUST API KEY POOL ─────────────────────────────────────────────────────
function getAllGeminiApiKeys(): string[] {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
    const keys = rawKeys
        .split(',')
        .map(k => k.replace(/['"\s]/g, '').trim())
        .filter(Boolean);

    for (let i = 1; i <= 20; i++) {
        const k = process.env[`GEMINI_API_KEY_${i}`];
        if (k && k.trim()) keys.push(k.replace(/['"\s]/g, '').trim());
    }

    return keys.length > 0 ? Array.from(new Set(keys)) : [''];
}

// ─── HELPER: FETCH CLOUDINARY IMAGE INTO BUFFER WITH TIMEOUT ─────────────────
async function fetchImageAsBuffer(url: string): Promise<Buffer | null> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000); // 12s timeout

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e: any) {
        console.warn(`[VISION] ⚠️ Could not fetch image (${url}): ${e?.message || e}`);
        return null;
    }
}

// ─── MAIN PARSER FUNCTION ────────────────────────────────────────────────────
export async function parseContributionImages(payload: {
    frontImage?: string;
    inciImage?: string;
    brandHint?: string;
    nameHint?: string;
}) {
    console.log(`[VISION] 👁️ Starting Smart Parse for contribution...`);
    
    const parts: any[] = [{ 
        type: 'text', 
        text: `Analyze the provided cosmetic product images. The user suggested the brand might be "${payload.brandHint || 'unknown'}" and name "${payload.nameHint || 'unknown'}". Extract the precise details, read the INCI ingredients, and map them to our strict taxonomy.` 
    }];

    // Fetch images into buffers so the AI SDK can process them seamlessly
    if (payload.frontImage) {
        const buf = await fetchImageAsBuffer(payload.frontImage);
        if (buf) parts.push({ type: 'image', image: buf });
    }
    if (payload.inciImage && payload.inciImage !== payload.frontImage) {
        const buf = await fetchImageAsBuffer(payload.inciImage);
        if (buf) parts.push({ type: 'image', image: buf });
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
        ingredients: z.string().default('').describe('Transcribe the FULL Latin INCI ingredient list exactly as printed on the back. Comma separated. Correct obvious OCR typos.'),
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

    const keys = getAllGeminiApiKeys();
    const primaryModel = process.env.GEMINI_SYNTHESIS_MODEL || 'gemini-3.5-flash';
    const fallbackModel = process.env.GEMINI_SYNTHESIS_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
    const models = [primaryModel, fallbackModel];

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