        /* ============ INGREDIENT CHECK CARD (check_ingredient_list) ============ */
        function renderIngredientCheckCard(data) {
            const d = (data && data.ingredientCheck) || data || {};
            if (d.error) {
                return `<div class="analysis-card ingredient-check-card">
                    <div class="analysis-section-label">
                        <svg class="icon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert"/></svg>
                        <span>تعذّر فحص المكونات</span>
                    </div>
                    <div class="chat-prose" style="font-size:0.9rem;">${escapeHtml(d.error)}</div>
                </div>`;
            }

            const score = typeof d.score === 'number' ? d.score : null;
            const safety = typeof d.safetyScore === 'number' ? d.safetyScore : null;
            const flags = Array.isArray(d.safetyFlags) ? d.safetyFlags : [];
            const actives = Array.isArray(d.detectedActives) ? d.detectedActives : [];
            const unknown = Array.isArray(d.unknownIngredients) ? d.unknownIngredients : [];
            const allergens = Array.isArray(d.allergenHits) ? d.allergenHits : [];

            const chips = (list, cls) => list.length
                ? `<div style="display:flex;flex-wrap:wrap;gap:5px;">${list.map(i => `<span class="ingredient-chip ${cls || ''}">${escapeHtml(typeof i === 'string' ? i : (i.name || i.id || String(i)))}</span>`).join('')}</div>`
                : '<div style="font-size:12px;color:#a8b0a9;font-style:italic;">لا يوجد</div>';

            const allergenBox = allergens.length ? `
                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:0.75rem;padding:0.7rem 0.85rem;margin-bottom:0.85rem;">
                    <div style="font-size:12px;font-weight:800;color:#b91c1c;margin-bottom:0.35rem;">⚠️ تنبيه حساسية — مكونات تتعارض مع ملفك</div>
                    ${chips(allergens, 'ingredient-chip-unknown')}
                </div>` : '';

            return `<div class="analysis-card ingredient-check-card">
                <div class="analysis-head">
                    <div class="score-tile-icon" style="width:38px;height:38px;">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-microscope"/></svg>
                    </div>
                    <div style="flex:1;min-width:0;">
                        <div class="analysis-brand">فحص قائمة مكونات (INCI)</div>
                        <div class="analysis-product-name">منتج خارج الكتالوج</div>
                    </div>
                    <div style="flex-shrink:0;text-align:left;">
                        <div class="analysis-score-label">المؤشر</div>
                        <div style="display:flex;align-items:baseline;gap:4px;justify-content:flex-start;">
                            <span class="analysis-score-number" style="color:${_scoreColor(score)}">${score ?? '—'}</span>
                            <span class="analysis-score-unit">/100</span>
                        </div>
                    </div>
                </div>
                ${allergenBox}
                <div class="score-row">
                    <div class="score-tile">
                        <div class="score-tile-icon"><svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><use href="#i-shield"/></svg></div>
                        <div style="min-width:0;">
                            <div class="score-tile-label">السلامة</div>
                            <div class="score-tile-value" style="color:${_scoreColor(safety)};">${safety ?? '—'}<span class="unit">/100</span></div>
                        </div>
                    </div>
                </div>
                ${flags.length ? `
                <div class="analysis-block">
                    <div class="analysis-section-label">
                        <svg class="icon" fill="none" stroke="currentColor"><use href="#i-alert"/></svg>
                        <span>علامات السلامة</span><span class="analysis-section-count">${flags.length}</span>
                    </div>
                    ${chips(flags, 'ingredient-chip-unknown')}
                </div>` : ''}
                <div class="analysis-block">
                    <div class="analysis-section-label">
                        <svg class="icon" fill="none" stroke="currentColor"><use href="#i-droplet"/></svg>
                        <span>المكونات الفعالة المكتشفة</span><span class="analysis-section-count">${actives.length}</span>
                    </div>
                    ${chips(actives)}
                </div>
                ${unknown.length ? `
                <div class="analysis-block">
                    <div class="analysis-section-label">
                        <svg class="icon" fill="none" stroke="currentColor"><use href="#i-search"/></svg>
                        <span>مكونات غير معروفة</span><span class="analysis-section-count">${unknown.length}</span>
                    </div>
                    ${chips(unknown, 'ingredient-chip-unknown')}
                </div>` : ''}
                ${d.personalizedNote ? `<div class="routine-tips"><div class="routine-tips-title">💡 ملاحظة شخصية</div><div class="routine-tip-item rtl-text" dir="rtl">${escapeHtml(d.personalizedNote)}</div></div>` : ''}
            </div>`;
        }

        /* ============ BRAND REVIEWS CARD (get_community_reviews brandName scope) ============ */
