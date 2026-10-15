        async function handleSubmit(e) {
            if (e) e.preventDefault();
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            if (!message || isAnimating) return;

            input.value = '';
            autoResize(input);
            checkClearButtonVisibility();
            userHasScrolledUp = false;
            hasNewContentWhileScrolled = false;
            updateFabState();

            // Capture and clear pending photo
            const photoPayload = _pendingPhoto ? { ..._pendingPhoto } : null;
            if (photoPayload) clearPhotoPreview();

            appendUserMessage(message);
            setLoading(true);
            isAnimating = true;
            appendThinkingBubble('يفكّر...');

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
                    ...(photoPayload ? { images: [photoPayload] } : {}),
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
                    throw new Error(errorBody.error || `request_failed_${response.status}`);
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
                    // Per-message dedupe reset
                    _renderedCards.clear();
                    const thisMsgId = 'msg-' + Date.now();

                    const ensureResponseBubble = () => {
                        if (!activeBubble) {
                            removeThinkingBubble();
                            const container = document.getElementById('chatMessages');
                            activeBubble = document.createElement('div');
                            activeBubble.className = "agent-flow animate-fade-in";
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
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const block of lines) {
        const trimmed = block.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.replace(/^data:\s*/, '');
        if (!jsonStr) continue;

        try {
            const evt = JSON.parse(jsonStr);

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
                finalData = evt.data;
                if (evt.data?.sessionId) _wathiqSessionId = evt.data.sessionId;
                if (evt.data?.messageId) _wathiqMessageId = evt.data.messageId;

            } else if (evt.type === 'error') {
                throw new Error(evt.message || 'خطأ أثناء البث المباشر');
            }
        } catch (parseErr) {
            console.warn('[STREAM PARSE]', parseErr);
        }
    }
}

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

    conversation.push({ role: 'user', content: message });
    const assistantContext = cleanAssistantText(finalData.message || accumulatedText, hasRenderedEagerCards) + buildContextTags(finalData.sections, finalData);
    conversation.push({ role: 'assistant', content: assistantContext });

    scrollToBottomSmart();
}
                } else {
                    const data = await response.json();
                    
                    conversation.push({ role: 'user', content: message });
                    const hasCard = appendAgentResponse(data);
                    const assistantContext = cleanAssistantText(data.message || '', hasCard) + buildContextTags(data.sections, data);
                    conversation.push({ role: 'assistant', content: assistantContext });
                }
            } catch (err) {
                if (err instanceof TypeError || err?.code === 'auth/network-request-failed') {
                    appendErrorMessage("تعذر الاتصال. تحقق من اتصال الإنترنت ثم حاول مجددًا.");
                }
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
            _pendingPhoto = null;
            document.getElementById('photoPreviewBar')?.replaceChildren();
            document.getElementById('photoPreviewBar')?.setAttribute('style', 'display:none;');
            clearChat();
        };
        window.refreshChatSendState = function () {
            _rateLimitUntil = Number(window._wathiqRateLimitUntil) || 0;
            setLoading(isAnimating);
        };

        
