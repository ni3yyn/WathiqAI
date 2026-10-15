/**
 * Minimal Firestore REST client that reads with the USER'S OWN ID token — so the
 * project's security rules decide what is visible, and the agent holds no admin
 * credentials. Includes the typed-value decoder, timeouts and one retry.
 */
export class FirestoreError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'FirestoreError'; }
}

/** Firestore typed value → plain JSON (timestamps become epoch ms). */
export function decodeValue(v: any): any {
    if (v == null || typeof v !== 'object') return null;
    if ('nullValue' in v) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('timestampValue' in v) { const t = Date.parse(v.timestampValue); return Number.isNaN(t) ? null : t; }
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
    if ('referenceValue' in v) return String(v.referenceValue).split('/').pop() || null;
    if ('geoPointValue' in v) return { lat: v.geoPointValue.latitude, lng: v.geoPointValue.longitude };
    if ('bytesValue' in v) return null;              // never needed; do not carry blobs
    return null;
}
export function decodeFields(fields: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(fields || {})) out[k] = decodeValue(val);
    return out;
}

export interface RestDoc { id: string; data: Record<string, any> }

export interface FirestoreClient {
    getDocument(path: string, token: string, maskPaths?: string[]): Promise<RestDoc | null>;
    listDocuments(path: string, token: string, opts?: { maskPaths?: string[]; pageSize?: number; maxPages?: number; orderBy?: string }): Promise<RestDoc[]>;
}

export interface FirestoreClientOptions {
    projectId: string;
    databaseId?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
}

export function createFirestoreClient(o: FirestoreClientOptions): FirestoreClient {
    const f = o.fetchImpl || fetch;
    const base = `${o.baseUrl || 'https://firestore.googleapis.com'}/v1/projects/${encodeURIComponent(o.projectId)}/databases/${encodeURIComponent(o.databaseId || '(default)')}/documents`;
    const timeout = o.timeoutMs || 8000;

    async function call(url: string, token: string): Promise<any | null> {
        for (let attempt = 0; attempt < 2; attempt++) {
            let res: Response;
            try {
                res = await f(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
            } catch (e: any) {
                if (attempt === 0) { await new Promise(r => setTimeout(r, 250)); continue; }
                throw new FirestoreError(0, `network: ${e?.name === 'TimeoutError' ? 'timeout' : e?.message}`);
            }
            if (res.status === 404) return null;
            if (res.status === 401 || res.status === 403) throw new FirestoreError(res.status, 'permission denied (check Firestore rules / token)');
            if ((res.status === 429 || res.status >= 500) && attempt === 0) { await new Promise(r => setTimeout(r, 300)); continue; }
            if (!res.ok) throw new FirestoreError(res.status, `firestore ${res.status}`);
            return res.json();
        }
        return null;
    }

    const maskQs = (paths?: string[]) => (paths || []).map(p => `mask.fieldPaths=${encodeURIComponent(p)}`).join('&');
    const toDoc = (d: any): RestDoc => ({ id: String(d.name || '').split('/').pop() || '', data: decodeFields(d.fields || {}) });

    return {
        async getDocument(path, token, maskPaths) {
            const qs = maskQs(maskPaths);
            const body = await call(`${base}/${path}${qs ? `?${qs}` : ''}`, token);
            return body ? toDoc(body) : null;
        },
        async listDocuments(path, token, opts = {}) {
            const docs: RestDoc[] = [];
            let pageToken = '';
            const maxPages = opts.maxPages || 3;
            for (let page = 0; page < maxPages; page++) {
                const qs = [`pageSize=${opts.pageSize || 100}`, opts.orderBy ? `orderBy=${encodeURIComponent(opts.orderBy)}` : '', maskQs(opts.maskPaths), pageToken ? `pageToken=${encodeURIComponent(pageToken)}` : '']
                    .filter(Boolean).join('&');
                const body = await call(`${base}/${path}?${qs}`, token);
                if (!body) break;
                for (const d of body.documents || []) docs.push(toDoc(d));
                if (!body.nextPageToken) break;
                pageToken = body.nextPageToken;
            }
            return docs;
        },
    };
}
