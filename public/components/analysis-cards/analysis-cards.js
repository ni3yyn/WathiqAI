        // PRODUCT ANALYSIS CARD
        // ============================================================
        function renderAnalysisCard(analysis, productName, brand, rawImage) {
            const score = analysis.oilGuardScore || 0;
            const safety = analysis.safety?.score || 0;
            const efficacy = analysis.efficacy?.score || 0;
            const verdict = analysis.finalVerdict || 'محايد';
            const claims = analysis.marketing_results || [];

            let productImg = rawImage || '';
            if (!productImg && window.__PRODUCTS_MAP__) {
                for (let k in window.__PRODUCTS_MAP__) {
                    const item = window.__PRODUCTS_MAP__[k];
                    if (item && item.name && productName && (item.name.includes(productName) || productName.includes(item.name))) {
                        productImg = item.image;
                        break;
                    }
                }
            }

            const scoreColor = score >= 70 ? '#3f7249' : score >= 50 ? '#97641f' : '#a34141';
            const verdictBg = score >= 70 ? 'bg-sage-100 text-sage-700' : score >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-600';

            function claimStatusInfo(status) {
                if (!status) return { icon: 'warn', cls: 'warn', text: '' };
                const s = status.toString();
                if (s.includes('محقق بنسبة معتبرة') || s.includes('محقق بنسبة متوسطة')) {
                    return { icon: 'check', cls: 'pass', text: s };
                }
                if (s.includes('مبالغة') || s.includes('لا توجد')) {
                    return { icon: 'x', cls: 'fail', text: s };
                }
                return { icon: 'alert', cls: 'warn', text: s };
            }

            const productNameRTL = isRTLText(productName || '');
            const brandRTL = isRTLText(brand || '');
            const safeImg = escapeHtml(productImg);
            const safeName = escapeHtml(productName || '');
            const safeBrand = escapeHtml(brand || 'وثيق');

            let headerHtml = `
                <div class="analysis-head">
                    ${productImg ? `
                        <div class="analysis-product-hero-img" onclick="openImageModal('${safeImg}', '${safeName}', '${safeBrand}')" title="اضغط لتكبير صورة المنتج">
                            <img src="${safeImg}" alt="${safeName}">
                            <div class="img-expand-badge"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5"><use href="#i-maximize"/></svg></div>
                        </div>
                    ` : ''}
                    <div style="flex:1;min-width:0;">
                        ${brand ? `<div class="analysis-brand ${brandRTL ? 'rtl-text' : ''}" ${brandRTL ? 'dir="rtl"' : ''}>${safeBrand}</div>` : ''}
                        ${productName ? `<div class="analysis-product-name ${productNameRTL ? 'rtl-text' : ''}" ${productNameRTL ? 'dir="rtl"' : ''}>${safeName}</div>` : ''}
                        <div>
                            <span class="analysis-verdict-badge ${verdictBg}">${escapeHtml(verdict)}</span>
                        </div>
                    </div>
                    <div style="flex-shrink:0;text-align:left;">
                        <div class="analysis-score-label">المؤشر</div>
                        <div style="display:flex;align-items:baseline;gap:4px;justify-content:flex-start;">
                            <span class="analysis-score-number" style="color:${scoreColor}">${score}</span>
                            <span class="analysis-score-unit">/100</span>
                        </div>
                    </div>
                </div>
            `;

            let scoresHtml = `
                <div class="score-row">
                    <div class="score-tile">
                        <div class="score-tile-icon">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-shield"/></svg>
                        </div>
                        <div style="min-width:0;">
                            <div class="score-tile-label">السلامة</div>
                            <div class="score-tile-value">${safety}<span class="unit">/100</span></div>
                        </div>
                    </div>
                    <div class="score-tile">
                        <div class="score-tile-icon">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#i-beaker"/></svg>
                        </div>
                        <div style="min-width:0;">
                            <div class="score-tile-label">الفعالية</div>
                            <div class="score-tile-value">${efficacy}<span class="unit">/100</span></div>
                        </div>
                    </div>
                </div>
            `;

            let claimsHtml = '';
            if (claims.length > 0) {
                let claimsInner = '';
                claims.forEach(c => {
                    const info = claimStatusInfo(c.status);
                    const claimRTL = isRTLText(c.claim || '');
                    const statusRTL = isRTLText(c.status || '');
                    const explainRTL = isRTLText(c.explanation || '');

                    const iconSvg = info.icon === 'check'
                        ? `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><use href="#i-check"/></svg>`
                        : info.icon === 'x'
                        ? `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><use href="#i-x"/></svg>`
                        : `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert"/></svg>`;

                    const iconCls = info.cls === 'pass' ? 'claim-icon-pass' : info.cls === 'fail' ? 'claim-icon-fail' : 'claim-icon-warn';
                    const rowCls = info.cls === 'pass' ? 'claim-row-pass' : info.cls === 'fail' ? 'claim-row-fail' : 'claim-row-warn';
                    const statusCls = info.cls === 'pass' ? 'claim-status-pass' : info.cls === 'fail' ? 'claim-status-fail' : 'claim-status-warn';

                    claimsInner += `
                        <div class="claim-row ${rowCls}">
                            <div style="display:flex;align-items:flex-start;gap:0.6rem;">
                                <div class="claim-icon-wrap ${iconCls}">${iconSvg}</div>
                                <div style="flex:1;min-width:0;">
                                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.5rem;margin-bottom:0.2rem;flex-wrap:wrap;">
                                        <div class="claim-title ${claimRTL ? 'rtl-text' : ''}" ${claimRTL ? 'dir="rtl"' : ''}>${formatInline(escapeHtml(c.claim || ''))}</div>
                                        ${c.confidence ? `<span class="claim-confidence">${escapeHtml(c.confidence)}</span>` : ''}
                                    </div>
                                    ${c.status ? `<div class="claim-status-text ${statusCls} ${statusRTL ? 'rtl-text' : ''}" ${statusRTL ? 'dir="rtl"' : ''}>${escapeHtml(c.status)}</div>` : ''}
                                    ${c.explanation ? `<div class="claim-explain ${explainRTL ? 'rtl-text' : ''}" ${explainRTL ? 'dir="rtl"' : ''}>${formatInline(escapeHtml(c.explanation))}</div>` : ''}
                                    ${c.proven && c.proven.length > 0 ? `
                                        <div class="claim-ingredients">
                                            ${c.proven.slice(0, 4).map(ing => {
                                                const ingName = ing.name || ing.id;
                                                const ingRTL = isRTLText(ingName);
                                                return `<span class="claim-ingredient ${ingRTL ? 'rtl-text' : ''}" ${ingRTL ? 'dir="rtl"' : ''}>${escapeHtml(ingName)}</span>`;
                                            }).join('')}
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                });

                claimsHtml = `
                    <div class="analysis-block">
                        <div class="analysis-section-label">
                            <svg class="icon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><use href="#i-clipboard"/></svg>
                            <span>تقييم الادعاءات</span>
                            <span class="analysis-section-count">${claims.length} تم تحليلها · اسحب أفقيًا</span>
                        </div>
                        <div class="claims-rail">${claimsInner}</div>
                    </div>
                `;
            } else {
                claimsHtml = `<div class="analysis-block" style="font-size:0.82rem;color:#a8b0a9;font-style:italic;">لم يتم إرجاع تحليل خاص بالادعاءات.</div>`;
            }

            let detectedHtml = '';
            if (analysis.detected_ingredients && analysis.detected_ingredients.length > 0) {
                const items = analysis.detected_ingredients.map(ing => {
                    const ingName = ing.name || ing.id;
                    const ingRTL = isRTLText(ingName);
                    return `<span class="ingredient-chip ${ingRTL ? 'rtl-text' : ''}" ${ingRTL ? 'dir="rtl"' : ''}>${escapeHtml(ingName)}</span>`;
                }).join('');
                detectedHtml = `
                    <div class="analysis-block">
                        <div class="analysis-section-label">
                            <svg class="icon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><use href="#i-droplet"/></svg>
                            <span>المكونات المكتشفة</span>
                            <span class="analysis-section-count">${analysis.detected_ingredients.length} مطابقة</span>
                        </div>
                        <div style="display:flex;flex-wrap:wrap;gap:5px;">${items}</div>
                    </div>
                `;
            }

            let unknownHtml = '';
            if (analysis.unknown_ingredients && analysis.unknown_ingredients.length > 0) {
                const items = analysis.unknown_ingredients.slice(0, 8).map(ing => {
                    const ingRTL = isRTLText(ing);
                    return `<span class="ingredient-chip ingredient-chip-unknown ${ingRTL ? 'rtl-text' : ''}" ${ingRTL ? 'dir="rtl"' : ''}>${escapeHtml(ing)}</span>`;
                }).join('');
                unknownHtml = `
                    <div class="analysis-block">
                        <div class="analysis-section-label">
                            <svg class="icon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><use href="#i-alert"/></svg>
                            <span>مكونات غير معروفة</span>
                            <span class="analysis-section-count">${analysis.unknown_ingredients.length}</span>
                        </div>
                        <div style="display:flex;flex-wrap:wrap;gap:5px;">${items}</div>
                    </div>
                `;
            }

            return `
                <div class="analysis-card" style="margin-top:0.5rem;">
                    ${headerHtml}
                    ${scoresHtml}
                    ${claimsHtml}
                    ${detectedHtml}
                    ${unknownHtml}
                </div>
            `;
        }

        // ============================================================
