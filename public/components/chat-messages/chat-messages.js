        function setLoading(loading) {
            const btn = document.getElementById('sendBtn');
            btn.disabled = loading || Date.now() < _rateLimitUntil;
        }

        function appendUserMessage(text) {
            const container = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = "user-message-row animate-slide-up";
            div.setAttribute('role', 'group');
            div.setAttribute('aria-label', 'رسالة المستخدم');
            const isRTL = isRTLText(text);
            div.innerHTML = `
                <div class="user-bubble ${isRTL ? 'rtl-text' : 'ltr-text'}" dir="${isRTL ? 'rtl' : 'auto'}">
                    <p class="user-message-text">${escapeHtml(text)}</p>
                </div>
                <div class="user-avatar flex items-center justify-center" aria-hidden="true">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-user"/></svg>
                </div>
            `;
            container.appendChild(div);
            userHasScrolledUp = false;
            scrollToBottomSmart(true);
        }

        function appendThinkingBubble(initialText = 'يفكّر...') {
            const container = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.id = 'thinkingBubble';
            div.className = "agent-flow animate-slide-up";
            div.style.marginBottom = "1.25rem";
            div.innerHTML = `
                <div class="flex items-center gap-2.5" style="margin-bottom: 0.65rem;">
                    <div class="agent-avatar rounded-xl flex items-center justify-center text-white" style="width: 30px; height: 30px;">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-flask"/></svg>
                    </div>
                    <div class="flex items-center gap-2.5">
                        <span id="thinkingStatusText" class="text-mist-500 font-semibold" style="font-size: 0.8rem;">${escapeHtml(initialText)}</span>
                        <div class="flex gap-1.5">
                            <span class="thinking-dot"></span>
                            <span class="thinking-dot"></span>
                            <span class="thinking-dot"></span>
                        </div>
                    </div>
                </div>

                <!-- Structured Skeleton Placeholders -->
                <div class="space-y-3 agent-response-skeleton" style="max-width: min(100%, 36rem);">
                    <div class="space-y-1.5">
                        <div class="skeleton-shimmer" style="height: 10px; width: 85%;"></div>
                        <div class="skeleton-shimmer" style="height: 10px; width: 62%;"></div>
                    </div>

                    <div class="skeleton-card flex items-center gap-3">
                        <div class="skeleton-shimmer flex-shrink-0" style="width: 58px; height: 58px; border-radius: 0.85rem;"></div>
                        <div class="flex-1 space-y-2">
                            <div class="skeleton-shimmer" style="height: 9px; width: 30%;"></div>
                            <div class="skeleton-shimmer" style="height: 13px; width: 75%;"></div>
                            <div class="flex gap-2">
                                <div class="skeleton-shimmer" style="height: 14px; width: 45px; border-radius: 999px;"></div>
                                <div class="skeleton-shimmer" style="height: 14px; width: 65px; border-radius: 999px;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            container.appendChild(div);
            scrollToBottomSmart();
        }

        function updateThinkingBubble(statusText) {
            const el = document.getElementById('thinkingStatusText');
            if (el && statusText) {
                el.textContent = statusText;
            }
        }

        function removeThinkingBubble() {
            const el = document.getElementById('thinkingBubble');
            if (el) el.remove();
        }

        function stripInternalContextTags(text) {
            const source = String(text || '');
            let output = '';
            let cursor = 0;
            while (cursor < source.length) {
                const start = source.indexOf('[Context:', cursor);
                if (start < 0) { output += source.slice(cursor); break; }
                output += source.slice(cursor, start);
                let depth = 0;
                let end = -1;
                for (let i = start; i < source.length; i++) {
                    if (source[i] === '[') depth++;
                    else if (source[i] === ']' && --depth === 0) { end = i + 1; break; }
                }
                if (end < 0) break; // hide a partial streamed context tag too
                cursor = end;
            }
            return output.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        }

        function cleanAssistantText(text, hasCard = true) {
            let clean = stripInternalContextTags(text);
            if (hasCard) return clean;
            return clean.split(/(?<=[.!؟?])\s+/u)
                .filter(sentence => !/(?:في\s+البطاقة|البطاقة\s+أدناه|in\s+(?:the\s+)?card(?:\s+below)?|card\s+below|dans\s+la\s+carte|carte\s+ci-dessous)/i.test(sentence))
                .join(' ').trim();
        }

        function appendAgentResponse(data) {
            removeThinkingBubble();
            const container = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = "agent-flow";
            div.style.marginBottom = "1.5rem";

            let contentHtml = '';

            const sectionsHtml = renderSections(data.sections, data);
            const safeMessage = cleanAssistantText(data.message, Boolean(sectionsHtml));
            if (safeMessage) {
                const messageRTL = isRTLText(safeMessage);
                const dirAttr = messageRTL ? 'dir="rtl"' : '';
                const rtlClass = messageRTL ? 'rtl-text' : '';
                contentHtml += `<div class="chat-prose ${rtlClass}" ${dirAttr} style="unicode-bidi: plaintext;">${formatMarkdown(safeMessage)}</div>`;
            }

            contentHtml += sectionsHtml;

            div.innerHTML = `
                <div class="flex items-center gap-2.5" style="margin-bottom: 0.7rem;">
                    <div class="agent-avatar rounded-xl flex items-center justify-center text-white" style="width: 30px; height: 30px;">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-flask"/></svg>
                    </div>
                    <span class="font-bold text-sage-900" style="font-size: 0.85rem;">وكيل وثيق</span>
                </div>
                <div class="agent-flow-content"></div>
            `;

            container.appendChild(div);
            scrollToBottomSmart();

            const contentEl = div.querySelector('.agent-flow-content');

            requestAnimationFrame(() => {
                animateReveal(contentEl, contentHtml);
            });
            return Boolean(sectionsHtml);
        }

        function buildContextTags(sections, legacyData) {
            const list = (Array.isArray(sections) && sections.length > 0) ? sections : [legacyData || {}];
            let tags = '';
            for (const s of list) {
                if (s.type === 'product_results' && s.products?.length > 0) {
                    const topItems = s.products.slice(0, 5).map((p, idx) => `${idx + 1}. ${p.brand} - ${p.name} (ID: ${p.id}, Price: ${p.price} ${p.currency || 'دج'})`).join('; ');
                    tags += `\n[Context: Products shown to user: ${topItems}]`;
                }
                if (s.type === 'product' && s.product) {
                    tags += `\n[Context: Product details shown: ${s.product.brand} - ${s.product.name} (ID: ${s.product.id})]`;
                }
                if (s.type === 'product_analysis' && s.analysis) {
                    tags += `\n[Context: Evaluated ${s.productName || s.productId} (Score: ${s.analysis.oilGuardScore}/100, Verdict: ${s.analysis.finalVerdict})]`;
                }
                if (s.type === 'routine' && s.routine) {
                    tags += `\n[Context: Built routine "${s.routine.title}" with ${s.routine.stepsCount} steps, total ${s.routine.totalCost} DZD]`;
                }
                if ((s.type === 'brand_review' || s.type === 'brand_analysis') || s.brandReview) {
                    const br = s.brandReview || s.review || s.data || s;
                    tags += `\n[Context: Brand Review shown for "${br.brand}" (Score: ${br.verdict?.avgScore}/100, Tier: ${br.verdict?.tier})]`;
                }
                if (s.type === 'comparison' && s.comparison) {
                    const cmp = s.comparison;
                    const w = cmp.winners || {};
                    tags += `\n[Context: Comparison shown: ${(cmp.entries||[]).map(e => e.name).join(' vs ')} — overall winner: ${w.overall?.label || 'tie'}]`;
                }
                if (s.type === 'ingredient_check' && s.ingredientCheck) {
                    tags += `\n[Context: Ingredient list checked (score: ${s.ingredientCheck.score}/100). Follow-ups like "which ingredient is the problem?" refer to this list.]`;
                }
                if (s.type === 'brand_reviews' && s.brandReviews) {
                    tags += `\n[Context: Brand community reviews shown for "${s.brandReviews.brand}" (${s.brandReviews.products?.length || 0} products).]`;
                }
                if (s.type === 'community_reviews') {
                    tags += `\n[Context: Community reviews shown for "${s.productName}" (satisfaction: ${s.satisfactionRate}%).]`;
                }
            }
            return tags;
        }


        // ═══════════════════════════════════════════════════════════════════
