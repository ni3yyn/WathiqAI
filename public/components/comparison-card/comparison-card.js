        /* ============ COMPARISON CARD (compare_products) ============ */
        function _scoreColor(v) {
            return v == null ? '#a8b0a9' : (v >= 70 ? '#3f7249' : v >= 50 ? '#97641f' : '#a34141');
        }

        function renderComparisonCard(data) {
            const c = (data && data.comparison) || data || {};
            if (c.error) {
                return `<div class="analysis-card comparison-card">
                    <div class="analysis-section-label">
                        <svg class="icon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert"/></svg>
                        <span>تعذّرت المقارنة</span>
                    </div>
                    <div class="chat-prose" style="font-size:0.9rem;">${escapeHtml(c.error)}</div>
                </div>`;
            }
            const entries = Array.isArray(c.entries) ? c.entries : [];
            if (!entries.length) return '';

            window.__PRODUCTS_MAP__ = window.__PRODUCTS_MAP__ || {};
            entries.forEach(e => {
                window.__PRODUCTS_MAP__[e.id] = Object.assign(
                    {}, window.__PRODUCTS_MAP__[e.id] || {},
                    { id: e.id, brand: e.brand, name: e.name }
                );
            });

            const winners = c.winners || {};
            const WIN_AR = { overall: 'الأفضل إجمالاً', safety: 'الأسلم', efficacy: 'الأكثر فعالية', cheapest: 'الأرخص' };
            const winMap = {};
            Object.keys(winners).forEach(k => {
                if (winners[k] && winners[k].id) {
                    (winMap[winners[k].id] = winMap[winners[k].id] || []).push(WIN_AR[k] || k);
                }
            });

            const shared = Array.isArray(c.sharedActives) ? c.sharedActives : [];

            const cellScore = v => v == null
                ? '<span style="color:#a8b0a9;">—</span>'
                : `<span style="font-weight:800;color:${_scoreColor(v)};">${v}</span><span style="font-size:10px;color:#a8b0a9;">/100</span>`;

            let rows = '';
            const addRow = (label, fn) => {
                rows += `<tr><td style="font-weight:700;color:#5b635c;font-size:0.82rem;white-space:nowrap;">${label}</td>`;
                entries.forEach(e => { rows += `<td>${fn(e)}</td>`; });
                rows += `</tr>`;
            };

            addRow('السعر', e => `<span style="font-weight:700;color:#3f7249;">${escapeHtml(e.price || '—')}</span>`);
            addRow('التقييم العام', e => cellScore(e.score));
            addRow('السلامة', e => cellScore(e.safetyScore));
            addRow('الفعالية', e => cellScore(e.efficacyScore));
            addRow('مصداقية الادعاءات', e => e.claimsHonesty
                ? `<span style="font-weight:700;color:#253d2c;">${escapeHtml(e.claimsHonesty)}</span>`
                : '<span style="color:#a8b0a9;">—</span>');
            addRow('المكونات الفعالة', e => (e.keyIngredients && e.keyIngredients.length)
                ? e.keyIngredients.slice(0, 4).map(i => `<span class="claim-ingredient">${escapeHtml(i)}</span>`).join(' ')
                : '<span style="color:#a8b0a9;">—</span>');
            addRow('تحذيرات الحساسية', e => (e.allergenHits && e.allergenHits.length)
                ? e.allergenHits.map(i => `<span class="acc-chip danger">${escapeHtml(i)}</span>`).join(' ')
                : '<span style="color:#a8b0a9;">لا يوجد</span>');

            let headCells = '';
            entries.forEach(e => {
                const nameRTL = isRTLText(e.name || '');
                const wins = winMap[e.id] || [];
                headCells += `<th style="white-space:normal;min-width:110px;">
                    <div class="${nameRTL ? 'rtl-text' : ''}" ${nameRTL ? 'dir="rtl"' : ''} style="font-size:12px;text-transform:none;letter-spacing:0;color:#253d2c;cursor:pointer;" onclick="evaluateProductById('${escapeHtml(e.id)}')" title="اضغط لتقييم هذا المنتج">${escapeHtml(e.brand || '')}<br>${escapeHtml(e.name || '')}</div>
                    ${wins.length ? `<div style="margin-top:4px;">${wins.map(w => `<span class="acc-chip safe" style="font-size:10px;padding:1px 6px;">🏆 ${w}</span>`).join('')}</div>` : ''}
                </th>`;
            });

            const summaryHtml = c.summary ? `<div class="acc-note" style="margin:0 0 0.8rem;">${escapeHtml(c.summary)}</div>` : '';
            const sharedHtml = shared.length ? `
                <div style="margin-top:0.8rem;">
                    <div style="font-size:0.82rem;font-weight:700;color:#475569;margin-bottom:0.4rem;">مكونات فعالة مشتركة</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;">${shared.map(i => `<span class="acc-chip">${escapeHtml(i)}</span>`).join('')}</div>
                </div>` : '';

            return `<div class="analysis-card comparison-card">
                <div class="analysis-head" style="margin-bottom:0.7rem;">
                    <div class="score-tile-icon" style="width:38px;height:38px;">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-search"/></svg>
                    </div>
                    <div style="flex:1;min-width:0;">
                        <div class="analysis-brand">مقارنة وثيق الجانبية</div>
                        <div class="analysis-product-name">${entries.length} منتجات بنفس المعايير</div>
                    </div>
                </div>
                ${summaryHtml}
                <div class="table-wrap"><table>
                    <thead><tr><th>المعيار</th>${headCells}</tr></thead>
                    <tbody>${rows}</tbody>
                </table></div>
                ${sharedHtml}
            </div>`;
        }

