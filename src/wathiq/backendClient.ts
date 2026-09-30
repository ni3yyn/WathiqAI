import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const WATHIQ_EVALUATE_URL = process.env.WATHIQ_EVALUATE_URL || 'https://oilguard-backend.vercel.app/api/evaluate.js';
const WATHIQ_CATALOG_URL = process.env.WATHIQ_CATALOG_URL || 'https://cdn.jsdelivr.net/gh/ni3yyn/prdcts@main/finalcatalog506.json';
const LOCAL_CATALOG_PATH = path.join(process.cwd(), 'data', 'catalog.json');

// In-memory cache for the catalog
let catalogCache: any[] | null = null;
let lastFetch = 0;
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

export async function getProducts(): Promise<any[]> {
    if (catalogCache && Date.now() - lastFetch < CACHE_TTL) {
        return catalogCache;
    }

    // Try reading from local disk cache first (instant 5ms)
    try {
        if (fs.existsSync(LOCAL_CATALOG_PATH)) {
            const fileData = fs.readFileSync(LOCAL_CATALOG_PATH, 'utf-8');
            const parsed = JSON.parse(fileData);
            if (Array.isArray(parsed) && parsed.length > 0) {
                catalogCache = parsed;
                lastFetch = Date.now();
                return parsed;
            }
        }
    } catch (e) {
        // Fall back to network fetch
    }

    try {
        const response = await fetch(WATHIQ_CATALOG_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch catalog: ${response.statusText}`);
        }
        const data = await response.json();
        catalogCache = data;
        lastFetch = Date.now();

        // Save to disk asynchronously so subsequent runs are instant
        try {
            const dir = path.dirname(LOCAL_CATALOG_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(LOCAL_CATALOG_PATH, JSON.stringify(data), 'utf-8');
        } catch (e) {
            // Ignore disk write errors
        }

        return data;
    } catch (error) {
        console.error('[WATHIQ] Failed to load product catalog', error);
        throw error;
    }
}

export async function evaluateProduct(payload: any): Promise<any> {
    try {
        const response = await fetch(WATHIQ_EVALUATE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Evaluation API failed: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error('[WATHIQ] Evaluation failed', error);
        throw error;
    }
}
