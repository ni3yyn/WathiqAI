import fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

import { processChat, streamChat } from './agent/agent';
import { getProducts } from './wathiq/backendClient';
import { runAutonomousWorker } from './autonomous_worker';
import { parseContributionImages } from './agent/contributionParser';
import { sessionMemory } from './agent/sessionMemory';
import { forgetUser, LONGTERM_ENABLED } from './agent/longterm';
import { buildRoutineShare, buildShoppingList } from './agent/outputs';
import { recordFeedback, feedbackStats } from './agent/feedback';
import { submitContribution, listContributions, decideContribution } from './agent/contributions';
import { listReviewQueue, decideReview } from './agent/learning';
import { mergeApprovedIntoCatalog } from './wathiq/backendClient';
import crypto from 'crypto';
import { loadAuthConfig } from './auth/config';
import { createAuthRuntime, wireAgent, installAuth } from './auth/plugin';
import { versionsOf, currentVersion, restoreVersion } from './agent/routineHistory';
import {
    isValidUserId, listItems, addItem, updateItem, removeItem, clearCabinet, summarizeCabinet,
} from './agent/cabinet';

dotenv.config();

// Public build marker so deployment checks can confirm which agent release is running.
const WATHIQ_AGENT_VERSION = '6.5.1';

// Non-blocking catalog warm-up: in a long-lived server, fetch the catalog
// during boot instead of making the first user's search pay the cold-start cost.
// getProducts deduplicates concurrent calls and applies a short cooldown on failure.
void getProducts()
    .then(products => console.log(`[WATHIQ][WARMUP] catalog ready products=${products.length}`))
    .catch(error => console.warn(`[WATHIQ][WARMUP] catalog not ready yet: ${error?.message || error}`));

// bodyLimit raised so chat can carry up to two base64 label photos (scan lane).
const server = fastify({ logger: true, bodyLimit: 14 * 1024 * 1024 });

// ─── 1. FASTIFY CORS REGISTRATION (NO TOP-LEVEL AWAIT -> ZERO TS ERRORS) ─────
server.register(cors, {
    origin: true, // Dynamically reflects origin (localhost:3000, localhost:5173, production domains)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
});

// ─── 1b. AUTH (Firebase ID tokens) — must be installed BEFORE the routes ─────
// AUTH_MODE=off (default) keeps today's behaviour. See src/auth/config.ts for all settings.
const authConfig = loadAuthConfig();
if (authConfig.mode !== 'off') {
    if (!authConfig.projectId) {
        console.error('[AUTH] AUTH_MODE is on but FIREBASE_PROJECT_ID is not set — refusing to start.');
        process.exit(1);
    }
    const authRuntime = createAuthRuntime(authConfig);
    wireAgent(authRuntime);
    installAuth(server, authRuntime);
    console.log(`[AUTH] mode=${authConfig.mode} project=${authConfig.projectId} revocationCheck=${authConfig.webApiKey ? 'on' : 'off'} anonymous=${authConfig.allowAnonymous}`);
}

// ─── 2. LIGHTWEIGHT HEALTH PING ENDPOINT (FOR UPTIMEROBOT) ───────────────────
server.get('/health', async (request, reply) => {
    return {
        status: 'alive',
        version: WATHIQ_AGENT_VERSION,
        timestamp: Date.now(),
        uptime: process.uptime(),
        sessions: sessionMemory.stats(), // per-session memory diagnostics
    };
});

// ─── 3. ROOT LANDING PAGE ───────────────────────────────────────────────────
server.get('/', async (request, reply) => {
    try {
        let htmlPath = path.join(process.cwd(), 'public', 'index.html');
        if (!fs.existsSync(htmlPath)) {
            htmlPath = path.join(process.cwd(), 'src', 'public', 'index.html');
        }
        const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
        return reply.type('text/html').send(htmlContent);
    } catch (e) {
        return { status: 'ok', name: 'Wathiq Intelligence MVP Agent', endpoint: 'POST /api/chat' };
    }
});

// ─── 4. SMART PARSE ENDPOINT FOR CONTRIBUTIONS DASHBOARD ────────────────────
server.post('/api/parse-contribution', async (request, reply) => {
    try {
        const body = request.body as any;
        if (!body || (!body.frontImage && !body.inciImage)) {
            return reply.status(400).send({ error: 'Missing image URLs' });
        }

        const result = await parseContributionImages({
            frontImage: body.frontImage,
            inciImage: body.inciImage,
            brandHint: body.brand,
            nameHint: body.name
        });

        return reply.status(200).send(result);
    } catch (error: any) {
        console.error('[SERVER] Smart Parse Error:', error);
        return reply.status(500).send({ error: 'Failed to parse images', details: error?.message || error });
    }
});

// ─── 5. CHAT ENDPOINT (SSE STREAMING + JSON FALLBACK) ───────────────────────
server.post('/api/chat', async (request, reply) => {
    try {
        const body = request.body as any;
        if (!body || !body.message) {
            return reply.status(400).send({ type: 'error', message: 'Missing message in request body' });
        }

        console.log(`[AGENT] request received: ${body.message}`);

        const wantsStream = body.stream === true || request.headers.accept?.includes('text/event-stream');

        if (wantsStream) {
            reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            // Client closed the tab / connection dropped → stop generating
            // (the old code kept streaming and burning model tokens).
            const abortController = new AbortController();
            reply.raw.on('close', () => {
                if (!reply.raw.writableEnded) abortController.abort();
            });

            const sendSSE = (eventData: any) => {
                if (reply.raw.writableEnded || reply.raw.destroyed) return;
                reply.raw.write(`data: ${JSON.stringify(eventData)}\n\n`);
            };

            try {
                const finalResult = await streamChat(body, {
                    onStatus: (status: string) => {
                        sendSSE({ type: 'status', status });
                    },
                    onTextDelta: (delta: string) => {
                        sendSSE({ type: 'text-delta', delta });
                    },
                    onCardReady: (cardType: string, data: any) => {
                        sendSSE({ type: 'card', cardType, data });
                    }
                }, { abortSignal: abortController.signal });

                sendSSE({ type: 'finish', data: finalResult });
            } catch (err: any) {
                console.error('[AGENT] Stream error:', err);
                sendSSE({ type: 'error', message: err.message || 'Stream processing failed' });
            } finally {
                if (!reply.raw.writableEnded) reply.raw.end();
            }

            return;
        }

        // Non-streaming fallback for curl / standard JSON
        const result = await processChat(body);
        return reply.status(200).send(result);
    } catch (error: any) {
        console.error('[AGENT] Error processing chat', error);
        return reply.status(500).send({
            type: 'error',
            message: 'An internal error occurred',
            details: error?.message || error
        });
    }
});

// ─── 5b. OPT-IN MEMORY: ERASE EVERYTHING WE STORED FOR A USER ───────────────
// Works even when LONGTERM_MEMORY is currently off, so consent can always be withdrawn.
server.post('/api/memory/forget', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body.userId !== 'string' || !body.userId) {
        return reply.status(400).send({ error: 'Missing userId' });
    }
    const erased = forgetUser(body.userId);
    return reply.status(200).send({ ok: true, erased, memoryEnabled: LONGTERM_ENABLED });
});

// ─── 5d. PRACTICAL OUTPUTS (share card, shopping list, routine versions) ──────
// Pure logic from the agent; the frontend only renders the structures.
const sessionOf = (src: any) => (typeof src?.sessionId === 'string' && src.sessionId ? sessionMemory.getOrCreate(src.sessionId) : null);
const validLang = (l: any): 'ar' | 'dz' | 'fr' | 'en' => (['ar', 'dz', 'fr', 'en'].includes(l) ? l : 'ar');
const looksLikeRoutine = (r: any) => r && Array.isArray(r.steps) && r.steps.length > 0 && r.steps.every((s: any) => s?.product?.id);

server.post('/api/share/routine', async (request, reply) => {
    const body = (request.body || {}) as any;
    const routine = looksLikeRoutine(body.routine) ? body.routine : sessionOf(body)?.lastRoutine;
    if (!looksLikeRoutine(routine)) return reply.status(404).send({ error: 'No routine to share (send sessionId of a session that built one, or the routine object).' });
    return buildRoutineShare(routine, validLang(body.lang), { appName: typeof body.appName === 'string' ? body.appName.slice(0, 40) : undefined });
});

server.post('/api/share/shopping-list', async (request, reply) => {
    const body = (request.body || {}) as any;
    const st = sessionOf(body);
    const routine = looksLikeRoutine(body.routine) ? body.routine : st?.lastRoutine;
    const products = Array.isArray(body.products) ? body.products.slice(0, 20) : (!routine ? st?.lastProductResults?.slice(0, 6) : undefined);
    if (!routine && !(products && products.length)) return reply.status(404).send({ error: 'Nothing to build a list from.' });
    const cabinet = isValidUserId(body.userId) ? listItems(body.userId) : [];
    return buildShoppingList({ routine, products, cabinet, budget: typeof body.budget === 'number' ? body.budget : undefined, lang: validLang(body.lang) });
});

server.get('/api/routine/versions', async (request, reply) => {
    const st = sessionOf(request.query);
    if (!st) return reply.status(400).send({ error: 'Missing sessionId' });
    const cur = currentVersion(st);
    return { current: cur?.n ?? null, versions: versionsOf(st).map(v => ({ version: v.n, label: v.label, at: v.at, totalCost: v.routine.totalCost, stepsCount: v.routine.steps.length })) };
});

server.post('/api/routine/restore', async (request, reply) => {
    const body = (request.body || {}) as any;
    const st = sessionOf(body);
    if (!st || typeof body.version !== 'number') return reply.status(400).send({ error: 'Missing sessionId or version' });
    const v = restoreVersion(st, body.version);
    if (!v) return reply.status(404).send({ error: 'version_not_found' });
    return { restored: v.n, routine: st.lastRoutine };
});

// ─── 5e. TRANSPARENCY & LEARNING ──────────────────────────────────────────────
// 👍/👎 (+ optional correction). No message text is stored; a correction is only STAGED —
// it must pass the judge / support / human-review policy before it can ever be retrieved.
server.post('/api/feedback', async (request, reply) => {
    const b = (request.body || {}) as any;
    const r = recordFeedback({
        sessionId: typeof b.sessionId === 'string' ? b.sessionId : '',
        messageId: typeof b.messageId === 'string' ? b.messageId : undefined,
        rating: b.rating, reason: typeof b.reason === 'string' ? b.reason.slice(0, 40) : undefined,
        correction: typeof b.correction === 'string' ? b.correction.slice(0, 500) : undefined,
    });
    return reply.status(r.ok ? 200 : 400).send(r);
});

// Contribute a product that is not in the catalog (moderated).
server.post('/api/contributions', async (request, reply) => {
    const b = (request.body || {}) as any;
    const who = (isValidUserId(b.userId) ? b.userId : (typeof b.sessionId === 'string' ? b.sessionId : request.ip)) || 'anon';
    const r = submitContribution({ brand: b.brand, name: b.name, category: b.category, ingredients: b.ingredients, quantity: b.quantity, targetTypes: b.targetTypes, marketingClaims: b.marketingClaims, image: b.image }, who);
    return reply.status(r.ok ? 200 : r.error === 'rate_limited' ? 429 : 400).send(r);
});

// Admin (moderation). Disabled unless ADMIN_TOKEN is set; send it as the x-admin-token header.
const adminOk = (request: any): boolean => {
    const expected = process.env.ADMIN_TOKEN;
    const got = String(request.headers['x-admin-token'] || '');
    if (!expected || !got) return false;
    const a = Buffer.from(got), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

server.get('/api/admin/review-queue', async (request, reply) => (adminOk(request) ? { items: listReviewQueue() } : reply.status(403).send({ error: 'forbidden' })));

server.post('/api/admin/review/:id', async (request, reply) => {
    if (!adminOk(request)) return reply.status(403).send({ error: 'forbidden' });
    const b = (request.body || {}) as any;
    if (b.decision !== 'approve' && b.decision !== 'reject') return reply.status(400).send({ error: 'decision must be approve|reject' });
    const embedText = async (texts: string[]) => {
        const { embedMany } = await import('ai');
        const { cohere } = await import('@ai-sdk/cohere');
        const { embeddings } = await embedMany({ model: cohere.textEmbeddingModel('embed-multilingual-v3.0'), values: texts, providerOptions: { cohere: { inputType: 'search_document' } } });
        return embeddings;
    };
    const r = await decideReview((request.params as any).id, b.decision, { text: typeof b.text === 'string' ? b.text : undefined, embedText });
    return reply.status(r.ok ? 200 : 404).send(r);
});

server.get('/api/admin/contributions', async (request, reply) => {
    if (!adminOk(request)) return reply.status(403).send({ error: 'forbidden' });
    const status = ['pending', 'approved', 'rejected'].includes((request.query as any)?.status) ? (request.query as any).status : 'pending';
    return { items: listContributions(status) };
});

server.post('/api/admin/contributions/:id', async (request, reply) => {
    if (!adminOk(request)) return reply.status(403).send({ error: 'forbidden' });
    const b = (request.body || {}) as any;
    if (b.decision !== 'approve' && b.decision !== 'reject') return reply.status(400).send({ error: 'decision must be approve|reject' });
    const r = decideContribution((request.params as any).id, b.decision, { note: b.note, patch: b.patch });
    if (r.ok && b.decision === 'approve') mergeApprovedIntoCatalog();     // live immediately, no refetch
    return reply.status(r.ok ? 200 : 404).send(r);
});

server.get('/api/admin/feedback-stats', async (request, reply) => (adminOk(request) ? feedbackStats() : reply.status(403).send({ error: 'forbidden' })));

// ─── 5c. MY CABINET (REST for the frontend) ───────────────────────────────────
// The userId is a bearer secret: use a long random id (UUID v4) generated by the
// client. Rows are stored under a salted hash of it.
const cabinetUser = (src: any): string | null => (isValidUserId(src?.userId) ? src.userId : null);

server.get('/api/cabinet', async (request, reply) => {
    const uid = cabinetUser(request.query);
    if (!uid) return reply.status(400).send({ error: 'Missing or invalid userId (8–128 chars: letters, digits, _ - : . @)' });
    const items = listItems(uid);
    return { items, summary: summarizeCabinet(items) };
});

server.post('/api/cabinet/items', async (request, reply) => {
    const body = request.body as any;
    const uid = cabinetUser(body);
    if (!uid) return reply.status(400).send({ error: 'Missing or invalid userId' });
    const r = await addItem(uid, {
        productId: body.productId, productName: body.productName, brand: body.brand, name: body.name,
        ingredientsText: body.ingredientsText, category: body.category, status: body.status,
        verdict: body.verdict, note: body.note, quantity: body.quantity, source: body.source,
    });
    if (!r.ok) {
        const code = r.error === 'ambiguous' ? 409 : r.error === 'cabinet_full' ? 413 : r.error === 'not_found' ? 404 : 400;
        return reply.status(code).send({ error: r.error, candidates: r.candidates });
    }
    const items = listItems(uid);
    return reply.status(r.created ? 201 : 200).send({ item: r.item, created: r.created, overlap: r.overlap.map(o => ({ withId: o.item.id, with: `${o.item.brand} ${o.item.name}`, sharedActives: o.sharedActives })), summary: summarizeCabinet(items) });
});

server.patch('/api/cabinet/items/:id', async (request, reply) => {
    const body = request.body as any;
    const uid = cabinetUser(body);
    if (!uid) return reply.status(400).send({ error: 'Missing or invalid userId' });
    const item = updateItem(uid, (request.params as any).id, { status: body.status, verdict: body.verdict, note: body.note, reason: body.reason });
    if (!item) return reply.status(404).send({ error: 'item_not_found' });
    return { item, summary: summarizeCabinet(listItems(uid)) };
});

server.delete('/api/cabinet/items/:id', async (request, reply) => {
    const uid = cabinetUser(request.query);
    if (!uid) return reply.status(400).send({ error: 'Missing or invalid userId' });
    if (!removeItem(uid, (request.params as any).id)) return reply.status(404).send({ error: 'item_not_found' });
    return { ok: true, summary: summarizeCabinet(listItems(uid)) };
});

server.delete('/api/cabinet', async (request, reply) => {
    const uid = cabinetUser(request.query);
    if (!uid) return reply.status(400).send({ error: 'Missing or invalid userId' });
    return { ok: true, removed: clearCabinet(uid) };
});

// ─── 5c. STATIC UI ASSETS (SAME ORIGIN AS THE AGENT API) ─────────────────────
// The modular UI fetches its HTML fragments and JS/CSS from /components and
// /assets. Keep these files on the same origin as /api/chat so the redesign
// and the existing agent are connected without a separate API host or CORS hop.
const PUBLIC_ROOT = path.resolve(process.cwd(), 'public');
const STATIC_CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

server.get('/*', async (request, reply) => {
    const relativePath = String((request.params as any)?.['*'] || '').replace(/^[/\\]+/, '');
    if (!relativePath || relativePath.includes('\0')) {
        return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    }

    const filePath = path.resolve(PUBLIC_ROOT, relativePath);
    if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
        return reply.code(403).type('text/plain; charset=utf-8').send('Forbidden');
    }

    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) {
            return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        }
        const contentType = STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        reply.type(contentType);
        reply.header('Cache-Control', path.extname(filePath).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=3600');
        return reply.send(fs.createReadStream(filePath));
    } catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
            return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        }
        request.log.error({ err: error, filePath }, '[STATIC] Failed to serve public asset');
        return reply.code(500).type('text/plain; charset=utf-8').send('Unable to serve asset');
    }
});

// ─── 6. AUTONOMOUS NIGHTLY WORKER SCHEDULE (3:00 AM) ────────────────────────
cron.schedule('0 3 * * *', async () => {
    try {
        await runAutonomousWorker();
    } catch (e) {
        console.error('[CRON] Autonomous worker failed:', e);
    }
});

const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── 7. SERVER STARTUP & CATALOG CACHE WARM-UP ───────────────────────────────
const start = async () => {
    try {
        // Warm the catalog cache before opening the port
        try {
            const products = await getProducts();
            server.log.info(`[STARTUP] Catalog warmed: ${products.length} products cached`);
        } catch (warmErr) {
            server.log.warn({ err: warmErr }, '[STARTUP] Catalog warm-up failed, will retry lazily on first request');
        }

        await server.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`Wathiq Intelligence MVP Agent listening on http://localhost:${PORT}`);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();