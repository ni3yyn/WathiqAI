        function getWathiqErrorMessage(error) {
            const raw = String(error?.message || error || '');
            const code = raw.toLowerCase();
            if (error instanceof TypeError || error?.code === 'auth/network-request-failed' || /failed to fetch|networkerror|network request failed|load failed/.test(code)) {
                return 'تعذّر الاتصال بالخادم. تحقق من اتصال الإنترنت ثم أعد المحاولة.';
            }
            if (/request_failed_401|unauthori[sz]ed|auth_required|token_expired|\b401\b/.test(code)) {
                return 'انتهت جلسة الدخول أو تحتاج إلى تسجيل الدخول. حدّث الجلسة ثم أعد المحاولة.';
            }
            if (/request_failed_403|forbidden|\b403\b/.test(code)) {
                return 'لا تسمح الجلسة الحالية بتنفيذ هذا الطلب. تحقق من صلاحيات الحساب ثم حاول مجددًا.';
            }
            if (/request_failed_429|rate.?limit|too many requests|\b429\b/.test(code)) {
                return 'وصلت إلى حدّ الطلبات المؤقت. انتظر قليلًا ثم أعد المحاولة.';
            }
            if (/request_failed_413|payload too large|entity too large|\b413\b/.test(code)) {
                return 'حجم الصورة أو الطلب أكبر من المسموح. اختر صورة أصغر ثم أعد المحاولة.';
            }
            if (/request_failed_400|request_failed_422|http\s+(400|422)|\b(400|422)\b/.test(code)) {
                return 'لم أستطع معالجة الطلب كما أُرسل. راجع اسم المنتج أو صورة المكونات ثم حاول مرة أخرى.';
            }
            if (/incomplete_stream|stream_error|timed out|timeout|aborted/.test(code)) {
                return 'انقطع الرد قبل اكتماله. يمكنك إعادة المحاولة، وستُعاد صياغة الطلب نفسه.';
            }
            if (/request_failed_5\d\d|internal server error|http\s+5\d\d|\b5\d\d\b/.test(code)) {
                return 'حدث خلل مؤقت في الخادم أثناء معالجة الطلب. لم يكتمل التقييم؛ أعد المحاولة بعد لحظة.';
            }
            if (/[\u0600-\u06FF]/.test(raw) && raw.length <= 220 && !/stack|trace|exception|undefined|null/i.test(raw)) {
                return raw;
            }
            return 'لم يكتمل الطلب بسبب مشكلة غير متوقعة. لم أعتمد نتيجة ناقصة؛ أعد المحاولة أو أرسل السؤال بصياغة أخرى.';
        }

        window.retryLastWathiqMessage = function () {
            const failed = window.__WATHIQ_LAST_FAILED_REQUEST;
            const input = document.getElementById('messageInput');
            if (!failed || !input || isAnimating) return;

            const rows = document.querySelectorAll('#chatMessages .user-message-row');
            const lastRow = rows[rows.length - 1];
            if (lastRow) {
                const visible = lastRow.querySelector('.user-message-text')?.textContent?.trim();
                if (visible === String(failed.displayMessage || '').trim()) lastRow.remove();
            }
            document.querySelectorAll('.wq-error-message').forEach(el => el.remove());
            input.value = failed.requestMessage;
            if (failed.photoPayload) {
                const photos = Array.isArray(failed.photoPayload) ? failed.photoPayload : [failed.photoPayload];
                _pendingPhotos = photos.map((photo, index) => {
                    const { previewUrl, ...payload } = photo;
                    return { ...payload, previewUrl: null, role: photo.role || (index === 0 ? 'front' : 'inci') };
                });
                if (typeof renderPhotoPreview === 'function') renderPhotoPreview();
                else {
                    const preview = document.getElementById('photoPreviewBar');
                    if (preview) {
                        preview.style.display = 'flex';
                        preview.textContent = 'ستُعاد محاولة إرسال الصور المرفقة.';
                    }
                }
            }
            window.__WATHIQ_DISPLAY_MESSAGE_NEXT = failed.displayMessage;
            window.__WATHIQ_RETRYING = true;
            autoResize(input);
            checkClearButtonVisibility();
            handleSubmit(new Event('submit'));
        };

        async function handleSubmit(e) {
            if (e) e.preventDefault();
            const input = document.getElementById('messageInput');
            if (!input) return;
            const typedMessage = input.value.trim();
            const hasPendingImages = Array.isArray(_pendingPhotos) && _pendingPhotos.length > 0;
            const message = typedMessage || (hasPendingImages ? 'تعرّف على المنتج من الصورة وابحث عنه في الكتالوج، وإذا كانت قائمة المكونات ظاهرة فاقرأها بدقة.' : '');
            const displayMessage = String(window.__WATHIQ_DISPLAY_MESSAGE_NEXT || (typedMessage ? typedMessage : (hasPendingImages ? 'تعرّف على المنتج من الصورة' : message)));
            delete window.__WATHIQ_DISPLAY_MESSAGE_NEXT;
            if ((!message || !message.trim()) || isAnimating) return;

            const isRetryAttempt = Boolean(window.__WATHIQ_RETRYING);
            window.__WATHIQ_RETRYING = false;
            if (!isRetryAttempt) {
                delete window.__WATHIQ_LAST_FAILED_REQUEST;
                document.querySelectorAll('.wq-error-message').forEach(el => el.remove());
            }

            input.value = '';
            autoResize(input);
            checkClearButtonVisibility();
            userHasScrolledUp = false;
            hasNewContentWhileScrolled = false;
            updateFabState();

            // Capture and clear pending photo
            const photoPayload = Array.isArray(_pendingPhotos) && _pendingPhotos.length
                ? _pendingPhotos.map(photo => ({ ...photo }))
                : null;
            if (photoPayload) clearPhotoPreview();

            appendUserMessage(displayMessage);
            setLoading(true);
            isAnimating = true;
            appendThinkingBubble('يفكّر...');
            let activeStreamBubble = null;
            let gotStreamFinish = false;

            try {
                // Start with a stable raw client ID; the auth middleware scopes it once per user.
                if (!_wathiqSessionId) {
                    _wathiqSessionId = globalThis.crypto?.randomUUID?.() || `wq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                }
                const requestBody = {
                    message,
                    conversation,
                    stream: true,
                    provider: currentEngine,
                    ...(photoPayload ? { images: photoPayload.map(({ previewUrl, ...photo }) => photo) } : {}),
                    sessionId: _wathiqSessionId,
                };
                const refreshUserData = Boolean(window._wathiqRefreshUserDataNextMessage);
                if (refreshUserData) requestBody.refreshUserData = true;
                const response = await window.apiFetch(window.WATHIQ_AGENT?.chatEndpoint || '/api/chat', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream, application/json'
                    },
                    body: JSON.stringify(requestBody)
                });
                if (!response.ok) {
                    const errorBody = await response.clone().json().catch(() => ({}));
                    throw new Error(errorBody.error ? `${String(errorBody.error)} (HTTP ${response.status})` : `request_failed_${response.status}`);
                }
                if (refreshUserData) window._wathiqRefreshUserDataNextMessage = false;

                const contentType = response.headers.get('content-type') || '';

                if (contentType.includes('text/event-stream') && response.body) {
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder('utf-8');
                    let buffer = '';
                    let activeBubble = null;
                    let proseEl = null;
                    let cardsContainer = null;
                    let quickRepliesEl = null;
                    let feedbackEl = null;
                    let accumulatedText = '';
                    let finalData = null;
                    let streamFailure = null;
                    // Per-message dedupe reset
                    _renderedCards.clear();
                    const thisMsgId = 'msg-' + Date.now();

                    const ensureResponseBubble = () => {
                        if (!activeBubble) {
                            removeThinkingBubble();
                            const container = document.getElementById('chatMessages');
                            activeBubble = document.createElement('div');
                            activeBubble.className = "agent-flow animate-fade-in";
                            activeStreamBubble = activeBubble;
                            activeBubble.style.marginBottom = "1.5rem";
                            activeBubble.innerHTML = `
                                <div class="flex items-center gap-2.5" style="margin-bottom: 0.7rem;">
                                    <div class="agent-avatar rounded-xl flex items-center justify-center text-white" style="width: 30px; height: 30px;">
                                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-flask"/></svg>
                                    </div>
                                    <span class="font-bold text-sage-900" style="font-size: 0.85rem;">وكيل وثيق</span>
                                </div>
                                <div class="agent-flow-content">
                                    <div class="chat-prose rtl-text" dir="rtl" style="unicode-bidi: plaintext;"></div>
                                    <div class="agent-cards-container"></div>
                                    <div class="agent-quick-replies"></div>
                                    <div class="agent-feedback" style="display:none;"></div>
                                </div>
                            `;
                            container.appendChild(activeBubble);
                            proseEl = activeBubble.querySelector('.chat-prose');
                            cardsContainer = activeBubble.querySelector('.agent-cards-container');
                            quickRepliesEl = activeBubble.querySelector('.agent-quick-replies');
                            feedbackEl = activeBubble.querySelector('.agent-feedback');
                            scrollToBottomSmart();
                        }
                    };

                    let hasRenderedEagerCards = false;

while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.replace(/^data:\s*/, '');
        if (!jsonStr) continue;

        let evt;
        try {
            evt = JSON.parse(jsonStr);
        } catch (parseErr) {
            console.warn('[STREAM PARSE]', parseErr);
            continue;
        }

        if (evt.type === 'status') {
            updateThinkingBubble(evt.status);

        } else if (evt.type === 'session') {
            if (evt.sessionId) _wathiqSessionId = evt.sessionId;

        } else if (evt.type === 'text-delta') {
            ensureResponseBubble();
            accumulatedText += (evt.delta || '');
            const isRTL = isRTLText(accumulatedText);
            proseEl.className = `chat-prose ${isRTL ? 'rtl-text' : ''}`;
            proseEl.setAttribute('dir', isRTL ? 'rtl' : 'ltr');
            proseEl.innerHTML = formatMarkdown(stripInternalContextTags(accumulatedText));
            scrollToBottomSmart();

        } else if (evt.type === 'card') {
            ensureResponseBubble();
            const sectionData = Object.assign({ type: evt.cardType }, evt.data);
            const cardHtml = renderSections([sectionData], null, thisMsgId);
            if (cardHtml) {
                cardsContainer.insertAdjacentHTML('beforeend', cardHtml);
                hasRenderedEagerCards = true;
                revealCardsIn(cardsContainer);
                scrollToBottomSmart();
            }

        } else if (evt.type === 'quick_replies') {
            ensureResponseBubble();
            if (quickRepliesEl && evt.suggestions && evt.suggestions.length) {
                displayQuickReplies(quickRepliesEl, evt.suggestions);
                scrollToBottomSmart();
            }

        } else if (evt.type === 'finish') {
            gotStreamFinish = true;
            finalData = evt.data;
            if (evt.data?.sessionId) _wathiqSessionId = evt.data.sessionId;
            if (evt.data?.messageId) _wathiqMessageId = evt.data.messageId;

        } else if (evt.type === 'error') {
            // Do not throw inside a JSON-parse try/catch: it used to swallow stream errors.
            streamFailure = new Error(evt.message || 'stream_error');
        }

        if (streamFailure) {
            try { await reader.cancel(); } catch (_) { /* stream may already be closed */ }
            break;
        }
    }
    if (streamFailure) break;
}

if (streamFailure) throw streamFailure;
if (!finalData) throw new Error('incomplete_stream');

if (finalData) {
    ensureResponseBubble();

    if (!hasRenderedEagerCards) {
        const html = renderSections(finalData.sections, finalData, thisMsgId);
        if (html) {
            cardsContainer.innerHTML = html;
                hasRenderedEagerCards = true;
            revealCardsIn(cardsContainer);
        }
    }

        const visibleAssistantText = cleanAssistantText(finalData.message || accumulatedText, hasRenderedEagerCards);
        if (proseEl && visibleAssistantText) proseEl.innerHTML = formatMarkdown(visibleAssistantText);

    // Quick replies from finish.data
    if (finalData.quickReplies && finalData.quickReplies.length && quickRepliesEl) {
        displayQuickReplies(quickRepliesEl, finalData.quickReplies);
    }

    // Feedback thumbs (only if backend returned a messageId)
    if (_wathiqMessageId && feedbackEl) {
        feedbackEl.style.display = 'flex';
        feedbackEl.style.alignItems = 'center';
        feedbackEl.innerHTML = renderFeedbackRow(_wathiqMessageId);
    }

    delete window.__WATHIQ_LAST_FAILED_REQUEST;
    conversation.push({ role: 'user', content: message });
    const assistantContext = cleanAssistantText(finalData.message || accumulatedText, hasRenderedEagerCards) + buildContextTags(finalData.sections, finalData);
    conversation.push({ role: 'assistant', content: assistantContext });

    scrollToBottomSmart();
}
                } else {
                    const data = await response.json();
                    
                    delete window.__WATHIQ_LAST_FAILED_REQUEST;
                    conversation.push({ role: 'user', content: message });
                    const hasCard = appendAgentResponse(data);
                    const assistantContext = cleanAssistantText(data.message || '', hasCard) + buildContextTags(data.sections, data);
                    conversation.push({ role: 'assistant', content: assistantContext });
                }
            } catch (err) {
                if (activeStreamBubble && !gotStreamFinish) activeStreamBubble.remove();
                window.__WATHIQ_LAST_FAILED_REQUEST = {
                    requestMessage: message,
                    displayMessage,
                    photoPayload: photoPayload ? photoPayload.map(photo => ({ ...photo })) : null
                };
                appendErrorMessage(getWathiqErrorMessage(err));
            } finally {
                setLoading(false);
                isAnimating = false;
            }
        }
        const initializeChatUI = () => {
            initTextarea();
            updateEngineUI();
            checkClearButtonVisibility();
            document.getElementById('chatForm')?.addEventListener('submit', handleSubmit);
            document.querySelectorAll('.chat-prose, .surface-strong p').forEach(el => {
                if (isRTLText(el.textContent || '')) {
                    el.classList.add('rtl-text');
                    el.setAttribute('dir', 'rtl');
                }
            });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initializeChatUI, { once: true });
        } else {
            initializeChatUI();
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeImageModal();
        });

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                scrollToBottomSmart();
            });
        }

        window.resetChatForAuth = function () {
            conversation = [];
            _wathiqSessionId = null;
            _wathiqMessageId = null;
            if (typeof clearPhotoPreview === 'function') clearPhotoPreview();
            else _pendingPhotos = [];
            document.getElementById('photoPreviewBar')?.replaceChildren();
            document.getElementById('photoPreviewBar')?.setAttribute('style', 'display:none;');
            clearChat();
        };
        window.refreshChatSendState = function () {
            _rateLimitUntil = Number(window._wathiqRateLimitUntil) || 0;
            setLoading(isAnimating);
        };

        
