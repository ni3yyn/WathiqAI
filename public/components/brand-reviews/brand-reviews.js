        function renderBrandReviewsCard(data) {
            const b = (data && data.brandReviews) || data || {};
            const brand = escapeHtml(b.brand || b.brandName || 'العلامة');
            const prods = Array.isArray(b.products) ? b.products
                : Array.isArray(b.perProduct) ? b.perProduct
                : Array.isArray(b.breakdown) ? b.breakdown : [];
            if (!prods.length) return '';

            const avg = b.avgSatisfaction ?? b.averageSatisfaction ?? b.overallSatisfaction ?? null;
            const total = b.totalReviews ?? b.totalComments ?? null;
            const toneFor = r => r == null ? 'info' : r >= 75 ? 'safe' : r >= 50 ? 'warn' : 'danger';

            let prodsHtml = '';
            prods.forEach(p => {
                const name = escapeHtml(p.name || p.productName || 'منتج');
                const pid = p.id || p.productId || '';
                const rate = p.satisfactionRate ?? p.avgSatisfaction ?? null;
                const pros = Array.isArray(p.pros) ? p.pros : [];
                const cons = Array.isArray(p.cons) ? p.cons : [];
                const count = p.reviewCount ?? p.commentsUsed ?? null;
                prodsHtml += `
                <details class="acc-detail">
                    <summary>
                        <span class="acc-chip ${toneFor(rate)}" style="margin:0;">${rate != null ? Math.round(rate) + '%' : '—'}</span>
                        <span class="acc-detail-name">${name}</span>
                        <span class="acc-detail-count">${count != null ? count + ' رأي' : ''}</span>
                    </summary>
                    <div class="acc-detail-body">
                        ${pros.length ? `<div class="acc-detail-label">👍 الإيجابيات</div><div>${pros.slice(0,4).map(x => `<span class="acc-chip safe">${escapeHtml(x)}</span>`).join('')}</div>` : ''}
                        ${cons.length ? `<div class="acc-detail-label">⚠️ التحذيرات</div><div>${cons.slice(0,4).map(x => `<span class="acc-chip danger">${escapeHtml(x)}</span>`).join('')}</div>` : ''}
                        ${p.summary ? `<div class="acc-detail-desc" style="margin-top:0.4rem;">${escapeHtml(p.summary)}</div>` : ''}
                        ${pid ? `<div style="margin-top:0.4rem;"><span class="acc-prod-pill" onclick="evaluateProductById('${escapeHtml(pid)}')">تقييم المنتج كيميائياً ⚗️</span></div>` : ''}
                    </div>
                </details>`;
            });

            return `<div class="brand-review-card community-brand-review">
                <div class="flex items-center justify-between mb-3 pb-3" style="border-bottom:1px solid #e2e8f0;">
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:10px;font-weight:700;color:#64748b;letter-spacing:0.05em;text-transform:uppercase;">نبض المجتمع حسب المنتج</div>
                        <div style="font-size:15px;font-weight:800;color:#0f172a;" class="truncate">${brand}</div>
                    </div>
                    <div style="text-align:left;flex-shrink:0;">
                        <div style="font-size:10px;font-weight:700;color:#64748b;">متوسط الرضا</div>
                        <div style="font-size:24px;font-weight:800;color:${_scoreColor(avg)};line-height:1;">${avg != null ? Math.round(avg) + '%' : '—'}</div>
                    </div>
                </div>
                <div style="font-size:11px;color:#94a3b8;font-weight:600;margin-bottom:0.5rem;">${total != null ? 'من أصل ' + total + ' رأي محلّل' : ''} · اضغط على أي منتج للتفاصيل</div>
                ${prodsHtml}
            </div>`;
        }

        // ============================================================
