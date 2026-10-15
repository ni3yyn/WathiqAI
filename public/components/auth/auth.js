        // ===== AUTH CONFIG =====
        const FIREBASE_CONFIG = { apiKey: "AIzaSyCOfYdRtv4Qxd270-Y0SaGa3I6uxTSKhsM", authDomain: "whatheeq.firebaseapp.com", projectId: "whatheeq", appId: "1:964917104358:web:736b30f5cf90985fa07527" };
        const ENABLE_GOOGLE = true;
        const REQUIRE_LOGIN = false;
        const FIREBASE_VERSION = '10.14.1';
        let initializeApp, getAuth, onAuthStateChanged, signInWithEmailAndPassword, GoogleAuthProvider;
        let signInWithPopup, sendPasswordResetEmail, signOut, browserLocalPersistence, setPersistence;
        let firebaseSdkReady = false;

        // Start optional Firebase imports in the background. Do not top-level-await
        // a third-party CDN before exposing apiFetch: guest chat should boot even
        // when auth's CDN is slow or unavailable.
        const firebaseSdkPromise = (async () => {
            try {
                const sdk = await Promise.race([
                    Promise.all([
                        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
                        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`)
                    ]).then(([appSdk, authSdk]) => ({ appSdk, authSdk })),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase SDK CDN timeout')), 6500))
                ]);
                ({ initializeApp } = sdk.appSdk);
                ({ getAuth, onAuthStateChanged, signInWithEmailAndPassword, GoogleAuthProvider,
                    signInWithPopup, sendPasswordResetEmail, signOut, browserLocalPersistence, setPersistence
                } = sdk.authSdk);
                firebaseSdkReady = true;
            } catch (error) {
                console.warn('[Wathiq] Firebase SDK unavailable; guest mode remains enabled.', error);
            }
            return firebaseSdkReady;
        })();

        // ===== AUTH UI STRINGS =====
        const STR = {
            ar: {
                loading: 'جارٍ التحقق من الجلسة…', loginTitle: 'تسجيل الدخول', appAccountHint: 'أنشئ حسابك في تطبيق وثيق.',
                email: 'البريد الإلكتروني', password: 'كلمة المرور', signIn: 'تسجيل الدخول', google: 'المتابعة عبر Google',
                forgot: 'نسيت كلمة المرور؟', guestLink: 'متابعة كضيف', personalized: 'سجّل الدخول لتجربة مخصصة',
                signOut: 'تسجيل الخروج', refresh: 'تحديث بياناتي', accountDetails: 'ملفي ورفّي', myShelf: 'رفّي',
                shelfExplanation: 'هذه الملاحظات تؤثر على المساعد فقط ولا تغيّر بيانات التطبيق.', privacy: 'الخصوصية',
                erase: 'محو ما خزّنه المساعد عني', profileUnavailable: 'الملف الشخصي غير متاح مؤقتًا',
                sessionEnded: 'انتهت جلستك، يرجى تسجيل الدخول مجددًا', realAccount: 'يرجى تسجيل الدخول بحساب حقيقي للمتابعة',
                tooMany: 'رسائل كثيرة. حاول مجددًا بعد {n} ث', unavailable: 'الخدمة غير متاحة مؤقتًا، يرجى المحاولة لاحقًا',
                resetSent: 'إذا كان الحساب موجودًا، فستصلك رسالة لإعادة تعيين كلمة المرور.',
                signInError: 'تعذر تسجيل الدخول. تحقق من البيانات وحاول مجددًا.',
                resetError: 'تعذر إرسال رسالة إعادة التعيين. حاول مجددًا.', refreshed: 'تم تحديث بياناتك للمحادثة التالية.',
                confirmErase: 'هل تريد محو كل ما خزّنه المساعد عنك؟ لا يمكن التراجع عن ذلك.', erased: 'تم طلب محو بيانات المساعد.',
                loved: 'أعجبني', ok: 'مقبول', didnt_suit: 'لم يناسبني', using: 'أستخدمه', finished: 'انتهى',
                wishlist: 'قائمة الرغبات', stopped: 'توقفت عن استخدامه', note: 'ملاحظة', save: 'حفظ', hide: 'إخفاء عن المساعد',
                noShelf: 'لا توجد منتجات في الرف.', priceNA: 'السعر غير متوفر', saveError: 'تعذر حفظ التغيير.'
            },
            en: {
                loading: 'Checking your session…', loginTitle: 'Sign in', appAccountHint: 'Create your account in the Wathiq app.',
                email: 'Email', password: 'Password', signIn: 'Sign in', google: 'Continue with Google',
                forgot: 'Forgot password?', guestLink: 'Continue as guest', personalized: 'Sign in for a personalized experience',
                signOut: 'Sign out', refresh: 'Refresh my data', accountDetails: 'My profile & shelf', myShelf: 'My shelf',
                shelfExplanation: 'These notes affect the assistant only, not the app data.', privacy: 'Privacy',
                erase: 'Erase what the assistant stored about me', profileUnavailable: 'Profile temporarily unavailable',
                sessionEnded: 'Your session ended, please sign in again', realAccount: 'Please sign in with a real account to continue',
                tooMany: 'Too many messages, try again in {n} s', unavailable: 'Service temporarily unavailable, please retry',
                resetSent: 'If an account exists, a password reset email will be sent.',
                signInError: 'Could not sign in. Check your details and try again.',
                resetError: 'Could not send the reset email. Please try again.', refreshed: 'Your data will refresh on the next chat message.',
                confirmErase: 'Erase everything the assistant stored about you? This cannot be undone.', erased: 'Assistant data erase requested.',
                loved: 'Loved', ok: 'Okay', didnt_suit: "Didn't suit", using: 'Using', finished: 'Finished',
                wishlist: 'Wishlist', stopped: 'Stopped', note: 'Note', save: 'Save', hide: 'Hide from assistant',
                noShelf: 'No products in your shelf.', priceNA: 'Price n/a', saveError: 'Could not save that change.'
            }
        };

        const $ = (id) => document.getElementById(id);
        let auth = null;
        let activeLanguage = document.documentElement.lang === 'ar' ? 'ar' : 'en';
        let signedOutPromise = null;
        let tokenRefreshInProgress = null;
        let rateLimitTimer = null;
        let hadAuthUser = false;
        let profileCache = null;
        let shelfCache = [];
        let authStateResolved = false;
        const t = (key) => (STR[activeLanguage] || STR.en)[key] || STR.en[key] || key;

        function updateLanguage(language) {
            activeLanguage = language === 'ar' ? 'ar' : 'en';
            document.documentElement.lang = ['ar', 'fr', 'en'].includes(language) ? language : activeLanguage;
            document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
            document.querySelectorAll('[data-auth-label]').forEach((el) => {
                el.textContent = t(el.dataset.authLabel);
            });
            $('authIconBtn')?.setAttribute('aria-label', activeLanguage === 'ar' ? 'تسجيل الدخول' : 'Sign in');
            $('shelfIconBtn')?.setAttribute('aria-label', activeLanguage === 'ar' ? 'رفّي' : 'My shelf');
        }
        updateLanguage(activeLanguage);

        function setStatus(message, kind = 'normal') {
            const box = $('authStatus');
            if (!message) {
                box.hidden = true;
                box.textContent = '';
                return;
            }
            box.textContent = message;
            box.className = `auth-banner mx-auto mt-2 w-full max-w-3xl ${kind === 'error' ? 'bg-red-100 text-red-800' : 'bg-sage-100 text-sage-800'}`;
            box.hidden = false;
        }

        function syncSignedOutUI(message = '') {
            $('accountPanel').hidden = true;
            $('loginPanel').hidden = false;
            $('authLoading').hidden = true;
            $('authIconBtn').setAttribute('aria-label', activeLanguage === 'ar' ? 'تسجيل الدخول' : 'Sign in');
            $('authIconBtn').title = activeLanguage === 'ar' ? 'تسجيل الدخول' : 'Sign in';
            $('chatMain').hidden = REQUIRE_LOGIN;
            if (message) setStatus(message, 'error');
        }

        function openModal(dialog) {
            if (!dialog.open) dialog.showModal();
        }

        function closeModal(dialog) {
            if (dialog.open) dialog.close();
        }

        function clearAccountData() {
            profileCache = null;
            shelfCache = [];
            $('authGreeting').textContent = '';
            $('profileNote').textContent = '';
            $('profileNote').hidden = true;
            $('shelfItems').replaceChildren();
            $('shelfCount').textContent = '';
            window._wathiqRefreshUserDataNextMessage = false;
            window._wathiqRateLimitUntil = 0;
            window.refreshChatSendState?.();
            window.resetChatForAuth?.();
        }

        async function signOutLocally(reason) {
            if (signedOutPromise) return signedOutPromise;
            signedOutPromise = (async () => {
                clearAccountData();
                if (auth?.currentUser) await signOut(auth).catch(() => {});
                syncSignedOutUI(reason || '');
            })().finally(() => { signedOutPromise = null; });
            return signedOutPromise;
        }

        // ===== AUTHENTICATED API =====
        async function apiFetch(path, options = {}, { retryOnExpired = true } = {}) {
            const headers = new Headers(options.headers || {});
            headers.delete('Authorization');
            const user = auth?.currentUser || null;
            if (user) {
                const token = await user.getIdToken();
                if (auth?.currentUser === user) headers.set('Authorization', `Bearer ${token}`);
            }
            let response = await fetch(path, { ...options, headers });

            if (response.status === 401 && user && retryOnExpired) {
                const body = await response.clone().json().catch(() => ({}));
                if (body.error === 'expired' && auth?.currentUser === user) {
                    let freshToken;
                    try {
                        if (!tokenRefreshInProgress) {
                            tokenRefreshInProgress = (async () => { await user.getIdToken(true); })()
                                .finally(() => { tokenRefreshInProgress = null; });
                        }
                        await tokenRefreshInProgress;
                        freshToken = await user.getIdToken();
                    } catch {
                        await signOutLocally(t('sessionEnded'));
                        return response;
                    }
                    if (auth?.currentUser === user) {
                        const retryHeaders = new Headers(options.headers || {});
                        retryHeaders.set('Authorization', `Bearer ${freshToken}`);
                        response = await fetch(path, { ...options, headers: retryHeaders });
                    }
                    if (auth?.currentUser === user) await handleAuthFailure(response, user);
                    return response;
                }
            }
            await handleAuthFailure(response, user);
            return response;
        }

        async function handleAuthFailure(response, user) {
            if ((user && auth?.currentUser !== user) || (!user && auth?.currentUser)) return;
            if (response.status === 401) {
                if (user) await signOutLocally(t('sessionEnded'));
                else setStatus(t('sessionEnded'), 'error');
                return;
            }
            if (response.status === 403) {
                const body = await response.clone().json().catch(() => ({}));
                if (body.error === 'anonymous_not_allowed') setStatus(t('realAccount'), 'error');
                return;
            }
            if (response.status === 429) {
                const seconds = Math.max(1, Number.parseInt(response.headers.get('Retry-After') || '1', 10) || 1);
                const until = Date.now() + seconds * 1000;
                window._wathiqRateLimitUntil = until;
                window.refreshChatSendState?.();
                if (rateLimitTimer) clearInterval(rateLimitTimer);
                const update = () => {
                    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
                    if (left) setStatus(t('tooMany').replace('{n}', String(left)), 'error');
                    else { clearInterval(rateLimitTimer); rateLimitTimer = null; setStatus(''); }
                    window.refreshChatSendState?.();
                };
                update();
                rateLimitTimer = setInterval(update, 1000);
                return;
            }
            if (response.status === 503) setStatus(t('unavailable'), 'error');
        }
        window.apiFetch = apiFetch;

        // ===== PROFILE AND SHELF =====
        function safeText(value) { return value == null ? '' : String(value); }
        function priceText(price) {
            if (!price || typeof price !== 'object') return t('priceNA');
            const currency = safeText(price.currency || 'DZD');
            const min = Number(price.min);
            const max = Number(price.max);
            const validMin = Number.isFinite(min) && min > 0;
            const validMax = Number.isFinite(max) && max > 0;
            if (!validMin && !validMax) return t('priceNA');
            if (validMin && validMax && min !== max) return `${min}–${max} ${currency}`;
            return `${validMin ? min : max} ${currency}`;
        }
        function appendText(parent, tag, text, className = '') {
            const el = document.createElement(tag);
            if (className) el.className = className;
            el.textContent = safeText(text);
            parent.appendChild(el);
            return el;
        }
        function optionSelect(label, values, selected) {
            const wrapper = document.createElement('label');
            wrapper.className = 'grid gap-1 text-xs';
            wrapper.appendChild(document.createTextNode(label));
            const select = document.createElement('select');
            select.className = 'auth-field';
            values.forEach(([value, text]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = text;
                option.selected = value === selected;
                select.appendChild(option);
            });
            wrapper.appendChild(select);
            return { wrapper, select };
        }
        function renderShelf(items) {
            const parent = $('shelfItems');
            parent.replaceChildren();
            shelfCache = Array.isArray(items) ? items : [];
            if (!shelfCache.length) appendText(parent, 'p', t('noShelf'), 'mt-2 text-sm text-mist-500');
            shelfCache.forEach((item) => {
                const card = document.createElement('article');
                card.className = 'shelf-item';
                if (item.image) {
                    try {
                        const imageUrl = new URL(item.image, location.origin);
                        if (imageUrl.protocol === 'https:' || imageUrl.origin === location.origin) {
                            const img = document.createElement('img');
                            img.src = imageUrl.href;
                            img.alt = `${safeText(item.brand)} ${safeText(item.name)}`.trim();
                            img.loading = 'lazy';
                            img.style.cssText = 'width:56px;height:56px;object-fit:contain;float:inline-start;margin-inline-end:10px;border-radius:8px;';
                            card.appendChild(img);
                        }
                    } catch { /* ignore malformed image URLs */ }
                }
                appendText(card, 'strong', [item.brand, item.name].filter(Boolean).join(' · '), 'block text-sm text-sage-900');
                appendText(card, 'p', priceText(item.price), 'mt-1 text-xs text-mist-600');
                const chips = document.createElement('div');
                (Array.isArray(item.actives) ? item.actives : []).slice(0, 8).forEach((active) => appendText(chips, 'span', active, 'shelf-chip'));
                card.appendChild(chips);
                appendText(card, 'span', `${t(item.status) || safeText(item.status)} · ${t(item.verdict) || safeText(item.verdict)}`, 'block mt-1 text-xs text-mist-500');

                const statusSelect = optionSelect(t('using'), [
                    ['using', t('using')], ['finished', t('finished')], ['wishlist', t('wishlist')], ['stopped', t('stopped')]
                ], item.status || 'using');
                const verdictSelect = optionSelect(t('ok'), [
                    ['', '—'], ['loved', t('loved')], ['ok', t('ok')], ['didnt_suit', t('didnt_suit')]
                ], item.verdict || '');
                card.append(statusSelect.wrapper, verdictSelect.wrapper);
                const noteLabel = document.createElement('label');
                noteLabel.className = 'grid gap-1 mt-2 text-xs';
                noteLabel.appendChild(document.createTextNode(t('note')));
                const note = document.createElement('textarea');
                note.className = 'auth-field';
                note.rows = 2;
                note.maxLength = 500;
                note.value = safeText(item.note);
                noteLabel.appendChild(note);
                card.appendChild(noteLabel);
                const actions = document.createElement('div');
                actions.className = 'flex flex-wrap gap-2 mt-2';
                const save = appendText(actions, 'button', t('save'), 'auth-action');
                save.type = 'button';
                const hide = appendText(actions, 'button', t('hide'), 'auth-action text-red-700');
                hide.type = 'button';
                save.addEventListener('click', async () => {
                    save.disabled = true;
                    try {
                        const annotation = { status: statusSelect.select.value, note: note.value };
                        if (verdictSelect.select.value) annotation.verdict = verdictSelect.select.value;
                        const res = await apiFetch(`/api/me/shelf/${encodeURIComponent(item.id)}`, {
                            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(annotation)
                        });
                        if (!res.ok) throw new Error('save_failed');
                        await loadShelf();
                    } catch { setStatus(t('saveError'), 'error'); }
                    finally { save.disabled = false; }
                });
                hide.addEventListener('click', async () => {
                    hide.disabled = true;
                    try {
                        const res = await apiFetch(`/api/me/shelf/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
                        if (!res.ok) throw new Error('hide_failed');
                        await loadShelf();
                    } catch { setStatus(t('saveError'), 'error'); }
                    finally { hide.disabled = false; }
                });
                card.appendChild(actions);
                parent.appendChild(card);
            });
        }

        async function loadShelf(expectedUser = auth?.currentUser) {
            const res = await apiFetch('/api/me/shelf');
            if (!res.ok || auth?.currentUser !== expectedUser) return;
            const data = await res.json().catch(() => ({}));
            if (auth?.currentUser !== expectedUser) return;
            renderShelf(data.items);
            if (profileCache) $('shelfCount').textContent = `(${Number(profileCache.shelfCount) || shelfCache.length})`;
        }
        async function loadProfile(user) {
            try {
                const res = await apiFetch('/api/me');
                if (!res.ok) throw new Error('profile_unavailable');
                const profile = await res.json();
                if (auth?.currentUser !== user) return;
                profileCache = profile;
                if (profile.language) updateLanguage(profile.language);
                const displayName = safeText(profile.name).trim().split(/\s+/)[0] || safeText(profile.email) || user.email || '';
                $('authGreeting').textContent = displayName;
                $('shelfCount').textContent = `(${Number(profile.shelfCount) || 0})`;
                $('profileNote').textContent = profile.degraded === true ? t('profileUnavailable') : '';
                $('profileNote').hidden = profile.degraded !== true;
                await loadShelf();
            } catch {
                if (auth?.currentUser !== user) return;
                $('profileNote').textContent = t('profileUnavailable');
                $('profileNote').hidden = false;
            }
        }

        // ===== SIGN-IN AND ACCOUNT ACTIONS =====
        function setAuthBusy(busy) {
            $('authForm').querySelectorAll('button').forEach((button) => { button.disabled = busy; });
            $('googleSignInBtn').disabled = busy;
            $('passwordResetBtn').disabled = busy;
        }
        function friendlyAuthError(code) {
            if (code === 'auth/popup-closed-by-user') return activeLanguage === 'ar' ? 'تم إغلاق نافذة تسجيل الدخول.' : 'The sign-in window was closed.';
            if (code === 'auth/network-request-failed') return activeLanguage === 'ar' ? 'تحقق من اتصال الإنترنت وحاول مجددًا.' : 'Check your internet connection and try again.';
            if (code === 'auth/too-many-requests') return activeLanguage === 'ar' ? 'محاولات كثيرة. حاول لاحقًا.' : 'Too many attempts. Please try later.';
            if (code === 'auth/user-disabled') return activeLanguage === 'ar' ? 'هذا الحساب غير متاح.' : 'This account is unavailable.';
            if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(code)) return t('signInError');
            return t('signInError');
        }
        $('authForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!auth) return setStatus('Firebase is not configured yet.', 'error');
            setAuthBusy(true);
            try {
                await signInWithEmailAndPassword(auth, $('authEmail').value.trim(), $('authPassword').value);
                $('authPassword').value = '';
                setStatus('');
            } catch (error) { setStatus(friendlyAuthError(error?.code), 'error'); }
            finally { setAuthBusy(false); }
        });
        $('googleSignInBtn').hidden = !ENABLE_GOOGLE;
        $('googleSignInBtn').addEventListener('click', async () => {
            if (!auth) return setStatus('Firebase is not configured yet.', 'error');
            setAuthBusy(true);
            try { await signInWithPopup(auth, new GoogleAuthProvider()); setStatus(''); }
            catch (error) { setStatus(friendlyAuthError(error?.code), 'error'); }
            finally { setAuthBusy(false); }
        });
        $('passwordResetBtn').addEventListener('click', async () => {
            if (!auth) return setStatus('Firebase is not configured yet.', 'error');
            const email = $('authEmail').value.trim();
            if (!email) { $('authEmail').focus(); return setStatus(activeLanguage === 'ar' ? 'أدخل بريدك الإلكتروني أولًا.' : 'Enter your email address first.', 'error'); }
            try {
                await sendPasswordResetEmail(auth, email);
                setStatus(t('resetSent'));
            } catch (error) {
                const known = ['auth/invalid-email', 'auth/network-request-failed', 'auth/too-many-requests'].includes(error?.code);
                setStatus(known ? friendlyAuthError(error.code) : t('resetSent'), known ? 'error' : 'normal');
            }
        });
        $('authIconBtn').addEventListener('click', () => {
            openModal($('authModal'));
            if (!authStateResolved) $('authLoading').hidden = false;
            else if (!auth?.currentUser) $('authEmail').focus();
        });
        $('shelfIconBtn').addEventListener('click', async () => {
            if (!auth?.currentUser) {
                openModal($('authModal'));
                if (authStateResolved) $('authEmail').focus();
                return;
            }
            openModal($('shelfModal'));
            await loadShelf();
        });
        $('guestSignInLink').addEventListener('click', () => closeModal($('authModal')));
        $('guestSignInPrompt').addEventListener('click', () => {
            openModal($('authModal'));
            $('authEmail').focus();
        });
        $('closeAuthModalBtn').addEventListener('click', () => closeModal($('authModal')));
        $('closeShelfModalBtn').addEventListener('click', () => closeModal($('shelfModal')));
        [$('authModal'), $('shelfModal')].forEach((dialog) => {
            dialog.addEventListener('click', (event) => {
                if (event.target === dialog) closeModal(dialog);
            });
        });

        $('signOutBtn').addEventListener('click', async () => {
            $('signOutBtn').disabled = true;
            try { await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {}); }
            finally {
                if (auth) await signOut(auth).catch(() => {});
                clearAccountData();
                syncSignedOutUI();
                setStatus('');
                $('signOutBtn').disabled = false;
            }
        });
        $('refreshDataBtn').addEventListener('click', async () => {
            $('refreshDataBtn').disabled = true;
            try {
                const res = await apiFetch('/api/auth/refresh', { method: 'POST' });
                if (!res.ok) throw new Error('refresh_failed');
                await res.json().catch(() => ({}));
                await loadProfile(auth.currentUser);
                window._wathiqRefreshUserDataNextMessage = true;
                setStatus(t('refreshed'));
            } catch { setStatus(t('unavailable'), 'error'); }
            finally { $('refreshDataBtn').disabled = false; }
        });
        $('eraseDataBtn').addEventListener('click', async () => {
            const confirmText = activeLanguage === 'ar' ? STR.ar.confirmErase : STR.en.confirmErase;
            if (!window.confirm(confirmText)) return;
            $('eraseDataBtn').disabled = true;
            try {
                const res = await apiFetch('/api/me/agent-data', { method: 'DELETE' });
                if (!res.ok) throw new Error('erase_failed');
                await res.json().catch(() => ({}));
                clearAccountData();
                setStatus(t('erased'));
            } catch { setStatus(t('unavailable'), 'error'); }
            finally { $('eraseDataBtn').disabled = false; }
        });

        // Resolve sign-in after the page/API layer is already available.
        firebaseSdkPromise.then(async () => {
            $('authLoading').hidden = false;
            const configReady = firebaseSdkReady && Object.values(FIREBASE_CONFIG).every((value) => typeof value === 'string' && value.length > 0 && value !== 'REPLACE_ME');
            if (!configReady) {
                $('authWarning').textContent = firebaseSdkReady
                    ? 'Development mode: add Firebase web config values to enable sign-in.'
                    : 'Firebase SDK unavailable. Check your network and the official CDN connection.';
                $('authWarning').hidden = false;
                authStateResolved = true;
                $('loginPanel').hidden = false;
                $('authLoading').hidden = true;
                $('chatMain').hidden = REQUIRE_LOGIN;
                setStatus('');
            } else {
                try {
                    const app = initializeApp(FIREBASE_CONFIG);
                    auth = getAuth(app);
                    if (!ENABLE_GOOGLE) $('googleSignInBtn').hidden = true;
                    await setPersistence(auth, browserLocalPersistence);
                    onAuthStateChanged(auth, async (user) => {
                        authStateResolved = true;
                        $('authLoading').hidden = true;
                        if (user) {
                            hadAuthUser = true;
                            $('loginPanel').hidden = true;
                            $('accountPanel').hidden = false;
                            $('authIconBtn').setAttribute('aria-label', safeText(user.email) || (activeLanguage === 'ar' ? 'حسابي' : 'My account'));
                            $('authIconBtn').title = activeLanguage === 'ar' ? 'حسابي' : 'My account';
                            $('chatMain').hidden = true;
                            $('guestSignInLink').hidden = true;
                            setStatus('');
                            try { await apiFetch('/api/auth/refresh', { method: 'POST' }); } catch { /* chat remains available */ }
                            if (auth?.currentUser !== user) return;
                            await loadProfile(user);
                            if (auth?.currentUser === user) {
                                $('chatMain').hidden = false;
                                closeModal($('authModal'));
                            }
                        } else {
                            if (hadAuthUser) clearAccountData();
                            hadAuthUser = false;
                            syncSignedOutUI();
                            $('guestSignInLink').hidden = false;
                            if (!REQUIRE_LOGIN) setStatus('');
                        }
                    });
                } catch {
                    $('authWarning').textContent = 'Firebase could not be initialized. Check the web configuration.';
                    $('authWarning').hidden = false;
                    authStateResolved = true;
                    $('authLoading').hidden = true;
                    $('loginPanel').hidden = false;
                    $('chatMain').hidden = REQUIRE_LOGIN;
                    setStatus('');
                }
            }
        }).catch((error) => {
            console.warn('[Wathiq] Auth bootstrap failed; continuing as guest.', error);
            authStateResolved = true;
            if ($('authLoading')) $('authLoading').hidden = true;
            if ($('loginPanel')) $('loginPanel').hidden = false;
            if ($('chatMain')) $('chatMain').hidden = REQUIRE_LOGIN;
            if ($('authWarning')) {
                $('authWarning').textContent = 'تعذّر تهيئة تسجيل الدخول؛ يمكنك متابعة المحادثة كضيف.';
                $('authWarning').hidden = false;
            }
        });

        // ===== REFRESH PROFILE AFTER A LONG TAB ABSENCE =====
        let hiddenAt = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') hiddenAt = Date.now();
            else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000 && auth?.currentUser) {
                window._wathiqRefreshUserDataNextMessage = true;
                hiddenAt = 0;
            }
        });
