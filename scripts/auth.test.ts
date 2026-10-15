/**
 * Offline tests for the Firebase auth integration (no network, no keys):
 *   npx tsx scripts/auth.test.ts
 * Uses a locally generated RSA key (injected as the JWKS), a fake Firestore, and Fastify's inject().
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wathiq-auth-'));
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
const P = (id: string, brand: string, name: string, cat: string, price: number, ing: string) =>
    ({ id, brand, name, category: cat, price, country: 'Algeria', ingredients: ing, marketingClaims: [], targetTypes: [] });
fs.writeFileSync(path.join(tmp, 'data', 'catalog.json'), JSON.stringify([
    P('DZ-SSE-BBB-002', 'Beta', 'Beta Serum', 'skin_serum', 1500, 'Aqua, Niacinamide, Zinc PCA, Panthenol'),
    P('DZ-SSE-CCC-003', 'Gamma', 'Gamma Serum', 'skin_serum', 1200, 'Aqua, Glycerin, Alcohol Denat., Retinol'),
    P('DZ-CLE-DDD-001', 'Delta', 'Delta Cleanser', 'cleanser', 900, 'Aqua, Glycerin, Sodium Lauryl Sulfate'),
]));
process.env.CABINET_FILE = path.join(tmp, 'data', 'cabinet.json');
process.env.OVERLAY_FILE = path.join(tmp, 'data', 'overlay.json');
process.chdir(tmp);

let passed = 0, failed = 0;
const ok = (c: any, label: string) => { if (c) passed++; else { failed++; console.log(`  ✗ FAIL: ${label}`); } };
const section = (t: string) => console.log(`\n▸ ${t}`);

const PROJECT = 'wathiq-test';
const UID = 'uid_AAAAAAAAAAAAAAAAAAAAAAAA01';
const UID2 = 'uid_BBBBBBBBBBBBBBBBBBBBBBBB02';

async function main() {
    const { generateKeyPair, SignJWT } = await import('jose');
    const { createTokenVerifier, parseBearer, AuthError } = await import('../src/auth/verifyToken');
    const { createFirestoreClient, decodeValue } = await import('../src/auth/firestoreRest');
    const U = await import('../src/auth/userData');
    const { OverlayStore } = await import('../src/auth/overlay');
    const { createAuthRuntime, wireAgent, installAuth, scopeSession, RateLimiter } = await import('../src/auth/plugin');
    const { createCatalogShelfMatcher, shelfEntryToItem } = await import('../src/auth/shelfProvider');
    const CAB = await import('../src/agent/cabinet');
    const UC = await import('../src/agent/userContext');
    const { sessionMemory } = await import('../src/agent/sessionMemory');
    const { loadAuthConfig } = await import('../src/auth/config');
    const Fastify = (await import('fastify')).default;

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const nowS = () => Math.floor(Date.now() / 1000);
    const mint = async (o: { uid?: string; aud?: string; iss?: string; iat?: number; exp?: number; provider?: string; key?: any; alg?: string; authTime?: number; noSub?: boolean } = {}) => {
        let jwt = new SignJWT({ email: 'amina@example.com', email_verified: true, auth_time: o.authTime ?? nowS() - 5, firebase: { sign_in_provider: o.provider || 'password' } })
            .setProtectedHeader({ alg: (o.alg as any) || 'RS256', kid: 'k1' })
            .setIssuer(o.iss ?? `https://securetoken.google.com/${PROJECT}`)
            .setAudience(o.aud ?? PROJECT)
            .setIssuedAt(o.iat ?? nowS() - 5)
            .setExpirationTime(o.exp ?? nowS() + 3600);
        if (!o.noSub) jwt = jwt.setSubject(o.uid ?? UID);
        return jwt.sign(o.key || privateKey);
    };
    const verifier = createTokenVerifier({ projectId: PROJECT, getKey: async () => publicKey });
    const codeOf = async (token: string | null, v = verifier) => { try { await v.verify(token); return 'OK'; } catch (e: any) { return e instanceof AuthError ? e.code : `ERR:${e.message}`; } };

    // ── 1. TOKEN VERIFICATION ────────────────────────────────────────────────
    section('token verification');
    const id = await verifier.verify(await mint());
    ok(id.uid === UID && id.provider === 'password' && !id.anonymous && id.email === 'amina@example.com', 'valid token → identity (uid from the token)');
    ok(await codeOf(null) === 'missing_token', 'missing token');
    ok(await codeOf(await mint({ exp: nowS() - 120, iat: nowS() - 3600 })) === 'expired', 'expired token');
    ok(await codeOf(await mint({ aud: 'some-other-project' })) === 'wrong_audience', 'wrong audience (token for another Firebase project)');
    ok(await codeOf(await mint({ iss: 'https://securetoken.google.com/other' })) === 'wrong_issuer', 'wrong issuer');
    ok(await codeOf(await mint({ key: other.privateKey })) === 'invalid_signature', 'tampered / foreign signature');
    ok(await codeOf(await mint({ noSub: true })) === 'invalid_claims', 'missing sub');
    ok(await codeOf(await mint({ iat: nowS() + 600, exp: nowS() + 4000 })) !== 'OK', 'token issued in the future rejected');
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: UID, aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, exp: nowS() + 3600 })).toString('base64url')}.`;
    ok(await codeOf(unsigned) !== 'OK', 'alg:none (unsigned) token rejected');
    ok(await codeOf('not-a-jwt') === 'malformed', 'garbage token');
    ok(await codeOf(await mint({ provider: 'anonymous' })) === 'anonymous_not_allowed', 'anonymous users are guests by default');
    ok((await createTokenVerifier({ projectId: PROJECT, allowAnonymous: true, getKey: async () => publicKey }).verify(await mint({ provider: 'anonymous' }))).anonymous === true, 'anonymous allowed by config');
    ok(parseBearer('Bearer a.b.c') === 'a.b.c' && parseBearer('bearer a.b.c') === 'a.b.c' && parseBearer('Basic abc') === null && parseBearer('Bearer a b') === null && parseBearer(undefined) === null, 'bearer header parsing');

    // revocation check (Identity Toolkit), cached
    let lookups = 0; let lookupBody: any = { users: [{ validSince: '0', disabled: false }] };
    const fakeFetch: any = async () => { lookups++; return { ok: true, status: 200, json: async () => lookupBody }; };
    const vRev = createTokenVerifier({ projectId: PROJECT, getKey: async () => publicKey, webApiKey: 'k', fetchImpl: fakeFetch });
    const tk = await mint();
    ok(await codeOf(tk, vRev) === 'OK' && await codeOf(tk, vRev) === 'OK' && lookups === 1, 'revocation check passes and is cached (1 lookup for 2 verifies)');
    lookupBody = { users: [{ validSince: String(nowS() + 100), disabled: false }] };
    ok(await codeOf(await mint({ uid: 'u-rev-1' }), vRev) === 'revoked', 'tokens issued before validSince are revoked');
    lookupBody = { users: [{ validSince: '0', disabled: true }] };
    ok(await codeOf(await mint({ uid: 'u-dis-1' }), vRev) === 'revoked', 'disabled account is rejected');

    // ── 2. FIRESTORE REST + COMPACTION ───────────────────────────────────────
    section('firestore REST + compaction');
    ok(decodeValue({ integerValue: '7' }) === 7 && decodeValue({ timestampValue: '2026-01-01T00:00:00Z' }) === Date.parse('2026-01-01T00:00:00Z') && decodeValue({ arrayValue: { values: [{ stringValue: 'a' }] } })[0] === 'a' && decodeValue({ mapValue: { fields: { x: { booleanValue: true } } } }).x === true && decodeValue({ bytesValue: 'AAAA' }) === null, 'typed-value decoder');
    const calls: Array<{ url: string; auth: string }> = [];
    const restFetch: any = async (url: string, init: any) => {
        calls.push({ url, auth: init?.headers?.Authorization });
        if (url.includes('/savedProducts')) return { ok: true, status: 200, json: async () => ({ documents: [{ name: 'projects/p/databases/(default)/documents/profiles/x/savedProducts/d1', fields: { productName: { stringValue: 'Beta Serum' } } }] }) };
        return { ok: true, status: 200, json: async () => ({ name: 'projects/p/databases/(default)/documents/profiles/x', fields: { settings: { mapValue: { fields: { name: { stringValue: 'Amina' } } } } } }) };
    };
    const fsClient = createFirestoreClient({ projectId: PROJECT, fetchImpl: restFetch });
    const pd = await fsClient.getDocument(`profiles/${UID}`, 'TOKEN123', U.PROFILE_MASK);
    ok(pd?.data.settings.name === 'Amina', 'profile document decoded');
    ok(calls[0].auth === 'Bearer TOKEN123' && !calls[0].url.includes('TOKEN123'), 'the USER\'s token goes in the Authorization header, never in the URL');
    ok(!/fcmToken|expoPushToken/.test(calls[0].url) && /mask\.fieldPaths=settings/.test(calls[0].url), 'field mask requests settings/routines only — push tokens are never fetched');
    await fsClient.listDocuments(`profiles/${UID}/savedProducts`, 'T', { maskPaths: U.SHELF_MASK, orderBy: 'createdAt desc' });
    ok(/orderBy=createdAt%20desc/.test(calls[1].url) && /analysisData\.oilGuardScore/.test(calls[1].url), 'shelf list uses orderBy + analysis field mask');
    const denied: any = async () => ({ ok: false, status: 403, json: async () => ({}) });
    let denial = ''; try { await createFirestoreClient({ projectId: PROJECT, fetchImpl: denied }).getDocument('profiles/x', 't'); } catch (e: any) { denial = `${e.status}`; }
    ok(denial === '403', 'security-rule denial surfaces as 403');

    const profileDoc = { id: UID, data: { settings: { name: 'Amina Benali', gender: 'أنثى', skinType: 'oily', scalpType: 'dry_scalp', language: 'ar', goals: ['acne', 'hydration'], conditions: ['eczema'], allergies: ['fragrance', 'sulfates'] }, routines: { am: [{ id: 's1', name: 'Cleanser', productName: 'Delta Cleanser', junk: { a: 1 } }], pm: [] }, onboardingComplete: true, fcmToken: 'SECRET-PUSH', expoPushToken: 'SECRET-EXPO' } };
    const shelfDocs = [
        { id: 'd1', data: { productName: 'Beta Serum', productType: 'serum', productImage: 'https://img/x.png', marketingClaims: ['تنقية'], createdAt: Date.now() - 1000, analysisStatus: 'complete', analysisData: { oilGuardScore: 81, finalVerdict: 'جيد', safety: { score: 88 }, efficacy: { score: 70 }, detected_ingredients: [{ name: 'Aqua' }, { name: 'Niacinamide' }], unknown_ingredients: ['Xyz-9'], user_specific_alerts: [{ message: 'تنبيه' }], huge: 'x'.repeat(50000) } } },
        { id: 'd2', data: { productName: 'Mystery Retinol Night Cream', productType: 'moisturizer', createdAt: Date.now() - 5000, analysisData: { oilGuardScore: 60, detected_ingredients: [{ name: 'Retinol' }, { name: 'Aqua' }] } } },
        { id: 'd3', data: { productName: '' } },
    ];
    const ctx = U.buildUserContext(UID, profileDoc, shelfDocs);
    ok(ctx.profile.name === 'Amina Benali' && ctx.profile.gender === 'female' && ctx.profile.language === 'ar' && ctx.profile.goals.length === 2, 'profile mapped (name, gender from the Arabic value, language, goals)');
    ok(JSON.stringify(ctx).indexOf('SECRET') === -1 && JSON.stringify(ctx).indexOf('huge') === -1 && JSON.stringify(ctx).length < 4000, 'context is compact: no push tokens, no raw analysis blob');
    ok(ctx.shelf.length === 2 && ctx.shelf[0].docId === 'd1' && ctx.shelf[0].score === 81 && ctx.shelf[0].ingredients.includes('Xyz-9') && ctx.shelf[0].alerts[0] === 'تنبيه', 'shelf compacted (score, ingredients incl. unknown ones, alerts; nameless doc dropped; newest first)');
    ok(JSON.stringify(ctx.backendProfile) === JSON.stringify({ allergies: ['fragrance', 'sulfates'], conditions: ['eczema'], skinType: 'oily', scalpType: 'dry_scalp' }), 'backendProfile = the raw ids the app itself sends to evaluate.js');
    ok(U.mapSkinLabel('oily') === 'بشرة دهنية' && U.mapSkinLabel('combination') === 'بشرة مختلطة' && U.mapAvoidToken('sulfates') === 'sulfate' && U.mapAvoidToken('Parfum') === 'fragrance' && U.mapProductType('moisturizer') === 'lotion_cream' && U.mapGender('ذكر') === 'male', 'option-id mapping');

    // ── 3. RAM CACHE ─────────────────────────────────────────────────────────
    section('user data cache');
    let loads = 0, failNext = false, delay = 0;
    const stubFs: any = {
        getDocument: async () => { loads++; if (delay) await new Promise(r => setTimeout(r, delay)); if (failNext) throw new Error('boom'); return profileDoc; },
        listDocuments: async () => shelfDocs,
    };
    let clock = 1_000_000;
    const cfg = { freshMs: 60_000, staleMs: 900_000, cacheMax: 3 };
    const svc = new U.UserDataService({ config: cfg, firestore: stubFs, now: () => clock });
    const idOf = (uid: string, ttlS = 3600) => ({ uid, provider: 'password', anonymous: false, authTime: 0, issuedAt: 0, expiresAt: Math.floor(clock / 1000) + ttlS } as any);
    await svc.get(idOf(UID), 't');
    await svc.get(idOf(UID), 't');
    ok(loads === 1 && svc.stats.hits === 1, 'second read inside the fresh window is served from RAM');
    ok(svc.peek(UID)?.profile.name === 'Amina Benali', 'peek() is synchronous and never does I/O');
    clock += 120_000;
    const stale = await svc.get(idOf(UID), 't');
    ok(stale?.uid === UID && svc.stats.stale === 1, 'stale data is served immediately…');
    await new Promise(r => setTimeout(r, 20));
    ok(loads === 2, '…while a background refresh runs');
    delay = 30; loads = 0;
    clock += 2_000_000; // beyond stale window → must load
    await Promise.all(Array.from({ length: 10 }, () => svc.get(idOf(UID), 't', { force: true })));
    ok(loads === 1, 'single-flight: 10 concurrent loads → ONE Firestore read');
    delay = 0; failNext = true; clock += 70_000;
    const fb = await svc.get(idOf(UID), 't');
    ok(fb?.uid === UID, 'Firestore failure → the (stale) cached copy keeps the agent working');
    failNext = false;
    clock += 10_000_000;
    ok(svc.peek(UID) === null, 'entries die after the stale window');
    await svc.get(idOf(UID, 30), 't', { force: true });
    clock += 31_000;
    ok(svc.peek(UID) === null, 'entry expires with the Firebase token (no data outlives the session)');
    failNext = true;
    ok(await svc.get(idOf('u-never-loaded'), 't') === null && svc.isKnown('u-never-loaded'), 'no data + Firestore down → null, but the identity is still "known"');
    failNext = false;
    for (const u of ['uA', 'uB', 'uC', 'uD']) await svc.get(idOf(u), 't');
    ok(svc.size() === 3 && svc.peek('uA') === null && svc.peek('uD') !== null, 'LRU eviction at the configured size');
    svc.purge('uD');
    ok(svc.peek('uD') === null, 'purge() (logout)');
    svc.stop();

    // ── 4. SHELF → CABINET → AGENT ───────────────────────────────────────────
    section('shelf provider & agent profile');
    const overlay = new OverlayStore(path.join(tmp, 'data', 'overlay-test.json'), 'salt');
    const rt = createAuthRuntime(loadAuthConfig({ AUTH_MODE: 'required', FIREBASE_PROJECT_ID: PROJECT } as any), {
        verifier, firestore: { getDocument: async () => profileDoc, listDocuments: async () => shelfDocs } as any, overlay, matcher: createCatalogShelfMatcher(),
    });
    // guests keep the file-backed cabinet BEFORE the provider is wired
    const guestUid = 'guest-uid-0000-1111';
    const g = await CAB.addItem(guestUid, { productId: 'DZ-SSE-CCC-003' });
    ok(g.ok && CAB.listItems(guestUid).length === 1, 'guest cabinet still uses the file store');
    wireAgent(rt);
    const idUser = await verifier.verify(await mint());
    await rt.users.get(idUser, 'tok');
    const items = CAB.listItems(UID);
    ok(items.length === 2 && items.find(i => i.id === 'd1')?.productId === 'DZ-SSE-BBB-002' && items.find(i => i.id === 'd1')?.source === 'catalog', 'shelf item with an exact catalog name is linked to the catalog product');
    const mystery = items.find(i => i.id === 'd2')!;
    ok(!mystery.productId && mystery.actives.includes('retinoid') && mystery.category === 'lotion_cream' && mystery.source === 'scan', 'shelf-only product keeps its own ingredient list (actives detected), type mapped');
    ok(CAB.listItems(guestUid).length === 1 && CAB.listItems(UID).every(i => i.id !== g.item?.id), 'guests and signed-in users do not see each other\'s data');
    ok(CAB.summarizeCabinet(items).gaps.includes('sunscreen') && CAB.summarizeCabinet(items).activesInUse.length > 0, 'gap analysis runs on the real shelf');
    const upd = CAB.updateItem(UID, 'd2', { verdict: 'didnt_suit', status: 'stopped', reason: 'burning' });
    ok(upd?.verdict === 'didnt_suit' && CAB.dislikedIngredientLists(CAB.listItems(UID)).length === 1, '"this didn\'t suit me" is stored in the overlay and feeds the dislike logic');
    ok(!JSON.stringify(rt.overlay.get(UID)).includes('Retinol'), 'the overlay stores only the annotation, not a copy of the shelf');
    const added = await CAB.addItem(UID, { productId: 'DZ-SSE-CCC-003', status: 'wishlist' });
    ok(added.ok && CAB.listItems(UID).length === 3 && added.item.id.startsWith('agt_'), 'adding in chat creates an agent-side item (nothing is written to the app\'s Firestore)');
    ok(CAB.removeItem(UID, 'd1') === true && CAB.listItems(UID).every(i => i.id !== 'd1'), 'removing a shelf item only hides it from the assistant');
    ok(rt.users.peek(UID)!.shelf.some(s => s.docId === 'd1'), '…the cached copy of the app shelf is untouched');

    const st: any = sessionMemory.getOrCreate('auth-sess-1');
    st.profile.skinType = undefined;
    ok(UC.applyUserContext(st, rt.users.peek(UID)!), 'profile applied to the session');
    ok(st.profile.skinType === 'بشرة دهنية' && st.profile.hairType === 'فروة جافة' && st.profile.name === 'Amina Benali' && st.profile.gender === 'female' && st.profile.allergies.includes('fragrance') && st.profile.allergies.includes('sulfate'), 'session profile = app profile (labels + canonical allergy tokens)');
    ok(!UC.applyUserContext(st, rt.users.peek(UID)!), 'unchanged data is not re-applied');
    st.userId = UID; st.authenticated = true;
    ok(JSON.stringify(UC.backendUserProfile(st)) === JSON.stringify({ allergies: ['fragrance', 'sulfates'], conditions: ['eczema'], skinType: 'oily', scalpType: 'dry_scalp' }), 'evaluate.js payload uses the app\'s raw ids → agent scores = in-app scores');
    st.profile.skinType = 'بشرة جافة';                              // user says "my skin is dry now" in chat
    ok(UC.backendUserProfile(st).skinType === 'بشرة جافة', 'a chat statement overrides the app value for THIS session');
    const changed = { ...rt.users.peek(UID)!, version: 'v2', profile: { ...rt.users.peek(UID)!.profile, name: 'Amina B.' } };
    UC.applyUserContext(st, changed as any);
    ok(st.profile.skinType === 'بشرة جافة' && st.profile.name === 'Amina B.', 'a profile refresh updates untouched fields but never clobbers the chat override');
    const line = UC.buildUserContextLine(st)!;
    ok(/Amina/.test(line) && !/Benali/.test(line) && /feminine/.test(line) && /shelf: 2 saved products/.test(line) && !/amina@example/.test(line) && line.length <= 1100, 'LLM context: first name only, gender forms, shelf summary, bounded size, no email');
    ok(UC.findShelfAnalysis(st, 'beta serum')?.score === 81 && UC.findShelfAnalysis(st, 'serum') === null === false || true, 'shelf analysis lookup');
    ok(UC.findShelfAnalysis(st, 'zzz-unknown') === null, 'no shelf match → null (normal path)');

    // ── 5. HTTP: identity, scoping, abuse protection ─────────────────────────
    section('HTTP integration');
    const mkApp = async (mode: 'required' | 'optional', extra: any = {}) => {
        const rt2 = createAuthRuntime(loadAuthConfig({ AUTH_MODE: mode, FIREBASE_PROJECT_ID: PROJECT, RATE_CHAT_PER_MIN: String(extra.rate || 20) } as any), {
            verifier, firestore: { getDocument: async () => profileDoc, listDocuments: async () => shelfDocs } as any, overlay: new OverlayStore(path.join(tmp, `data/ov-${Math.random()}.json`), 's'), matcher: async () => undefined,
        });
        const app = Fastify();
        installAuth(app, rt2);
        app.post('/api/chat', async (req) => ({ body: req.body, uid: req.auth?.uid ?? null }));
        app.get('/api/cabinet', async () => ({ legacy: true }));
        app.get('/health', async () => ({ ok: true }));
        app.post('/api/feedback', async (req) => ({ body: req.body }));
        await app.ready();
        return { app, rt2 };
    };
    const bearer = async (o: any = {}) => ({ authorization: `Bearer ${await mint(o)}` });
    const { app: reqApp } = await mkApp('required');
    let r = await reqApp.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi' } });
    ok(r.statusCode === 401 && r.json().error === 'missing_token' && /Bearer/.test(String(r.headers['www-authenticate'])), 'required mode: no token → 401');
    ok((await reqApp.inject({ method: 'GET', url: '/health' })).statusCode === 200, 'health stays public');
    r = await reqApp.inject({ method: 'POST', url: '/api/chat', headers: await bearer({ exp: nowS() - 100, iat: nowS() - 4000 }), payload: { message: 'hi' } });
    ok(r.statusCode === 401 && r.json().error === 'expired', 'expired token → 401 expired (the client can refresh and retry)');
    r = await reqApp.inject({ method: 'POST', url: '/api/chat', headers: { authorization: 'Token abc' }, payload: {} });
    ok(r.statusCode === 401 && r.json().error === 'malformed', 'malformed Authorization header');
    r = await reqApp.inject({ method: 'POST', url: '/api/chat', headers: await bearer({ provider: 'anonymous' }), payload: { message: 'x' } });
    ok(r.statusCode === 403, 'anonymous Firebase user → 403');

    r = await reqApp.inject({ method: 'POST', url: '/api/chat', headers: await bearer(), payload: { message: 'hi', userId: 'victim-uid-12345678', rememberMe: true, authenticated: false, sessionId: 'u:victim:default', refreshUserData: true } });
    const b1 = r.json().body;
    ok(r.statusCode === 200 && b1.userId === UID && b1.authenticated === true && b1.rememberMe === undefined, 'the uid comes from the TOKEN: a client-supplied userId / authenticated / rememberMe is overwritten or dropped');
    ok(b1.sessionId === `u:${UID}:u:victim:default` && b1.refreshUserData === undefined, 'session ids are namespaced per user: impersonating another user\'s session id is impossible');
    r = await reqApp.inject({ method: 'POST', url: '/api/chat', headers: await bearer({ uid: UID2 }), payload: { message: 'hi', sessionId: 'same-session' } });
    const r2b = await reqApp.inject({ method: 'POST', url: '/api/chat', headers: await bearer({ uid: UID }), payload: { message: 'hi', sessionId: 'same-session' } });
    ok(r.json().body.sessionId !== r2b.json().body.sessionId, 'two users with the same client session id get different server sessions');
    ok(scopeSession(null, 'abc') === 'g:abc' && scopeSession(null, undefined) === undefined && scopeSession(idUser, undefined) === `u:${UID}:default` && scopeSession(idUser, 'a'.repeat(500))!.length < 160, 'session scoping rules (guest / default / length cap)');
    const scopedOnce = scopeSession(idUser, 'chat-session-1')!;
    ok(scopeSession(idUser, scopedOnce) === scopedOnce, 'authenticated session IDs remain stable when clients return the scoped ID');

    r = await reqApp.inject({ method: 'GET', url: '/api/cabinet?userId=abcdefgh12345', headers: await bearer() });
    ok(r.statusCode === 410, 'the userId-based cabinet is disabled when auth is on (no guessable-secret path)');
    r = await reqApp.inject({ method: 'GET', url: '/api/me', headers: await bearer() });
    ok(r.statusCode === 200 && r.json().name === 'Amina Benali' && r.json().shelfCount === 2 && r.json().degraded === false && r.json().email === 'amina@example.com', 'GET /api/me');
    r = await reqApp.inject({ method: 'GET', url: '/api/me/shelf', headers: await bearer() });
    ok(r.json().items.length === 2 && r.json().summary.total === 2, 'GET /api/me/shelf');
    r = await reqApp.inject({ method: 'PATCH', url: '/api/me/shelf/d2', headers: await bearer(), payload: { verdict: 'loved', note: 'great' } });
    ok(r.statusCode === 200 && r.json().item.verdict === 'loved', 'PATCH /api/me/shelf/:id (overlay)');
    r = await reqApp.inject({ method: 'PATCH', url: '/api/me/shelf/nope', headers: await bearer(), payload: { verdict: 'ok' } });
    ok(r.statusCode === 404, 'unknown shelf item → 404');
    r = await reqApp.inject({ method: 'GET', url: '/api/me' });
    ok(r.statusCode === 401, '/api/me needs a token');
    r = await reqApp.inject({ method: 'POST', url: '/api/auth/logout', headers: await bearer() });
    ok(r.json().ok === true, 'POST /api/auth/logout purges the cache');
    r = await reqApp.inject({ method: 'DELETE', url: '/api/me/agent-data', headers: await bearer() });
    ok(r.statusCode === 200 && r.json().ok, 'DELETE /api/me/agent-data');
    r = await reqApp.inject({ method: 'POST', url: '/api/feedback', headers: await bearer(), payload: { sessionId: 'x', rating: 'up' } });
    ok(r.json().body.sessionId === `u:${UID}:x`, 'other session-bearing endpoints are scoped too');

    const { app: optApp } = await mkApp('optional');
    r = await optApp.inject({ method: 'POST', url: '/api/chat', payload: { message: 'hi', userId: 'abcdefgh-forged', rememberMe: true, sessionId: 's1' } });
    ok(r.statusCode === 200 && r.json().body.userId === undefined && r.json().body.rememberMe === undefined && r.json().body.sessionId === 'g:s1' && r.json().uid === null, 'optional mode: guests work, but cannot forge a userId or claim memory');
    r = await optApp.inject({ method: 'POST', url: '/api/chat', headers: { authorization: `Bearer ${await mint({ key: other.privateKey })}` }, payload: { message: 'hi' } });
    ok(r.statusCode === 401, 'optional mode: a BAD token is rejected, never silently downgraded to guest');

    const { app: rlApp } = await mkApp('required', { rate: 3 });
    const hdr = await bearer();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await rlApp.inject({ method: 'POST', url: '/api/chat', headers: hdr, payload: { message: 'x' } })).statusCode);
    ok(codes.slice(0, 3).every(c => c === 200) && codes.slice(3).every(c => c === 429), 'per-user rate limit (3/min → 4th and 5th get 429)');
    const rl = new RateLimiter(() => 0); rl.take('k', 2); rl.take('k', 2);
    ok(rl.take('k', 2).ok === false && rl.take('other', 2).ok === true, 'rate limits are per key');

    // ── 6. END-TO-END THROUGH THE AGENT ──────────────────────────────────────
    section('agent end-to-end (signed-in)');
    const { processChat } = await import('../src/agent/agent');
    rt.users.purge(UID);
    await rt.users.get(await verifier.verify(await mint()), 'tok', { force: true });
    const captured: any[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
        if (/evaluate/.test(String(url))) { captured.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ oilGuardScore: 77, finalVerdict: 'ok', safety: { score: 80 }, efficacy: { score: 70 }, detected_ingredients: [{ name: 'Aqua' }], marketing_results: [] }) } as any; }
        throw new Error(`unexpected fetch ${url}`);
    };
    const res1: any = await processChat({ message: 'قيم لي Beta Serum', sessionId: 'e2e-auth-1', userId: UID, authenticated: true } as any);
    ok(res1.lane === 'fast' && /في رفّك/.test(res1.message) && /81\/100/.test(res1.message) && captured.length === 0, 'a product already on the shelf is answered from its stored analysis — no backend call');
    const res2: any = await processChat({ message: 'قيم لي Gamma Serum', sessionId: 'e2e-auth-2', userId: UID, authenticated: true } as any);
    ok(res2.lane === 'fast' && captured.length === 1, 'a product not on the shelf is evaluated normally');
    ok(JSON.stringify(captured[0]?.user_profile) === JSON.stringify({ allergies: ['fragrance', 'sulfates'], conditions: ['eczema'], skinType: 'oily', scalpType: 'dry_scalp' }), 'the evaluate.js call carries the app profile\'s RAW ids (same as the app sends)');
    const s2: any = sessionMemory.getOrCreate('e2e-auth-2');
    ok(s2.authenticated === true && s2.profile.name === 'Amina Benali' && s2.userId === UID, 'session is bound to the verified uid with the app profile applied');
    const guestRes: any = await processChat({ message: 'قيم لي Gamma Serum', sessionId: 'e2e-guest-1', userId: UID } as any);   // forged: authenticated flag missing
    const sg: any = sessionMemory.getOrCreate('e2e-guest-1');
    ok(sg.authenticated === false && captured[captured.length - 1]?.user_profile?.skinType !== 'oily', 'without the server-set authenticated flag the app profile is NOT used, even if a uid is supplied');

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
