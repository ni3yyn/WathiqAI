/**
 * Contribute-to-catalog loop.
 *
 * When the scan lane meets a product that is not in the catalog, the user can
 * submit it with one tap. Submissions are MODERATED: they sit in
 * data/contributions.json as `pending` until an admin approves them; approved
 * ones are merged into the catalog at load time (see backendClient) with
 * `communitySubmitted: true` and no price.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONTRIBUTIONS_FILE, APPROVED_CONTRIBUTIONS_FILE } from '../paths';

// Local copy (importing it from cabinet.ts would create an import cycle through backendClient).
function parseIngredientText(text?: string): string[] {
    return String(text || '')
        .replace(/^\s*(ingredients?|inci|المكونات|composition)\s*[:：]\s*/i, '')
        .split(/[,،;؛\n\r•·]+/)
        .map(s => s.replace(/\.$/, '').trim())
        .filter(s => s.length > 1 && !/^\d+$/.test(s))
        .slice(0, 150);
}
import { normalizeArabicText } from './taxonomy';

export interface ContributionDraft {
    brand: string;
    name: string;
    category?: string;
    ingredients: string;                 // INCI text read from the photo / typed
    quantity?: string | null;
    targetTypes?: string[];
    marketingClaims?: string[];
    image?: string;
}

export interface Contribution extends Omit<ContributionDraft, 'ingredients'> {
    id: string;
    ingredients: string[];
    submitterHash: string;
    createdAt: string;
    status: 'pending' | 'approved' | 'rejected';
    decidedAt?: string;
    note?: string;
}

const DAILY_LIMIT = 5;
const clip = (s: any, n: number) => String(s ?? '').trim().slice(0, n);
const h = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function read(file: string): any[] {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : []; } catch { return []; }
}
function write(file: string, data: any) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

export type SubmitResult =
    | { ok: true; id: string; duplicate: false }
    | { ok: true; id: string; duplicate: true }
    | { ok: false; error: 'invalid' | 'too_few_ingredients' | 'rate_limited' };

export function submitContribution(draft: ContributionDraft, submitter: string, opts: { file?: string; now?: Date; catalogHas?: (brand: string, name: string) => boolean } = {}): SubmitResult {
    const file = opts.file || CONTRIBUTIONS_FILE;
    const brand = clip(draft.brand, 80), name = clip(draft.name, 120);
    const ingredients = parseIngredientText(draft.ingredients);
    if (!name || name.length < 3 || !brand) return { ok: false, error: 'invalid' };
    if (ingredients.length < 3) return { ok: false, error: 'too_few_ingredients' };
    if (opts.catalogHas?.(brand, name)) return { ok: true, id: 'existing', duplicate: true };

    const now = opts.now || new Date();
    const rows: Contribution[] = read(file);
    const sub = h(submitter || 'anon');
    const today = now.toISOString().slice(0, 10);
    if (rows.filter(r => r.submitterHash === sub && r.createdAt.startsWith(today)).length >= DAILY_LIMIT) return { ok: false, error: 'rate_limited' };

    const key = `${normalizeArabicText(brand)}|${normalizeArabicText(name)}`;
    const dupe = rows.find(r => r.status !== 'rejected' && `${normalizeArabicText(r.brand)}|${normalizeArabicText(r.name)}` === key);
    if (dupe) return { ok: true, id: dupe.id, duplicate: true };

    const c: Contribution = {
        id: `ctb_${now.getTime().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
        brand, name, category: draft.category ? clip(draft.category, 40) : undefined,
        ingredients, quantity: draft.quantity ? clip(draft.quantity, 30) : null,
        targetTypes: (draft.targetTypes || []).slice(0, 6).map(x => clip(x, 40)),
        marketingClaims: (draft.marketingClaims || []).slice(0, 6).map(x => clip(x, 60)),
        image: draft.image && /^https:\/\//.test(draft.image) ? clip(draft.image, 300) : undefined,
        submitterHash: sub, createdAt: now.toISOString(), status: 'pending',
    };
    write(file, [...rows, c]);
    return { ok: true, id: c.id, duplicate: false };
}

export function listContributions(status: Contribution['status'] = 'pending', file = CONTRIBUTIONS_FILE) {
    return read(file).filter((r: Contribution) => r.status === status).map(({ submitterHash, ...rest }: Contribution) => rest);
}

export function decideContribution(id: string, decision: 'approve' | 'reject', opts: { note?: string; file?: string; approvedFile?: string; now?: Date; patch?: Partial<ContributionDraft> } = {}): { ok: boolean; error?: string; productId?: string } {
    const file = opts.file || CONTRIBUTIONS_FILE;
    const rows: Contribution[] = read(file);
    const c = rows.find(r => r.id === id && r.status === 'pending');
    if (!c) return { ok: false, error: 'not_found' };
    const now = opts.now || new Date();
    c.decidedAt = now.toISOString(); c.note = opts.note ? clip(opts.note, 200) : undefined;
    if (decision === 'reject') { c.status = 'rejected'; write(file, rows); return { ok: true }; }

    c.status = 'approved';
    const aFile = opts.approvedFile || APPROVED_CONTRIBUTIONS_FILE;
    const approved: any[] = read(aFile);
    const productId = `USR-${(c.category || 'oth').slice(0, 3).toUpperCase()}-${h(c.id).slice(0, 6).toUpperCase()}`;
    approved.push({
        id: productId, brand: c.brand, name: opts.patch?.name || c.name,
        ingredients: c.ingredients.join(', '),
        country: null,
        category: { id: opts.patch?.category || c.category || 'other', label: '' },
        quantity: c.quantity, targetTypes: c.targetTypes || [], marketingClaims: c.marketingClaims || [],
        image: c.image, communitySubmitted: true,
    });
    write(aFile, approved); write(file, rows);
    return { ok: true, productId };
}

/** Approved community products, in the shape the catalog uses (merged by backendClient). */
export function loadApprovedContributions(file = APPROVED_CONTRIBUTIONS_FILE): any[] {
    const rows = read(file);
    return Array.isArray(rows) ? rows : [];
}
