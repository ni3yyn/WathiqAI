/**
 * Auth configuration (all from env; nothing secret has to live on the agent server).
 *
 *   AUTH_MODE            off | optional | required      (default: off → today's behaviour)
 *   FIREBASE_PROJECT_ID  e.g. "my-app-12345"            (required when AUTH_MODE != off)
 *   FIREBASE_WEB_API_KEY optional — enables the revoked/disabled-account check
 *   FIRESTORE_DATABASE_ID default "(default)"
 *   AUTH_ALLOW_ANONYMOUS  true|false (default false) — Firebase anonymous users are treated as guests unless true
 *   USER_CACHE_FRESH_MS   default 60000     (served without refetching)
 *   USER_CACHE_STALE_MS   default 900000    (served while refreshing in the background)
 *   USER_CACHE_MAX        default 500       (LRU size, users)
 *   FIRESTORE_TIMEOUT_MS  default 8000
 *   RATE_CHAT_PER_MIN     default 20
 *   OVERLAY_FILE / OVERLAY_SALT
 */
export type AuthMode = 'off' | 'optional' | 'required';

const int = (v: string | undefined, d: number) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };

export interface AuthConfig {
    mode: AuthMode;
    projectId: string;
    webApiKey?: string;
    databaseId: string;
    allowAnonymous: boolean;
    freshMs: number;
    staleMs: number;
    cacheMax: number;
    firestoreTimeoutMs: number;
    chatPerMinute: number;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
    const raw = (env.AUTH_MODE || 'off').toLowerCase();
    const mode: AuthMode = raw === 'required' || raw === 'optional' ? raw : 'off';
    return {
        mode,
        projectId: (env.FIREBASE_PROJECT_ID || '').trim(),
        webApiKey: env.FIREBASE_WEB_API_KEY?.trim() || undefined,
        databaseId: env.FIRESTORE_DATABASE_ID || '(default)',
        allowAnonymous: env.AUTH_ALLOW_ANONYMOUS === 'true',
        freshMs: int(env.USER_CACHE_FRESH_MS, 60_000),
        staleMs: int(env.USER_CACHE_STALE_MS, 15 * 60_000),
        cacheMax: int(env.USER_CACHE_MAX, 500),
        firestoreTimeoutMs: int(env.FIRESTORE_TIMEOUT_MS, 8_000),
        chatPerMinute: int(env.RATE_CHAT_PER_MIN, 20),
    };
}
