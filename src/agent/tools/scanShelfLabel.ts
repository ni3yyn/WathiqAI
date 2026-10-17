/**
 * Shelf-label scanning helpers: validate the photos attached to a chat message
 * and turn them into the {frontImage, inciImage} pair the vision parser expects.
 *
 * SSRF note: the parser fetches image URLs server-side, so chat only accepts
 *   • data: URLs (jpeg/png/webp, base64, size-capped), or
 *   • https URLs whose host is in SCAN_ALLOWED_HOSTS (default: res.cloudinary.com).
 * Raw base64 + mimeType objects are converted to data URLs.
 */
export interface ChatImage {
    /** https URL or data: URL */
    url?: string;
    /** raw base64 (no prefix); `base64` is the public UI's current field name */
    data?: string;
    base64?: string;
    /** Complete data URL, accepted for clients that use FileReader.readAsDataURL */
    dataUrl?: string;
    mimeType?: string;
    /** 'front' = pack front, 'inci' = ingredient list / back label */
    role?: 'front' | 'inci';
}

export interface ScanImages { frontImage?: string; inciImage?: string }

const MAX_IMAGES = 2;
const MAX_DATA_CHARS = 8 * 1024 * 1024;       // ~6 MB binary
const DATA_URL_RE = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i;

function allowedHosts(): string[] {
    return (process.env.SCAN_ALLOWED_HOSTS || 'res.cloudinary.com').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

function normalizeOne(img: ChatImage | string): { src: string; role?: 'front' | 'inci' } | null {
    const obj: ChatImage = typeof img === 'string' ? { url: img } : (img || {});
    let src = obj.url || obj.dataUrl || '';
    const inlineBase64 = typeof obj.base64 === 'string' ? obj.base64 : obj.data;
    if (!src && inlineBase64) {
        const candidate = inlineBase64.trim();
        // Some clients send the complete data URL in the base64 field. Accept it
        // without double-prefixing, then apply the same size/type validation below.
        if (/^data:/i.test(candidate)) {
            src = candidate;
        } else {
            const rawMime = String(obj.mimeType || 'image/jpeg').toLowerCase();
            const mime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
            if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null;
            src = `data:${mime};base64,${candidate.replace(/\s+/g, '')}`;
        }
    }
    if (!src) return null;

    if (src.startsWith('data:')) {
        if (src.length > MAX_DATA_CHARS || !DATA_URL_RE.test(src)) return null;
        return { src, role: obj.role };
    }
    try {
        const u = new URL(src);
        if (u.protocol !== 'https:') return null;
        const host = u.hostname.toLowerCase();
        if (!allowedHosts().some(h => host === h || host.endsWith(`.${h}`))) return null;
        return { src, role: obj.role };
    } catch {
        return null;
    }
}

export function sanitizeScanImages(images: any): ScanImages | null {
    if (!Array.isArray(images) || images.length === 0) return null;
    const ok = images.slice(0, MAX_IMAGES).map(normalizeOne).filter((x): x is { src: string; role?: 'front' | 'inci' } => !!x);
    if (ok.length === 0) return null;

    const out: ScanImages = {};
    for (const i of ok) {
        if (i.role === 'front' && !out.frontImage) out.frontImage = i.src;
        else if (i.role === 'inci' && !out.inciImage) out.inciImage = i.src;
    }
    // Unlabelled images: first = front, second = ingredient list.
    for (const i of ok) {
        if (i.role) continue;
        if (!out.frontImage) out.frontImage = i.src;
        else if (!out.inciImage && i.src !== out.frontImage) out.inciImage = i.src;
    }
    return out.frontImage || out.inciImage ? out : null;
}

export interface ExtractedLabel {
    brand: string;
    name: string;
    category: string;
    quantity: string | null;
    ingredients: string;
    ingredientsReadConfidence?: 'high' | 'medium' | 'low';
    targetTypes?: string[];
    marketingClaims?: string[];
}
export type LabelParser = (p: { frontImage?: string; inciImage?: string; brandHint?: string; nameHint?: string }) => Promise<ExtractedLabel>;
