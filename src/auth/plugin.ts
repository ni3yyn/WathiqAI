/**
 * Fastify integration: verifies the Firebase ID token on every protected request,
 * derives the uid FROM THE TOKEN (never from the body), scopes sessions per user,
 * preloads the user's data into the RAM cache, rate-limits, and exposes /api/me/*.
 *
 * Modes (AUTH_MODE): off (default, today's behaviour) | optional (guests allowed,
 * a BAD token is still rejected) | required.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthConfig, loadAuthConfig } from './config';
import { AuthError, AuthIdentity, TokenVerifier, createTokenVerifier, parseBearer } from './verifyToken';
import { createFirestoreClient, FirestoreClient } from './firestoreRest';
import { UserDataService, ShelfMatcher, UserContext } from './userData';
import { OverlayStore } from './overlay';
import { createShelfProvider, createCatalogShelfMatcher } from './shelfProvider';
import { setShelfProvider, listItems, updateItem, removeItem, summarizeCabinet, ShelfProvider } from '../agent/cabinet';
import { setUserContextResolver, setPrefsStore } from '../agent/userContext';
import { forgetUser } from '../agent/longterm';

declare module 'fastify' {
    interface FastifyRequest { auth: AuthIdentity | null; authToken: string | null }
}

export interface AuthRuntime {
    config: AuthConfig;
    verifier: TokenVerifier | null;
    users: UserDataService;
    overlay: OverlayStore;
    provider: ShelfProvider;
    limiter: RateLimiter;
}

export function createAuthRuntime(config: AuthConfig = loadAuthConfig(), deps: { verifier?: TokenVerifier; firestore?: FirestoreClient; overlay?: OverlayStore; matcher?: ShelfMatcher; now?: () => number } = {}): AuthRuntime {
    const verifier = deps.verifier || (config.mode !== 'off'
        ? createTokenVerifier({ projectId: config.projectId, allowAnonymous: config.allowAnonymous, webApiKey: config.webApiKey })
        : null);
    const firestore = deps.firestore || createFirestoreClient({ projectId: config.projectId || 'unset', databaseId: config.databaseId, timeoutMs: config.firestoreTimeoutMs });
    const users = new UserDataService({ config, firestore, matcher: deps.matcher || createCatalogShelfMatcher(), now: deps.now, log: m => console.warn(`[AUTH] ${m}`) });
    const overlay = deps.overlay || new OverlayStore();
    return { config, verifier, users, overlay, provider: createShelfProvider(users, overlay), limiter: new RateLimiter(deps.now) };
}

/** connects the auth layer to the agent (shelf = app shelf, profile resolver, prefs) */
export function wireAgent(rt: AuthRuntime) {
    setShelfProvider(rt.provider);
    setUserContextResolver((uid: string): UserContext | null => rt.users.peek(uid));
    setPrefsStore({ get: uid => rt.overlay.get(uid).prefs, set: (uid, p) => {
        const cur = rt.overlay.get(uid).prefs;
        if (cur.register === p.register && cur.city === p.city && cur.climateZone === p.climateZone) return;   // no disk write when nothing changed
        rt.overlay.mutate(uid, o => { o.prefs = { ...o.prefs, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) }; });
    } });
}

// ── token bucket rate limiter (per uid, or per IP for guests) ────────────────
export class RateLimiter {
    private buckets = new Map<string, { tokens: number; at: number }>();
    constructor(private now: () => number = Date.now) {}
    take(key: string, perMinute: number): { ok: boolean; retryAfterS: number } {
        const t = this.now();
        const b = this.buckets.get(key) || { tokens: perMinute, at: t };
        b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
        b.at = t;
        if (b.tokens < 1) { this.buckets.set(key, b); return { ok: false, retryAfterS: Math.ceil(((1 - b.tokens) / perMinute) * 60) }; }
        b.tokens -= 1;
        this.buckets.delete(key); this.buckets.set(key, b);
        if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value as string);
        return { ok: true, retryAfterS: 0 };
    }
}

const PROTECTED = ['/api/chat', '/api/me', '/api/auth', '/api/share', '/api/routine', '/api/cabinet', '/api/feedback', '/api/contributions', '/api/parse-contribution', '/api/memory'];
const SESSION_PATHS = ['/api/chat', '/api/share', '/api/routine', '/api/feedback'];
const isProtected = (p: string) => PROTECTED.some(x => p === x || p.startsWith(`${x}/`));
const starts = (p: string, list: string[]) => list.some(x => p === x || p.startsWith(`${x}/`));

const STATUS: Record<string, number> = { missing_token: 401, malformed: 401, invalid_signature: 401, expired: 401, wrong_audience: 401, wrong_issuer: 401, invalid_claims: 401, anonymous_not_allowed: 403, revoked: 401, auth_unavailable: 503 };

export function scopeSession(auth: AuthIdentity | null, raw: any): string | undefined {
    const r = typeof raw === 'string' ? raw.slice(0, 100).replace(/[^\w\-:.@]/g, '') : '';
    if (auth) {
        const prefix = `u:${auth.uid}:`;
        // The scoped key is returned to the client and sent back on later turns.
        // Do not prefix our own namespace again on every request.
        if (r.startsWith(prefix)) return `${prefix}${r.slice(prefix.length) || 'default'}`;
        return `${prefix}${r || 'default'}`;
    }
    return r ? `g:${r}` : undefined;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p, new Promise<null>(res => { const t = setTimeout(() => res(null), ms); (t as any).unref?.(); })]);

export function installAuth(server: FastifyInstance, rt: AuthRuntime) {
    server.decorateRequest('auth', null);
    server.decorateRequest('authToken', null);
    const { config } = rt;

    const deny = (reply: FastifyReply, status: number, code: string, message?: string) => {
        reply.header('WWW-Authenticate', `Bearer error="${code}"`);
        return reply.status(status).send({ error: code, message: message || code });
    };

    // ── 1. identity ──────────────────────────────────────────────────────────
    server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        request.auth = null; request.authToken = null;
        if (config.mode === 'off' || request.method === 'OPTIONS') return;
        const path = request.url.split('?')[0];
        if (!isProtected(path)) return;

        if (path === '/api/cabinet' || path.startsWith('/api/cabinet/')) {
            return reply.status(410).send({ error: 'gone', message: 'The userId-based cabinet is disabled when auth is on. Use /api/me/shelf.' });
        }

        const header = request.headers.authorization;
        const token = parseBearer(header);
        if (header && !token) return deny(reply, 401, 'malformed', 'Authorization header must be "Bearer <Firebase ID token>"');
        if (!token) {
            if (config.mode === 'required') return deny(reply, 401, 'missing_token');
            const g = rt.limiter.take(`ip:${request.ip}`, path === '/api/chat' ? config.chatPerMinute : 120);
            if (!g.ok) return reply.header('Retry-After', String(g.retryAfterS)).status(429).send({ error: 'rate_limited' });
            return;                                                        // guest
        }
        try {
            const id = await rt.verifier!.verify(token);
            request.auth = id; request.authToken = token;
            rt.users.markAuthenticated(id.uid, id.expiresAt * 1000);
        } catch (e: any) {
            const code = e instanceof AuthError ? e.code : 'malformed';
            return deny(reply, STATUS[code] || 401, code);
        }
        const lim = rt.limiter.take(`uid:${request.auth!.uid}${path === '/api/chat' ? ':chat' : ''}`, path === '/api/chat' ? config.chatPerMinute : 120);
        if (!lim.ok) return reply.header('Retry-After', String(lim.retryAfterS)).status(429).send({ error: 'rate_limited' });
    });

    // ── 2. body sanitising + session scoping + data preload ──────────────────
    server.addHook('preHandler', async (request: FastifyRequest) => {
        if (config.mode === 'off') return;
        const path = request.url.split('?')[0];
        if (!isProtected(path)) return;
        const auth = request.auth;
        const body: any = request.body && typeof request.body === 'object' ? request.body : null;
        const query: any = request.query && typeof request.query === 'object' ? request.query : null;

        if (body) {
            // identity fields are NEVER taken from the client when auth is on
            delete body.authenticated;
            if (path === '/api/chat') { delete body.rememberMe; }
            if (auth) body.userId = auth.uid; else delete body.userId;
            if (starts(path, SESSION_PATHS)) body.sessionId = scopeSession(auth, body.sessionId);
        }
        if (query && starts(path, SESSION_PATHS) && 'sessionId' in query) query.sessionId = scopeSession(auth, query.sessionId);

        if (path === '/api/chat' && body) {
            if (auth) {
                body.authenticated = true;
                await withTimeout(rt.users.get(auth, request.authToken!, { force: body.refreshUserData === true }), 4000);
            }
            delete body.refreshUserData;
        }
    });

    // ── 3. /api/me ───────────────────────────────────────────────────────────
    const needAuth = (request: FastifyRequest, reply: FastifyReply): AuthIdentity | null => {
        if (!request.auth) { deny(reply, 401, 'missing_token'); return null; }
        return request.auth;
    };

    server.get('/api/me', async (request, reply) => {
        const id = needAuth(request, reply); if (!id) return;
        const ctx = await rt.users.get(id, request.authToken!);
        return {
            uid: id.uid, email: id.email, provider: id.provider,
            name: ctx?.profile.name, gender: ctx?.profile.gender, language: ctx?.profile.language,
            skinType: ctx?.profile.skinType, scalpType: ctx?.profile.scalpType,
            onboardingComplete: ctx?.profile.onboardingComplete ?? null,
            shelfCount: ctx?.shelf.length ?? 0,
            routineSteps: ctx ? { am: ctx.routines.am.length, pm: ctx.routines.pm.length } : null,
            degraded: !ctx, version: ctx?.version ?? null,
        };
    });

    server.get('/api/me/shelf', async (request, reply) => {
        const id = needAuth(request, reply); if (!id) return;
        await rt.users.get(id, request.authToken!);
        const items = listItems(id.uid);
        return { items, summary: summarizeCabinet(items) };
    });

    server.patch('/api/me/shelf/:id', async (request, reply) => {
        const id = needAuth(request, reply); if (!id) return;
        const b = (request.body || {}) as any;
        await rt.users.get(id, request.authToken!);
        const item = updateItem(id.uid, (request.params as any).id, { status: b.status, verdict: b.verdict, note: b.note, reason: b.reason });
        if (!item) return reply.status(404).send({ error: 'item_not_found' });
        return { item, summary: summarizeCabinet(listItems(id.uid)) };
    });

    server.delete('/api/me/shelf/:id', async (request, reply) => {
        const id = needAuth(request, reply); if (!id) return;
        await rt.users.get(id, request.authToken!);
        if (!removeItem(id.uid, (request.params as any).id)) return reply.status(404).send({ error: 'item_not_found' });
        return { ok: true, note: 'Hidden from the assistant only; your saved products in the app are untouched.' };
    });

    server.post('/api/auth/refresh', async (request, reply) => {
        const id = needAuth(request, reply); if (!id) return;
        const ctx = await rt.users.get(id, request.authToken!, { force: true });
        return { ok: !!ctx, version: ctx?.version ?? null, shelfCount: ctx?.shelf.length ?? 0 };
    });

    server.post('/api/auth/logout', async (request, reply) => {
        const id = needAuth(request, reply); if (!id) return;
        rt.users.purge(id.uid);
        return { ok: true };
    });

    server.delete('/api/me/agent-data', async (request, reply) => {
        const id = needAuth(request, reply); if (!id) return;
        const overlay = rt.overlay.delete(id.uid);
        const memory = forgetUser(id.uid);
        rt.users.purge(id.uid);
        return { ok: true, erased: { overlay, longTermMemory: memory } };
    });
}
