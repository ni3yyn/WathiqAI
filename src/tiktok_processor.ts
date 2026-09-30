import fs from 'fs';
import path from 'path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

export const REVIEWS_DB_FILE = path.join(process.cwd(), 'src', 'reviews_db.json');

// ─── PER-PRODUCT STORAGE (PRIMARY SOURCE OF TRUTH) ────────────────────────────
// Each product's synthesized result now lives in its own file under
// src/scraped_products/<productId>.json. This is what "already harvested"
// actually checks — so deleting a single product's file is enough to make it
// eligible for re-harvesting again, without touching anything else. The
// combined reviews_db.json is still written alongside it (for anything that
// reads the whole catalog's reviews at once), but it's a derived view now,
// not the source of truth.
export const PRODUCTS_DIR = path.join(process.cwd(), 'src', 'scraped_products');

export function getProductFilePath(productId: string): string {
    return path.join(PRODUCTS_DIR, `${productId}.json`);
}

export function getProductRawFilePath(productId: string): string {
    return path.join(PRODUCTS_DIR, `${productId}.raw.json`);
}

export function productFileExists(productId: string): boolean {
    return fs.existsSync(getProductFilePath(productId));
}

// One-time backfill for installs that already had data in reviews_db.json
// before scraped_products/ existed. Only runs when the folder is entirely
// absent, so it never re-creates a file you deliberately deleted later.
export function migrateLegacyReviewsDbIfNeeded(): void {
    if (fs.existsSync(PRODUCTS_DIR)) return;

    const reviewsDb = atomicReadJSON<Record<string, any>>(REVIEWS_DB_FILE, {});
    const ids = Object.keys(reviewsDb);
    if (ids.length === 0) return;

    fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
    for (const id of ids) {
        atomicWriteJSON(getProductFilePath(id), reviewsDb[id]);
    }
    console.log(`[MIGRATE] 📦 Backfilled ${ids.length} product file(s) into ${PRODUCTS_DIR} from the existing reviews_db.json.`);
}

export interface RawReviewComment {
    author: string;
    text: string;
    [key: string]: any;
}

export interface SynthesisMeta {
    videosScanned: number;
    totalRawComments: number;
}

// ─── 1. HEURISTIC SPAM & NOISE FILTER (ZERO LLM COST) ────────────────────────
// Rejects transactional/spam noise (price checks, delivery questions, ads),
// then requires genuine experiential/skin-reaction vocabulary to pass.
const SPAM_REGEX = /prix|بشحال|بكم|توصيل|livraison|dispo|وين\s*نلقاه|ابوني|abonne|magasin|صيدلية|combien|ça coute|ca coute|c'est combien/i;

const EXPERIENCE_REGEX = /جربت|شريت|خرج\s*عليا|مخرجش\s*علي|ما\s*خرجش|ماخرجش\s*عليا|موالمنيش|ماوالمنيش|دارلي|نشفلي|نشفت|حبوب|قشر|حرقني|حسيته|لزج|خفيف|ريحة|عجبني|ماعجبنيش|ما\s*عجبنيش|معجبنيش|جربتو|خرطي|باطن|تحسس|تهيج|روعة|نتيجة|نصح|رطب|rougeur|boutons|brillance|gras|top|catastrophe|résultat|hydrate|irritation/i;

// Emoji-only reactions ("😍😍😍"), pure @mentions ("@sara look at this"), and
// single-character-repeat spam ("mmmmmmmm") carry no synthesizable signal but
// can still slip past the word-count check below — catch them explicitly so
// we don't waste LLM attention (or a quote slot) on noise.
const EMOJI_ONLY_REGEX = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s❤️♥️👍👎🔥✨💯]+$/u;
const MENTION_ONLY_REGEX = /^(@[\w.\u0600-\u06FF]+[\s,،]*)+$/;
const REPEATED_CHAR_REGEX = /^(.)\1{4,}$/;

function isLowSignalNoise(clean: string): boolean {
    if (!clean) return true;
    if (EMOJI_ONLY_REGEX.test(clean)) return true;
    if (MENTION_ONLY_REGEX.test(clean)) return true;
    if (REPEATED_CHAR_REGEX.test(clean.replace(/\s+/g, ''))) return true;
    return false;
}

export function isAuthenticReview(text: string): boolean {
    if (!text) return false;
    const clean = text.toLowerCase().trim();
    if (isLowSignalNoise(clean)) return false;
    if (SPAM_REGEX.test(clean)) return false;
    if (clean.split(/\s+/).filter(Boolean).length < 3) return false;
    return EXPERIENCE_REGEX.test(clean);
}

// ─── GLOBAL DEDUPLICATION ─────────────────────────────────────────────────────
// Per-video dedup (by TikTok's own comment `cid`) misses the same comment
// resurfacing under a reposted/duplicate video, or the same creator's pinned
// comment appearing on several review videos for the same product. This
// normalizes text (strip diacritics/punctuation/whitespace/case) so those
// near-duplicates collapse into one before they ever reach the spam filter
// or the LLM.
export function normalizeForDedupe(text: string): string {
    if (!text) return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function dedupeComments<T extends { text: string }>(comments: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const c of comments) {
        const key = normalizeForDedupe(c.text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(c);
    }
    return result;
}

// ─── 2. ATOMIC JSON PERSISTENCE HELPERS ──────────────────────────────────────
// Write-to-temp-then-rename guarantees the destination file is never left in a
// half-written state if the process is interrupted mid-write.
export function atomicWriteJSON(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
}

export function atomicReadJSON<T = any>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch (e) {
        console.warn(`[PROCESSOR] ⚠️ Could not parse ${filePath}, falling back to default value.`);
        return fallback;
    }
}

// ─── 3. GEMINI API KEY ROTATION POOL ──────────────────────────────────────────
// Spread requests across several Gemini API keys so a single key's per-minute
// / per-day quota doesn't stall the whole batch. Configure in .env with any
// (or a mix) of:
//   GEMINI_API_KEYS=key1,key2,key3        (comma-separated, preferred)
//   GEMINI_API_KEY_1=key1
//   GEMINI_API_KEY_2=key2                 (…up to GEMINI_API_KEY_20)
//   GOOGLE_GENERATIVE_AI_API_KEY=key1     (single-key fallback, still works)
function cleanKey(k: string): string {
    return k.replace(/['"\s]/g, '').trim();
}

function loadApiKeysFromEnv(): string[] {
    const keys = new Set<string>();

    const csv = process.env.GEMINI_API_KEYS || process.env.GOOGLE_API_KEYS || '';
    csv.split(',').map(cleanKey).filter(Boolean).forEach(k => keys.add(k));

    for (let i = 1; i <= 20; i++) {
        const k = process.env[`GEMINI_API_KEY_${i}`];
        if (k && cleanKey(k)) keys.add(cleanKey(k));
    }

    if (keys.size === 0) {
        const single = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
        if (single && cleanKey(single)) keys.add(cleanKey(single));
    }

    return Array.from(keys);
}

function shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function maskKey(key: string): string {
    if (key.length <= 6) return '••••';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

class ApiKeyRotator {
    private keys: string[];
    private cursor = 0;
    private cooldownUntil = new Map<string, number>();

    constructor(keys: string[]) {
        // Shuffle once at startup so concurrent batch runs / restarts don't all
        // hammer the same "first" key before ever touching the others.
        this.keys = shuffle(keys);
    }

    size(): number {
        return this.keys.length;
    }

    markCooldown(key: string, ms = 60_000): void {
        this.cooldownUntil.set(key, Date.now() + ms);
    }

    private isCoolingDown(key: string): boolean {
        const until = this.cooldownUntil.get(key);
        return typeof until === 'number' && Date.now() < until;
    }

    /** Returns up to `keys.length` keys, live ones first, in rotation order. */
    orderedForAttempt(): string[] {
        if (this.keys.length === 0) return [];
        const ordered: string[] = [];
        for (let i = 0; i < this.keys.length; i++) {
            ordered.push(this.keys[(this.cursor + i) % this.keys.length]);
        }
        this.cursor = (this.cursor + 1) % this.keys.length;
        // Prefer keys that aren't on cooldown, but keep the rest as a last resort.
        const fresh = ordered.filter(k => !this.isCoolingDown(k));
        const stale = ordered.filter(k => this.isCoolingDown(k));
        return [...fresh, ...stale];
    }
}

const apiKeyRotator = new ApiKeyRotator(loadApiKeysFromEnv());
if (apiKeyRotator.size() > 1) {
    console.log(`[SYNTHESIS] 🔑 Loaded ${apiKeyRotator.size()} Gemini API keys — rotating to spread quota usage.`);
} else if (apiKeyRotator.size() === 1) {
    console.log(`[SYNTHESIS] 🔑 Loaded 1 Gemini API key (add more as GEMINI_API_KEYS=a,b,c to rotate and last longer).`);
} else {
    console.warn(`[SYNTHESIS] ⚠️ No Gemini API key found in .env — relying on the SDK's default credential resolution.`);
}



// ─── 4. GEMINI SYNTHESIS SCHEMA ──────────────────────────────────────────────
const SynthesisSchema = z.object({
    satisfactionRate: z.number().min(0).max(100),
    summary: z.string().describe('A 1-sentence consensus summary in Arabic'),
    pros: z.array(z.string()).max(4),
    cons: z.array(z.string()).max(4),
    // 3 to 8 raw quotes, dynamically sized to how much real signal exists.
    rawVerifiedQuotes: z.array(z.object({
        author: z.string(),
        verbatimText: z.string().describe('Exact raw Darija/French text, do not correct spelling'),
        skinProfile: z.string().describe('Skin type or "غير محدد"')
    })).min(3).max(8)
});

type SynthesisResult = z.infer<typeof SynthesisSchema>;

function isOverloadedError(err: any): boolean {
    const status = err?.statusCode || err?.status || err?.cause?.statusCode;
    const message = String(err?.message || err?.cause?.message || '');
    return status === 503 || /overloaded|high demand|unavailable|rate.?limit/i.test(message);
}

// ─── 5. SYNTHESIS WITH KEY ROTATION + AUTOMATIC MODEL FALLBACK ───────────────
// Tries every available API key (skipping ones on cooldown) against the
// primary model first; a 429/quota error just moves to the next key. Only a
// genuine 503/overload (or every key being exhausted on the primary model)
// escalates to the fallback model, which then gets the same key rotation.
// ─── ERROR DIAGNOSTIC HELPERS ────────────────────────────────────────────────
function getErrorDetails(err: any): { code: string | number; message: string } {
    const statusCode = err?.statusCode || err?.status || err?.cause?.statusCode;
    if (statusCode) return { code: statusCode, message: err?.message || 'HTTP Error' };

    if (err?.name === 'TimeoutError' || err?.message?.includes('timeout') || err?.name === 'AbortError') {
        return { code: 'TIMEOUT (20s)', message: 'Google server held connection open without responding' };
    }

    const rawMessage = String(err?.message || err || '');
    if (/quota|rate.?limit|resource_exhausted/i.test(rawMessage)) return { code: '429_QUOTA', message: rawMessage };
    if (/overloaded|high demand|unavailable/i.test(rawMessage)) return { code: '503_OVERLOAD', message: rawMessage };

    return { code: err?.code || 'UNKNOWN', message: rawMessage.slice(0, 120) };
}

function isRateLimitOrQuotaError(code: string | number, message: string): boolean {
    return code === 429 || code === '429_QUOTA' || /quota|rate.?limit|too many requests/i.test(message);
}

function isOverloadError(code: string | number, message: string): boolean {
    return code === 503 || code === '503_OVERLOAD' || code === 'TIMEOUT (20s)' || /high demand|unavailable|overloaded/i.test(message);
}

// ─── RUN GENERATE OBJECT WITH HARD TIMEOUT ───────────────────────────────────
async function runGenerateObject(apiKey: string | undefined, model: string, prompt: string): Promise<SynthesisResult> {
    const provider = apiKey ? createGoogleGenerativeAI({ apiKey }) : createGoogleGenerativeAI();
    
    // Hard 20-second timeout: cancels hanging connections automatically
    const { object } = await generateObject({
        model: provider(model),
        schema: SynthesisSchema,
        prompt,
        maxRetries: 0, // Let our own loop handle retries and model switching
        abortSignal: AbortSignal.timeout(20000)
    });
    
    return object;
}

// ─── SYNTHESIS WITH VISIBLE KEY ROTATION & AUTOMATIC MODEL FALLBACK ──────────
async function synthesizeWithFallback(prompt: string): Promise<SynthesisResult> {
    const primaryModel = process.env.GEMINI_SYNTHESIS_MODEL || 'gemini-3.5-flash-lite';
    const fallbackModel = process.env.GEMINI_SYNTHESIS_FALLBACK_MODEL || 'gemini-3.5-flash';
    const models = [primaryModel, fallbackModel];

    const keyAttempts = apiKeyRotator.size() > 0 ? apiKeyRotator.orderedForAttempt() : [undefined];
    let lastError: any = null;

    for (let m = 0; m < models.length; m++) {
        const model = models[m];
        const isLastModel = m === models.length - 1;

        console.log(`\n[SYNTHESIS] 🚀 Attempting model: "${model}" (${m + 1}/${models.length})`);

        for (let k = 0; k < keyAttempts.length; k++) {
            const apiKey = keyAttempts[k];
            const keyLabel = apiKey ? maskKey(apiKey) : 'default credentials';

            try {
                console.log(`[SYNTHESIS] 🔑 Trying key [${k + 1}/${keyAttempts.length}] ${keyLabel}...`);
                const result = await runGenerateObject(apiKey, model, prompt);
                console.log(`[SYNTHESIS] ✨ Success with model "${model}" on key ${keyLabel}!`);
                return result;
            } catch (err: any) {
                lastError = err;
                const { code, message } = getErrorDetails(err);

                console.warn(`[SYNTHESIS] ❌ Error on model "${model}" with key ${keyLabel}`);
                console.warn(`             ↳ Status/Code: [${code}]`);
                console.warn(`             ↳ Details: ${message}`);

                // Rate limited / Quota exhausted -> Cool down key and try next key on SAME model
                if (apiKey && isRateLimitOrQuotaError(code, message)) {
                    console.log(`[SYNTHESIS] 🔄 Key quota reached. Cooling down key and switching to next key...`);
                    apiKeyRotator.markCooldown(apiKey, 60000);
                    continue;
                }

                // Overloaded (503) or Timed out (hanging connection) -> Switch immediately to next model
                if (isOverloadError(code, message)) {
                    if (!isLastModel) {
                        console.log(`[SYNTHESIS] ⚡ Model "${model}" is overloaded/hanging. Escalating to fallback model: "${models[m + 1]}"...`);
                    }
                    break; // Exit key loop and escalate to next model
                }

                // Any other error -> Try next key
                console.log(`[SYNTHESIS] ➡️ Trying next key...`);
            }
        }
    }

    console.error(`[SYNTHESIS] 💥 All models and keys exhausted. Last error:`, lastError);
    throw lastError;
}

export interface ProcessOptions {
    // 'keep-best' (default): if this product already has a synthesized entry
    // and the new harvest found the same or fewer valid comments, skip the
    // (expensive) synthesis call and keep the existing entry untouched. Pass
    // 'always' to force a hard overwrite regardless of which run had more
    // signal — used by the batch worker's --force-overwrite flag.
    overwritePolicy?: 'keep-best' | 'always';
}

// ─── 5. MAIN ENTRY POINT ──────────────────────────────────────────────────────
export async function processTikTokComments(
    productId: string,
    productName: string,
    rawComments: RawReviewComment[],
    meta: SynthesisMeta = { videosScanned: 0, totalRawComments: rawComments.length },
    options: ProcessOptions = {}
): Promise<boolean> {
    const overwritePolicy = options.overwritePolicy ?? 'keep-best';
    console.log(`[TIKTOK] Processing ${rawComments.length} raw comments for "${productName}"...`);

    const validComments = dedupeComments(
        rawComments
            .filter(c => isAuthenticReview(c.text))
            .map(c => ({ author: c.author, text: c.text }))
    );

    if (validComments.length < 3) {
        console.log(`[TIKTOK] ⚠️ Only ${validComments.length} experiential comment(s) survived filtering (need at least 3). Skipping synthesis for "${productName}".`);
        return false;
    }

    if (overwritePolicy === 'keep-best') {
        const existing = atomicReadJSON<Record<string, any>>(REVIEWS_DB_FILE, {})[productId];
        const existingCount = existing?.sources?.tiktok ?? 0;
        if (existing && existingCount >= validComments.length) {
            console.log(`[TIKTOK] ℹ️ Existing entry for "${productName}" already has ${existingCount} valid comment(s) vs ${validComments.length} in this harvest — keeping the existing (better) entry. Pass overwritePolicy: 'always' to force a replacement.`);
            return false;
        }
    }

    console.log(`[TIKTOK] 🎯 Reduced to ${validComments.length} high-quality reviews. Sending to Gemini...`);

    const prompt = `
    Analyze these ${validComments.length} real Algerian TikTok comments for the cosmetic product "${productName}":
    ${JSON.stringify(validComments)}

    Extract satisfaction rate, pros, cons, and select between 4 to 8 of the most authentic, detailed Darija/French quotes.
    `;

    let synthesized: SynthesisResult;
    try {
        synthesized = await synthesizeWithFallback(prompt);
    } catch (e: any) {
        console.error(`[TIKTOK] ❌ Synthesis failed permanently for "${productName}": ${e?.message || e}`);
        return false;
    }

    const reviewsDb = atomicReadJSON<Record<string, any>>(REVIEWS_DB_FILE, {});

    reviewsDb[productId] = {
        productId,
        productName,
        sources: {
            tiktok: validComments.length,
            videosScanned: meta.videosScanned,
            totalRawHarvested: meta.totalRawComments
        },
        updatedAt: new Date().toISOString(),
        ...synthesized
    };

    atomicWriteJSON(REVIEWS_DB_FILE, reviewsDb);

    console.log(`✅ [TIKTOK] Successfully built review database for "${productName}" (${meta.videosScanned} videos, ${synthesized.rawVerifiedQuotes.length} quotes)!`);
    return true;
}