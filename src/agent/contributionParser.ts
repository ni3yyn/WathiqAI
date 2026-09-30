import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

// Re-using the Key Pool we built earlier to prevent rate limits!
function getGeminiApiKey(): string | undefined {
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '';
    const keys = rawKeys.split(',').map(k => k.replace(/['"\s]/g, '').trim()).filter(Boolean);
    if (keys.length === 0) return undefined;
    return keys[Math.floor(Math.random() * keys.length)];
}

// Helper to fetch Cloudinary URL into a buffer for Gemini Vision
async function fetchImageAsBuffer(url: string): Promise<Buffer | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error(`[VISION] Failed to fetch image: ${url}`);
        return null;
    }
}

export async function parseContributionImages(payload: {
    frontImage?: string;
    inciImage?: string;
    brandHint?: string;
    nameHint?: string;
}) {
    console.log(`[VISION] 👁️ Starting Smart Parse for contribution...`);
    
    const parts: any[] = [{ type: 'text', text: `Analyze the provided cosmetic product images. The user suggested the brand might be "${payload.brandHint || 'unknown'}" and name "${payload.nameHint || 'unknown'}". Extract the precise details, read the INCI ingredients, and map them to our strict taxonomy.` }];

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

    const apiKey = getGeminiApiKey();
    const googleProvider = apiKey ? createGoogleGenerativeAI({ apiKey }) : createGoogleGenerativeAI();
    
    // Using flash (which supports multimodal vision)
    const model = googleProvider(process.env.GEMINI_SYNTHESIS_MODEL || 'gemini-3.5-flash');

    const { object } = await generateObject({
        model,
        schema: z.object({
            brand: z.string().describe('The official brand name extracted from the packaging (e.g., Belnco, Venus, CeraVe).'),
            name: z.string().describe('The specific product name (e.g., Clarifying Serum, Gel Nettoyant).'),
            category: z.enum([
                'cleanser', 'lotion_cream', 'shampoo', 'body_wash', 'sunscreen', 'skin_serum', 
                'hair_serum', 'conditioner', 'hair_mask', 'mask', 'eye_cream', 'oil_blend', 
                'oil_replacement', 'toner', 'scrub', 'other'
            ]).describe('Classify the product into exactly one of these categories.'),
            quantity: z.string().describe('Extract volume/weight if visible (e.g., "50 ml", "200 g").'),
            ingredients: z.string().describe('Transcribe the FULL Latin INCI ingredient list exactly as printed on the back. Comma separated. Correct obvious OCR typos.'),
            targetTypes: z.array(z.enum([
                'بشرة جافة', 'بشرة دهنية', 'بشرة مختلطة', 'بشرة عادية', 'بشرة حساسة', 'بشرة معرضة للحبوب', 
                'شعر جاف', 'شعر دهني', 'شعر عادي', 'شعر تالف', 'شعر مجعد', 'فروة حساسة'
            ])).describe('Select applicable target skin/hair types based on packaging claims.'),
            marketingClaims: z.array(z.enum([
                'مضاد لتساقط الشعر', 'تعزيز النمو', 'تكثيف الشعر', 'فك التشابك', 'مرطب للشعر', 'مخصص للشعر الجاف', 
                'تغذية الشعر', 'ترطيب مكثف', 'مخصص للشعر الدهني', 'مضاد للقشرة', 'مكافحة التجعد', 'إصلاح الشعر المتضرر', 
                'تقوية الشعر', 'حماية من الحرارة', 'تلميع ولمعان', 'تنعيم الشعر', 'حماية اللون', 'تفتيح البشرة', 
                'توحيد لون البشرة', 'تفتيح البقع الداكنة', 'تفتيح تحت العين', 'مكافحة التجاعيد', 'شد البشرة', 
                'تحفيز الكولاجين', 'مضاد للأكسدة', 'مضاد لحب الشباب', 'مضاد للرؤوس السوداء', 'تنقية المسام', 
                'قابض للمسام', 'تنقية عميقة', 'توازن الدهون والزيوت', 'توازن الدهون و الزيوت', 'للبشرة الدهنية', 
                'للبشرة الجافة', 'مرطب للبشرة', 'للبشرة الحساس', 'مهدئ', 'مضاد للالتهابات', 'تهدئة البشرة', 
                'تقشير لطيف', 'تقشير', 'تنظيف عميق', 'تنظيف لطيف', 'إزالة المكياج', 'توازن الحموضة', 'حماية من الشمس', 
                'حماية واسعة الطيف', 'مقاوم للماء', 'إزالة السيلوليت', 'شد الجسم'
            ])).max(4).describe('Select up to 4 exact marketing claims presented on the packaging.')
        }),
        messages: [{ role: 'user', content: parts }]
    });

    console.log(`[VISION] ✅ Successfully extracted data for: ${object.brand} ${object.name}`);
    return object;
}