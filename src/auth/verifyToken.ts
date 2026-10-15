/**
 * Firebase ID-token verification WITHOUT a service account.
 *
 * Checks (per Firebase's documented rules): RS256 only, signature against Google's
 * public JWKS (cached/rotated by `jose`), iss = https://securetoken.google.com/<project>,
 * aud = <project>, exp / iat / auth_time, non-empty `sub` (= uid).
 * Optional: a revocation / disabled-account check through Identity Toolkit
 * (needs the web API key), cached for 5 minutes.
 *
 * Tokens are never logged or stored by this module.
 */
import { jwtVerify, createRemoteJWKSet, errors, type JWTVerifyGetKey } from 'jose';

export type AuthErrorCode =
    | 'missing_token' | 'malformed' | 'invalid_signature' | 'expired'
    | 'wrong_audience' | 'wrong_issuer' | 'invalid_claims' | 'anonymous_not_allowed' | 'revoked' | 'auth_unavailable';

export class AuthError extends Error {
    constructor(public code: AuthErrorCode, message?: string) { super(message || code); this.name = 'AuthError'; }
}

export interface AuthIdentity {
    uid: string;
    email?: string;
    emailVerified?: boolean;
    provider: string;            // password | google.com | anonymous | …
    anonymous: boolean;
    authTime: number;            // seconds
    issuedAt: number;            // seconds
    expiresAt: number;           // seconds
}

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const SKEW_S = 5;

export interface VerifierOptions {
    projectId: string;
    allowAnonymous?: boolean;
    /** inject a key resolver (tests) — defaults to Google's remote JWKS */
    getKey?: JWTVerifyGetKey | CryptoKey;
    webApiKey?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;                       // ms
}

export interface TokenVerifier {
    verify(token: string | undefined | null): Promise<AuthIdentity>;
}

export function parseBearer(header: string | string[] | undefined): string | null {
    const h = Array.isArray(header) ? header[0] : header;
    if (!h) return null;
    const m = /^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)\s*$/i.exec(h.trim());
    return m ? m[1] : null;
}

export function createTokenVerifier(opts: VerifierOptions): TokenVerifier {
    if (!opts.projectId) throw new Error('FIREBASE_PROJECT_ID is required to verify tokens');
    const now = opts.now || Date.now;
    const fetchImpl = opts.fetchImpl || fetch;
    const keyOrGetter: any = opts.getKey || createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30_000, cacheMaxAge: 6 * 3600_000 });
    const revokedCache = new Map<string, { ok: boolean; until: number }>();

    async function checkRevoked(token: string, id: AuthIdentity): Promise<void> {
        if (!opts.webApiKey) return;
        const key = `${id.uid}:${id.issuedAt}`;
        const hit = revokedCache.get(key);
        if (hit && hit.until > now()) { if (!hit.ok) throw new AuthError('revoked'); return; }
        let res: Response;
        try {
            res = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(opts.webApiKey)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }),
                signal: AbortSignal.timeout(5000),
            });
        } catch { throw new AuthError('auth_unavailable', 'revocation check unreachable'); }
        if (res.status === 400) { revokedCache.set(key, { ok: false, until: now() + 300_000 }); throw new AuthError('revoked'); }
        if (!res.ok) throw new AuthError('auth_unavailable', `lookup ${res.status}`);
        const body: any = await res.json();
        const u = body?.users?.[0];
        const validSince = parseInt(u?.validSince || '0', 10);
        const bad = !u || u.disabled === true || (validSince > 0 && validSince > id.issuedAt);
        revokedCache.set(key, { ok: !bad, until: now() + 300_000 });
        if (bad) throw new AuthError('revoked');
    }

    return {
        async verify(token) {
            if (!token) throw new AuthError('missing_token');
            let payload: any;
            try {
                const out = await jwtVerify(token, keyOrGetter, {
                    algorithms: ['RS256'],
                    issuer: `https://securetoken.google.com/${opts.projectId}`,
                    audience: opts.projectId,
                    clockTolerance: SKEW_S,
                    currentDate: new Date(now()),
                });
                payload = out.payload;
            } catch (e: any) {
                if (e instanceof errors.JWTExpired) throw new AuthError('expired');
                if (e instanceof errors.JWTClaimValidationFailed) {
                    if (e.claim === 'aud') throw new AuthError('wrong_audience');
                    if (e.claim === 'iss') throw new AuthError('wrong_issuer');
                    throw new AuthError('invalid_claims', e.claim);
                }
                if (e instanceof errors.JWSSignatureVerificationFailed || e instanceof errors.JWKSNoMatchingKey || e instanceof errors.JOSEAlgNotAllowed) throw new AuthError('invalid_signature');
                if (e instanceof errors.JWKSTimeout || e?.code === 'ERR_JWKS_TIMEOUT' || e?.name === 'TypeError' && /fetch/i.test(e.message)) throw new AuthError('auth_unavailable', 'JWKS unreachable');
                throw new AuthError('malformed');
            }

            const uid = payload.sub;
            if (typeof uid !== 'string' || !uid || uid.length > 128) throw new AuthError('invalid_claims', 'sub');
            const nowS = Math.floor(now() / 1000);
            if (typeof payload.auth_time === 'number' && payload.auth_time > nowS + SKEW_S) throw new AuthError('invalid_claims', 'auth_time');
            if (typeof payload.iat === 'number' && payload.iat > nowS + SKEW_S) throw new AuthError('invalid_claims', 'iat');

            const provider = String(payload.firebase?.sign_in_provider || 'unknown');
            const anonymous = provider === 'anonymous';
            if (anonymous && !opts.allowAnonymous) throw new AuthError('anonymous_not_allowed');

            const identity: AuthIdentity = {
                uid,
                email: typeof payload.email === 'string' ? payload.email : undefined,
                emailVerified: payload.email_verified === true,
                provider, anonymous,
                authTime: payload.auth_time ?? payload.iat ?? nowS,
                issuedAt: payload.iat ?? nowS,
                expiresAt: payload.exp,
            };
            await checkRevoked(token, identity);
            return identity;
        },
    };
}
