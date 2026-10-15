        // ROUTINE CARD — Top horizontal mini-cards + Detailed steps
        // ============================================================
        function renderRoutineCard(routine) {
            if (!routine || !routine.steps || routine.steps.length === 0) return '';
            window.__PRODUCTS_MAP__ = window.__PRODUCTS_MAP__ || {};

            const titleRTL = isRTLText(routine.title || '');
            const usedPct = Math.min(100, Math.round((routine.totalCost / routine.maxBudget) * 100));
            const savingsText = routine.savings > 0 
                ? `<span style="color:#3f7249;font-weight:700;">وفّرت ${routine.savings} دج</span>` 
                : '<span style="color:#7c857d;">استُغلّت الميزانية بالكامل</span>';

            let headerHtml = `
                <div class="routine-header">
                    <div style="min-width:0;flex:1;">
                        <div class="analysis-brand">روتين وثيق المخصص</div>
                        <div class="analysis-product-name ${titleRTL ? 'rtl-text' : ''}" ${titleRTL ? 'dir="rtl"' : ''}>${escapeHtml(routine.title)}</div>
                    </div>
                    <div style="flex-shrink:0;text-align:left;">
                        <div class="analysis-score-label">المنتجات</div>
                        <div style="display:flex;align-items:baseline;gap:4px;">
                            <span class="analysis-score-number" style="color:#3f7249">${routine.stepsCount}</span>
                        </div>
                    </div>
                </div>
            `;

            let budgetHtml = `
                <div class="routine-budget-bar">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                            <span style="font-size:11.5px;font-weight:700;color:#454b46;">${routine.totalCost} دج <span style="color:#a8b0a9;font-weight:500;">من ${routine.maxBudget} دج</span></span>
                            <span style="font-size:11px;">${savingsText}</span>
                        </div>
                        <div style="height:6px;border-radius:999px;background:rgba(124,174,135,0.15);overflow:hidden;">
                            <div class="routine-budget-fill" style="width:${usedPct}%;"></div>
                        </div>
                    </div>
                </div>
            `;

            let routineSummaryRailHtml = `
                <div class="analysis-block">
                    <div class="analysis-section-label">
                        <svg class="icon" fill="none" stroke="currentColor"><use href="#i-package"/></svg>
                        <span>منتجات الروتين (${routine.steps.length})</span>
                    </div>
                    <div class="routine-summary-rail">
            `;

            routine.steps.forEach(step => {
                const prod = step.product || {};
                if (prod.id) window.__PRODUCTS_MAP__[prod.id] = prod;
                const safeImg = escapeHtml(prod.image || '');
                const safeName = escapeHtml(prod.name || '');
                const safeBrand = escapeHtml(prod.brand || 'وثيق');

                routineSummaryRailHtml += `
                    <div class="routine-summary-card" onclick="evaluateProductById('${prod.id}')" title="اضغط لتقييم المنتج: ${safeName}">
                        <div class="routine-summary-img-wrap" ${safeImg ? `onclick="event.stopPropagation(); openImageModal('${safeImg}', '${safeName}', '${safeBrand}')"` : ''} title="${safeImg ? 'اضغط لتكبير الصورة' : ''}">
                            <span class="routine-summary-step-badge">خطوة ${step.stepNumber}</span>
                            ${safeImg 
                                ? `<img src="${safeImg}" alt="${safeName}" onerror="this.parentElement.innerHTML='<svg width=\\'22\\' height=\\'22\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'1.75\\'><use href=\\'#i-package\\'/></svg>'">
                                   <div class="img-expand-badge"><svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="2.5"><use href="#i-maximize"/></svg></div>`
                                : '<svg class="w-6 h-6 text-sage-600" fill="none" stroke="currentColor" stroke-width="1.75"><use href="#i-package"/></svg>'}
                        </div>
                        <div style="min-width:0;">
                            <div style="font-size:9.5px;font-weight:700;color:#3f7249;text-transform:uppercase;letter-spacing:0.04em;" class="truncate">${safeBrand}</div>
                            <div style="font-size:11.5px;font-weight:700;color:#253d2c;line-height:1.3;margin-top:1px;" class="truncate">${safeName}</div>
                            <div style="font-size:11px;font-weight:700;color:#3f7249;margin-top:2px;">${prod.price || 0} ${prod.currency || 'دج'}</div>
                        </div>
                    </div>
                `;
            });
            routineSummaryRailHtml += `</div></div>`;

            let stepsHtml = '';
            routine.steps.forEach(step => {
                const prod = step.product || {};
                const stepNameRTL = isRTLText(step.stepName || '');
                const productNameRTL = isRTLText(prod.name || '');
                const howToRTL = isRTLText(step.howToUse || '');
                const safeImg = escapeHtml(prod.image || '');
                const safeName = escapeHtml(prod.name || '');
                const safeBrand = escapeHtml(prod.brand || 'وثيق');

                stepsHtml += `
    <div class="routine-step">
        <div class="routine-step-num">${step.stepNumber}</div>
        <div class="routine-step-body">
            <div class="routine-step-name ${stepNameRTL ? 'rtl-text' : ''}" ${stepNameRTL ? 'dir="rtl"' : ''}>${escapeHtml(step.stepName)}</div>
            <div class="routine-step-product" onclick="evaluateProductById('${prod.id}')" title="اضغط لتقييم هذا المنتج">
                <div class="routine-step-product-img-wrap" ${safeImg ? `onclick="event.stopPropagation(); openImageModal('${safeImg}', '${safeName}', '${safeBrand}')"` : ''} title="${safeImg ? 'اضغط لتكبير الصورة' : ''}">
                    ${safeImg 
                        ? `<img src="${safeImg}" alt="${safeName}" onerror="this.parentElement.innerHTML='<svg width=\\'20\\' height=\\'20\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'1.75\\'><use href=\\'#i-package\\'/></svg>'">
                           <div class="img-expand-badge"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5"><use href="#i-maximize"/></svg></div>`
                        : '<svg class="w-5 h-5 text-sage-600" fill="none" stroke="currentColor" stroke-width="1.75"><use href="#i-package"/></svg>'}
                </div>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#3f7249;margin-bottom:1px;">${safeBrand}</div>
                    <div style="font-size:13px;font-weight:700;color:#253d2c; ${productNameRTL ? 'direction:rtl;text-align:right;' : ''}">${safeName}</div>
                    <div style="font-size:12px;color:#3f7249;font-weight:700;margin-top:2px;">${prod.price || ''} ${prod.currency || 'دج'}</div>
                </div>
                <div class="product-mini-eval" title="تقييم">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2"><use href="#i-bolt"/></svg>
                </div>
            </div>
            <div class="routine-step-meta" ${howToRTL ? 'dir="rtl"' : ''}>
                <strong>⏰ ${escapeHtml(step.usageTime || '')}</strong><br>
                ${escapeHtml(step.howToUse || '')}
            </div>
        </div>
    </div>
`;
            });

            let tipsHtml = '';
            if (routine.usageTips && routine.usageTips.length > 0) {
                const tipsItems = routine.usageTips.map(tip => {
                    const tipRTL = isRTLText(tip);
                    return `<div class="routine-tip-item ${tipRTL ? 'rtl-text' : ''}" ${tipRTL ? 'dir="rtl"' : ''}>${escapeHtml(tip)}</div>`;
                }).join('');
                tipsHtml = `
                    <div class="routine-tips">
                        <div class="routine-tips-title">💡 نصائح الاستخدام</div>
                        ${tipsItems}
                    </div>
                `;
            }

            return `
                <div class="routine-card" style="margin-top:0.5rem;">
                    ${headerHtml}
                    ${budgetHtml}
                    ${routineSummaryRailHtml}
                    <div class="analysis-block">
                        <div class="analysis-section-label">
                            <svg class="icon" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><use href="#i-routine"/></svg>
                            <span>خطوات التطبيق بالتفصيل</span>
                            <span class="analysis-section-count">${routine.stepsCount} خطوات</span>
                        </div>
                        <div class="routine-steps">${stepsHtml}</div>
                    </div>
                    ${tipsHtml}
                </div>
            `;
        }

