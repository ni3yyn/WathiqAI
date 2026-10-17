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
                        <div style="display:flex;flex-wrap:wrap;gap:5px;">${items}</div>
                    </div>
                `;
            }

            // Compact, user-controlled details: keep backend facts available, but collapsed by default.
            const rawBreakdown = Array.isArray(analysis.scoreBreakdown) ? analysis.scoreBreakdown : [];
            const scoreFactors = [];
            const engineNotes = [];
            const seenNotes = new Set();

            const addEngineNote = (raw, fallbackType = 'info') => {
                const addOne = (entry) => {
                    if (entry == null) return;
                    let text = '';
                    let type = fallbackType;
                    if (typeof entry === 'string' || typeof entry === 'number') {
                        text = String(entry).trim();
                    } else if (typeof entry === 'object') {
                        text = String(entry.text || entry.message || entry.note || entry.description || entry.title || entry.ingredient || '').trim();
                        type = String(entry.type || entry.severity || entry.status || fallbackType).toLowerCase();
                    }
                    if (!text) return;
                    const key = text.toLocaleLowerCase();
                    if (seenNotes.has(key)) return;
                    seenNotes.add(key);
                    engineNotes.push({ text, type });
                };
                if (Array.isArray(raw)) raw.forEach(addOne);
                else addOne(raw);
            };

            // Only render score factors with a clear positive/negative meaning.
            // Numeric values and calculation rows intentionally stay hidden from the UI.
            rawBreakdown.forEach((item) => {
                if (!item || typeof item.text !== 'string' || !item.text.trim()) return;
                const type = String(item.type || '').toLowerCase();
                const value = String(item.value ?? '').trim();
                if (type === 'calculation') return;

                let polarity = null;
                if (['good', 'benefit', 'positive'].includes(type)) polarity = 'plus';
                else if (['override', 'deduction', 'danger', 'negative'].includes(type)) polarity = 'minus';
                else if (/^\s*\+/.test(value)) polarity = 'plus';
                else if (/^\s*-/.test(value)) polarity = 'minus';
                else if (/ميزة|مناسب لك|تطابق مثالي|تآزر إيجابي/.test(value + ' ' + item.text)) polarity = 'plus';
                else if (type === 'warning') polarity = 'minus';

                if (polarity) {
                    scoreFactors.push({ polarity, text: item.text.trim(), type });
                } else if (type === 'info' || !type) {
                    // Neutral backend notes have their own accordion; avoid showing them as score math.
                    addEngineNote({ text: item.text, type: 'info' });
                }
            });

            // Collect only notes the backend actually supplied. This deliberately supports
            // several deployed backend shapes without synthesizing new recommendations.
            addEngineNote(analysis.notes);
            addEngineNote(analysis.backendNotes);
            addEngineNote(analysis.evaluationNotes);
            addEngineNote(analysis.safety?.notes, 'warning');
            addEngineNote(Array.isArray(analysis.safety?.flags) && analysis.safety.flags.length ? analysis.safety.flags : analysis.safety?.alerts, 'warning');
            addEngineNote(analysis.efficacy?.notes, 'info');
            addEngineNote(analysis.efficacy?.summary || analysis.efficacy?.verdict, 'info');

            const noteTone = (type) => {
                const t = String(type || '').toLowerCase();
                if (/danger|risk|critical|override/.test(t)) return 'danger';
                if (/warning|warn|caveat|negative|deduction/.test(t)) return 'warning';
                if (/good|positive|success/.test(t)) return 'good';
                return 'info';
            };
            const noteToneLabel = (tone) => ({
                danger: 'تنبيه مهم', warning: 'ملاحظة', good: 'إيجابي', info: 'معلومة'
            }[tone] || 'ملاحظة');
            const notesHtml = engineNotes.length ? `
                <details class="analysis-detail-accordion analysis-notes-accordion">
                    <summary class="analysis-detail-summary">
                        <span class="analysis-detail-icon analysis-detail-icon-notes" aria-hidden="true">i</span>
                        <span class="analysis-detail-heading"><span class="analysis-detail-title">ملاحظات المحرك</span><span class="analysis-detail-subtitle">ملاحظات إضافية من بيانات التقييم</span></span>
                        <span class="analysis-detail-count">${engineNotes.length}</span>
                        <span class="analysis-detail-chevron" aria-hidden="true">⌄</span>
                    </summary>
                    <div class="analysis-detail-content">
                        <ul class="analysis-note-list">${engineNotes.slice(0, 12).map(note => {
                            const tone = noteTone(note.type);
                            return `<li class="analysis-note-item analysis-note-${tone}"><span class="analysis-note-label">${noteToneLabel(tone)}</span><span class="analysis-note-text">${formatInline(escapeHtml(note.text))}</span></li>`;
                        }).join('')}</ul>
                        ${engineNotes.length > 12 ? `<p class="analysis-detail-footnote">تم عرض 12 ملاحظة من أصل ${engineNotes.length}.</p>` : ''}
                    </div>
                </details>
            ` : '';

            const positives = scoreFactors.filter(item => item.polarity === 'plus');
            const negatives = scoreFactors.filter(item => item.polarity === 'minus');
            const renderFactor = (item) => `<li class="score-factor-item score-factor-${item.polarity}"><span class="score-factor-sign" aria-hidden="true">${item.polarity === 'plus' ? '+' : '−'}</span><span>${formatInline(escapeHtml(item.text))}</span></li>`;
            const renderFactorGroup = (label, items, polarity, visibleLimit = 4) => {
                if (!items.length) return '';
                const visible = items.slice(0, visibleLimit);
                const extra = items.slice(visibleLimit);
                return `<section class="score-factor-group score-factor-group-${polarity}">
                    <h4 class="score-factor-group-title"><span>${polarity === 'plus' ? '+' : '−'}</span>${label}<span class="score-factor-group-count">${items.length}</span></h4>
                    <ul class="score-factor-list">${visible.map(renderFactor).join('')}</ul>
                    ${extra.length ? `<details class="score-factor-more"><summary>عرض ${extra.length} عوامل أخرى</summary><ul class="score-factor-list">${extra.map(renderFactor).join('')}</ul></details>` : ''}
                </section>`;
            };
            const scoreBreakdownHtml = scoreFactors.length ? `
                <details class="analysis-detail-accordion analysis-score-accordion">
                    <summary class="analysis-detail-summary">
                        <span class="analysis-detail-icon analysis-detail-icon-score" aria-hidden="true">±</span>
                        <span class="analysis-detail-heading"><span class="analysis-detail-title">ما الذي رفع أو خفّض الدرجة؟</span><span class="analysis-detail-subtitle">العوامل الإيجابية والسلبية فقط، دون حسابات</span></span>
                        <span class="analysis-detail-count">+${positives.length} / −${negatives.length}</span>
                        <span class="analysis-detail-chevron" aria-hidden="true">⌄</span>
                    </summary>
                    <div class="analysis-detail-content score-factor-columns">
                        ${renderFactorGroup('عوامل إيجابية', positives, 'plus')}
                        ${renderFactorGroup('عوامل سلبية', negatives, 'minus')}
                    </div>
                </details>
            ` : '';

            const personalMatch = analysis.personalMatch && typeof analysis.personalMatch === 'object'
                ? analysis.personalMatch : null;
            const personalReasons = personalMatch && Array.isArray(personalMatch.reasons)
                ? personalMatch.reasons.map(item => typeof item === 'string'
                    ? { type: 'info', text: item }
                    : item && typeof item.text === 'string' ? item : null).filter(item => item && item.text.trim())
                : [];
            const personalStatus = String(personalMatch?.status || 'unknown').toLowerCase();
            const personalStatusInfo = {
                danger: { label: 'يحتاج انتباهًا', tone: 'danger' },
                warning: { label: 'تحفّظات لحالتك', tone: 'warning' },
                good: { label: 'لا توجد إشارة سلبية واضحة', tone: 'good' },
                unknown: { label: 'الملاءمة غير محسومة', tone: 'unknown' },
            }[personalStatus] || { label: 'الملاءمة غير محسومة', tone: 'unknown' };
            const shouldShowPersonalMatch = Boolean(personalMatch && (personalReasons.length || ['danger', 'warning', 'good'].includes(personalStatus)));
            const personalMatchHtml = shouldShowPersonalMatch ? `
                <details class="analysis-detail-accordion analysis-personal-accordion personal-match-${personalStatusInfo.tone}">
                    <summary class="analysis-detail-summary">
                        <span class="analysis-detail-icon analysis-detail-icon-personal" aria-hidden="true">${personalStatusInfo.tone === 'danger' ? '!' : personalStatusInfo.tone === 'good' ? '✓' : '•'}</span>
                        <span class="analysis-detail-heading"><span class="analysis-detail-title">الملاءمة لحالتك</span><span class="analysis-detail-subtitle">نتيجة التوافق الشخصي من محرك وثيق</span></span>
                        <span class="personal-match-status">${escapeHtml(personalStatusInfo.label)}</span>
                        <span class="analysis-detail-chevron" aria-hidden="true">⌄</span>
                    </summary>
                    <div class="analysis-detail-content">
                        ${personalReasons.length ? `<ul class="personal-match-reasons">${personalReasons.slice(0, 8).map(reason => {
                            const reasonTone = ['danger', 'warning', 'good'].includes(String(reason.type || '').toLowerCase())
                                ? String(reason.type).toLowerCase() : personalStatusInfo.tone;
                            return `<li class="personal-match-reason personal-match-reason-${reasonTone}">${formatInline(escapeHtml(reason.text))}</li>`;
                        }).join('')}</ul>` : `<p class="personal-match-empty">لم يُرجع المحرك ملاحظات شخصية إضافية لهذه النتيجة.</p>`}
                    </div>
                </details>
            ` : '';

            const accordionWrap = (title, subtitle, count, icon, content, modifier = '') => content ? `
                <details class="analysis-detail-accordion ${modifier}">
                    <summary class="analysis-detail-summary">
                        <span class="analysis-detail-icon" aria-hidden="true">${icon}</span>
                        <span class="analysis-detail-heading"><span class="analysis-detail-title">${title}</span><span class="analysis-detail-subtitle">${subtitle}</span></span>
                        <span class="analysis-detail-count">${count}</span>
                        <span class="analysis-detail-chevron" aria-hidden="true">⌄</span>
                    </summary>
                    <div class="analysis-detail-content">${content}</div>
                </details>` : '';

            const claimsAccordionHtml = claims.length ? accordionWrap(
                'الادعاءات التسويقية', 'ما يدعمه التحليل وما يحتاج إلى تحفّظ', claims.length, '✓', claimsHtml, 'analysis-claims-accordion'
            ) : '';
            const detectedAccordionHtml = Array.isArray(analysis.detected_ingredients) && analysis.detected_ingredients.length ? accordionWrap(
                'المكونات المطابقة', 'المكونات التي تعرّف عليها المحرك', analysis.detected_ingredients.length, '●', detectedHtml, 'analysis-ingredients-accordion'
            ) : '';
            const unknownAccordionHtml = Array.isArray(analysis.unknown_ingredients) && analysis.unknown_ingredients.length ? accordionWrap(
                'مكونات غير معروفة', 'مكونات لم تطابق قاعدة البيانات', analysis.unknown_ingredients.length, '!', unknownHtml, 'analysis-unknown-accordion'
            ) : '';

            return `
                <div class="analysis-card" style="margin-top:0.5rem;">
                    ${headerHtml}
                    ${scoresHtml}
                    <div class="analysis-detail-stack">
                        ${notesHtml}
                        ${personalMatchHtml}
                        ${scoreBreakdownHtml}
                        ${claimsAccordionHtml}
                        ${detectedAccordionHtml}
                        ${unknownAccordionHtml}
                    </div>
                </div>
            `;
        }

        // ============================================================
