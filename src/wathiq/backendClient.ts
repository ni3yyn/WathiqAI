import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadApprovedContributions } from '../agent/contributions';

dotenv.config();

const WATHIQ_EVALUATE_URL = process.env.WATHIQ_EVALUATE_URL || 'https://oilguard-backend.vercel.app/api/evaluate.js';
const WATHIQ_CATALOG_URL = process.env.WATHIQ_CATALOG_URL || 'https://cdn.jsdelivr.net/gh/ni3yyn/prdcts@main/finalcatalog506.json';
const LOCAL_CATALOG_PATH = path.join(process.cwd(), 'data', 'catalog.json');

// ─── NETWORK TUNING ──────────────────────────────────────────────────────────
const CATALOG_TIMEOUT_MS = Math.max(1000, parseInt(process.env.WATHIQ_CATALOG_TIMEOUT_MS || '4000', 10));
const EVALUATE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.WATHIQ_EVALUATE_TIMEOUT_MS || '15000', 10));
const CATALOG_RETRIES = Math.max(0, Math.min(2, parseInt(process.env.WATHIQ_CATALOG_RETRIES || '1', 10)));
const RETRY_BASE_DELAY_MS = Math.max(0, parseInt(process.env.WATHIQ_CATALOG_RETRY_BASE_MS || '250', 10));
const CATALOG_FAILURE_COOLDOWN_MS = Math.max(1000, parseInt(process.env.WATHIQ_CATALOG_FAILURE_COOLDOWN_MS || '10000', 10));
let catalogFailureUntil = 0;
let lastCatalogFailure = '';
const NETWORK_TIMING_LOGS = process.env.AGENT_DEBUG !== 'false';

// ─── EVALUATION CACHE ────────────────────────────────────────────────────────
// evaluate_product, compare_products, brand category-focus, the unknown-
// ingredient scan and check_ingredient_list all call evaluateProduct() with
// the same (ingredients, type, claims, profile) tuple again and again — e.g.
// "evaluate A" then "compare A and B" scored A twice. Evaluation is a pure
// deterministic function of its payload, so we memoize it:
//   • key  = sha1(canonical JSON of the payload)
//   • TTL  = WATHIQ_EVAL_CACHE_TTL_MS (default 45 min), LRU-capped
//   • in-flight de-duplication: concurrent identical calls share one fetch
//   • only well-formed responses (numeric oilGuardScore) are cached, so a
//     transient backend error page can never poison the cache.
const EVAL_CACHE_TTL_MS = parseInt(process.env.WATHIQ_EVAL_CACHE_TTL_MS || String(45 * 60 * 1000), 10);
const EVAL_CACHE_MAX = 600;
const evalCache = new Map<string, { value: any; expiresAt: number }>();
const evalInFlight = new Map<string, Promise<any>>();
const evalStats = { hits: 0, misses: 0, coalesced: 0 };

export function getEvalCacheStats() {
    return { ...evalStats, size: evalCache.size, inFlight: evalInFlight.size };
}

/** Stable stringify (sorted keys) so key order never changes the hash. */
function canonicalJson(v: any): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

function evalKey(payload: any): string {
    return crypto.createHash('sha1').update(canonicalJson(payload)).digest('hex');
}

function evictEvalCache() {
    if (evalCache.size <= EVAL_CACHE_MAX) return;
    const now = Date.now();
    for (const [k, v] of evalCache) if (v.expiresAt < now) evalCache.delete(k);
    while (evalCache.size > EVAL_CACHE_MAX) {
        const oldest = evalCache.keys().next().value;
        if (oldest === undefined) break;
        evalCache.delete(oldest);
    }
}

// ─── CATALOG CACHE ───────────────────────────────────────────────────────────
let catalogCache: any[] | null = null;
let lastFetch = 0;
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
let catalogInFlight: Promise<any[]> | null = null;

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTextWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
): Promise<{ response: Response; bodyText: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        // IMPORTANT: consume the response body BEFORE clearing the timer.
        // `fetch()` resolves when headers arrive; a slow/stalled JSON body was
        // previously able to bypass the timeout and hold a tool call forever.
        const bodyText = await response.text();
        return { response, bodyText };
    } catch (err: any) {
        if (err?.name === 'AbortError' || controller.signal.aborted) {
            throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function isValidCatalog(data: any): data is any[] {
    return Array.isArray(data)
        && data.length > 0
        && data.every((p: any) => p && typeof p === 'object' && (p.id || p.name));
}

function readDiskCatalog(): any[] | null {
    try {
        if (fs.existsSync(LOCAL_CATALOG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(LOCAL_CATALOG_PATH, 'utf-8'));
            if (isValidCatalog(parsed)) return parsed;
        }
    } catch (e) {
        // Fall through to network
    }
    return null;
}

async function fetchCatalogFromNetwork(): Promise<any[]> {
    let lastError: any = null;
    for (let attempt = 0; attempt <= CATALOG_RETRIES; attempt++) {
        const startedAt = Date.now();
        try {
            const { response, bodyText } = await fetchTextWithTimeout(WATHIQ_CATALOG_URL, {}, CATALOG_TIMEOUT_MS);
            if (!response.ok) {
                throw new Error(`Failed to fetch catalog: ${response.status} ${response.statusText}`);
            }
            let data: any;
            try { data = JSON.parse(bodyText); }
            catch { throw new Error('Failed to parse catalog JSON response'); }
            if (!isValidCatalog(data)) {
                throw new Error('Catalog payload failed validation (not a non-empty product array)');
            }
            catalogFailureUntil = 0;
            lastCatalogFailure = '';
            if (NETWORK_TIMING_LOGS) console.log(`[WATHIQ][CATALOG] network load succeeded durationMs=${Date.now() - startedAt} products=${data.length} attempt=${attempt + 1}/${CATALOG_RETRIES + 1}`);
            return data;
        } catch (err: any) {
            lastError = err;
            lastCatalogFailure = String(err?.message || err);
            console.warn(`[WATHIQ][CATALOG] fetch failed durationMs=${Date.now() - startedAt} attempt=${attempt + 1}/${CATALOG_RETRIES + 1}: ${lastCatalogFailure}`);
            if (attempt < CATALOG_RETRIES) await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
        }
    }
    catalogFailureUntil = Date.now() + CATALOG_FAILURE_COOLDOWN_MS;
    throw lastError;
}

/** Merges moderator-approved community products into a catalog array (by id, never overriding). */
function withApproved(data: any[]): any[] {
    try {
        const extra = loadApprovedContributions();
        if (!extra.length) return data;
        const have = new Set(data.map(p => String(p.id)));
        const add = extra.filter(p => p?.id && !have.has(String(p.id)));
        return add.length ? [...data, ...add] : data;
    } catch { return data; }
}

/** Called after a moderator approves a contribution: adds it to the live catalog without a refetch. */
export function mergeApprovedIntoCatalog(): number {
    if (!catalogCache) return 0;
    const merged = withApproved(catalogCache);
    const added = merged.length - catalogCache.length;
    if (added > 0) catalogCache = merged;
    return added;
}

export async function getProducts(): Promise<any[]> {
    if (catalogCache && Date.now() - lastFetch < CACHE_TTL) {
        if (NETWORK_TIMING_LOGS) console.log(`[WATHIQ][CATALOG] memory cache hit products=${catalogCache.length}`);
        return catalogCache;
    }

    const diskData = readDiskCatalog();
    if (diskData) {
        catalogCache = withApproved(diskData);
        lastFetch = Date.now();
        catalogFailureUntil = 0;
        lastCatalogFailure = '';
        if (NETWORK_TIMING_LOGS) console.log(`[WATHIQ][CATALOG] disk cache hit products=${catalogCache.length}`);
        return catalogCache;
    }

    if (catalogInFlight) return catalogInFlight;
    if (!catalogCache && Date.now() < catalogFailureUntil) {
        throw new Error(`Catalog temporarily unavailable; retry after cooldown. Last error: ${lastCatalogFailure || 'unknown'}`);
    }

    catalogInFlight = (async () => {
        try {
            const data = withApproved(await fetchCatalogFromNetwork());
            catalogCache = data;
            lastFetch = Date.now();

            try {
                const dir = path.dirname(LOCAL_CATALOG_PATH);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(LOCAL_CATALOG_PATH, JSON.stringify(data), 'utf-8');
            } catch (e) {
                // Ignore disk write errors
            }
            return data;
        } catch (error) {
            if (catalogCache && catalogCache.length > 0) {
                console.warn('[WATHIQ] Network refresh failed; serving stale in-memory catalog');
                lastFetch = Date.now();
                return catalogCache;
            }
            console.error('[WATHIQ] Failed to load product catalog', error);
            throw error;
        } finally {
            catalogInFlight = null;
        }
    })();

    return catalogInFlight;
}

/**
 * Force-refreshes the catalog from the network, bypassing (and replacing) all
 * caches — including the evaluation cache, since scores depend on catalog-
 * derived ingredient lists.
 */
export async function refreshCatalog(): Promise<number> {
    catalogCache = null;
    lastFetch = 0;
    evalCache.clear();
    try { fs.unlinkSync(LOCAL_CATALOG_PATH); } catch { /* ignore */ }
    const data = await getProducts();
    return data.length;
}

async function evaluateRemote(payload: any): Promise<any> {
    const startedAt = Date.now();
    try {
        const { response, bodyText } = await fetchTextWithTimeout(WATHIQ_EVALUATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, EVALUATE_TIMEOUT_MS);

        if (!response.ok) {
            throw new Error(`Evaluation API failed: ${response.status} ${response.statusText}`);
        }
        let result: any;
        try { result = JSON.parse(bodyText); }
        catch { throw new Error('Failed to parse evaluation JSON response'); }
        if (NETWORK_TIMING_LOGS) console.log(`[WATHIQ][EVALUATE] remote completed durationMs=${Date.now() - startedAt}`);
        return result;
    } catch (error: any) {
        console.warn(`[WATHIQ][EVALUATE] remote failed durationMs=${Date.now() - startedAt}: ${error?.message || error}`);
        throw error;
    }
}

export async function evaluateProduct(payload: any): Promise<any> {
    const key = evalKey(payload);

    const hit = evalCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
        evalStats.hits++;
        // Refresh LRU position.
        evalCache.delete(key);
        evalCache.set(key, hit);
        return hit.value;
    }

    const pending = evalInFlight.get(key);
    if (pending) {
        evalStats.coalesced++;
        return pending;
    }

    evalStats.misses++;
    const promise = (async () => {
        try {
            const result = await evaluateRemote(payload);
            if (result && typeof result.oilGuardScore === 'number') {
                evalCache.set(key, { value: result, expiresAt: Date.now() + EVAL_CACHE_TTL_MS });
                evictEvalCache();
            }
            return result;
        } catch (error) {
            console.error('[WATHIQ] Evaluation failed', error);
            throw error;
        } finally {
            evalInFlight.delete(key);
        }
    })();

    evalInFlight.set(key, promise);
    return promise;
}
