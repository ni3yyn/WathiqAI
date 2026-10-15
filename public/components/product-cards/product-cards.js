        // PRODUCTS GRID
        // ============================================================
        function renderProductsGrid(products) {
            window.__PRODUCTS_MAP__ = window.__PRODUCTS_MAP__ || {};
            let html = `<div class="products-rail">`;
            products.forEach(p => {
                window.__PRODUCTS_MAP__[p.id] = p;
                const img = p.image || '';
                const currency = p.currency || 'دج';
                const claims = (p.claims || []).slice(0, 2);
                const price = p.price ? `${p.price} ${currency}` : '';
                const nameIsRTL = isRTLText(p.name || '');
                const safeImg = escapeHtml(img);
                const safeName = escapeHtml(p.name || '');
                const safeBrand = escapeHtml(p.brand || 'وثيق');

                html += `
                    <div class="product-mini" onclick="evaluateProductById('${p.id}')" title="اضغط للتقييم مع وثيق">
                        <div class="product-mini-img-wrap" ${img ? `onclick="event.stopPropagation(); openImageModal('${safeImg}', '${safeName}', '${safeBrand}')"` : ''} title="${img ? 'عرض الصورة بالحجم الكامل' : ''}">
                            ${img 
                                ? `<img src="${safeImg}" alt="${safeName}" onerror="this.parentElement.innerHTML='<svg width=\\'24\\' height=\\'24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'1.75\\'><use href=\\'#i-package\\'/></svg>'">
                                   <div class="img-expand-badge"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5"><use href="#i-maximize"/></svg></div>` 
                                : `<svg class="w-6 h-6 text-sage-600" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-package"/></svg>`}
                        </div>
                        <div class="product-mini-info">
                            <div class="product-mini-brand">${safeBrand}</div>
                            <div class="product-mini-name ${nameIsRTL ? 'rtl-text' : ''}" ${nameIsRTL ? 'dir="rtl"' : ''}>${safeName || 'منتج'}</div>
                            <div class="product-mini-meta">
                                ${price ? `<span class="product-mini-price">${price}</span>` : ''}
                                ${p.quantity ? `<span>${escapeHtml(p.quantity)}</span>` : ''}
                            </div>
                            ${claims.length > 0 ? `
                            <div class="product-mini-claims">
                                ${claims.map(c => {
                                    const claimRTL = isRTLText(c);
                                    return `<span class="product-mini-claim ${claimRTL ? 'rtl-text' : ''}" ${claimRTL ? 'dir="rtl"' : ''}>${escapeHtml(c)}</span>`;
                                }).join('')}
                            </div>` : ''}
                        </div>
                        <div class="product-mini-eval" title="تقييم الادعاءات">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-bolt"/></svg>
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
            return html;
        }

        function evaluateProductById(productId) {
            window.__PRODUCTS_MAP__ = window.__PRODUCTS_MAP__ || {};
            const p = window.__PRODUCTS_MAP__[productId];
            if (p) {
                const claimsList = Array.isArray(p.claims) && p.claims.length > 0 ? p.claims.slice(0, 4).join('، ') : '';
                const claimsNote = claimsList ? ` (الادعاءات: ${claimsList})` : '';
                sendPreset(`قيّم المنتج بالمعرف: ${p.id} (${p.name}).${claimsNote}`);
            } else {
                sendPreset(`قيّم المنتج بالمعرف: ${productId}`);
            }
        }

        function appendErrorMessage(msg) {
            removeThinkingBubble();
            const container = document.getElementById('chatMessages');
            const div = document.createElement('div');
            div.className = "agent-flow animate-slide-up";
            div.style.marginBottom = "1.25rem";
            div.innerHTML = `
                <div class="flex items-center gap-2.5" style="margin-bottom: 0.55rem;">
                    <div class="rounded-xl flex items-center justify-center shrink-0" style="width:30px; height:30px; background:#fee2e2; color:#dc2626;">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert"/></svg>
                    </div>
                    <span class="font-bold" style="font-size: 0.85rem; color:#a34141;">خطأ</span>
                </div>
                <div class="chat-prose" style="color:#a34141; font-size:0.9rem;">
                    <p>${escapeHtml(msg)}</p>
                </div>
            `;
            container.appendChild(div);
            scrollToBottomSmart();
        }

        // ── Quick replies helper ──────────────────────────────────────────
