        // BRAND REVIEW INTERACTIVE CARD (CLINICAL AUDIT DOSSIER)
        // ============================================================
        function renderBrandReviewCard(data) {
    if (!data) return '';
    const b = data.brandReview || data;

    const brandName = escapeHtml(b.brand || 'العلامة التجارية');
    const sampleSize = b.sampleSize || 0;
    const confidenceTier = b.confidenceTier || 'medium';
    const verdict = b.verdict || {};
    const pricing = b.pricing;
    const safety = b.safety || {};
    const claimsHonesty = b.claimsHonesty;
    const transparency = b.transparency || {};
    const coverage = b.coverage || {};
    const standout = b.standoutProducts || {};
    const generalNotes = Array.isArray(b.generalNotes) ? b.generalNotes : [];

    // Arabic labels for category ids (edit here to rename anything)
    const CAT_AR = { cleanser:'غسول', lotion_cream:'مرطب / كريم', shampoo:'شامبو', body_wash:'غسول الجسم', skin_serum:'سيروم للبشرة', scrub:'مقشّر', sunscreen:'واقي شمس', other:'أخرى', oil_replacement:'بديل الزيوت', mask:'ماسك', face_mask:'ماسك للوجه', conditioner:'بلسم', eye_cream:'كريم العين', hair_mask:'ماسك للشعر', toner:'تونر', hair_serum:'سيروم للشعر', oil_blend:'خلطة زيوت' };
    const catAr = id => CAT_AR[String(id || '').toLowerCase()] || id;
    const SEV_AR  = { critical: ['خطير', 'danger'], moderate: ['متوسط', 'warn'], minor: ['طفيف', ''] };
    const TIER_AR = { banned: ['محظورة', 'danger'], controversial: ['جدلية', 'warn'], unclassified: ['غير مصنفة', ''], moderate: ['مقبولة', ''], modern: ['حديثة', 'safe'] };
    const prodPills = list => (list || []).map(p => `<span class="acc-prod-pill" onclick="evaluateProductById('${escapeHtml(p.id || '')}')" title="اضغط لتقييم المنتج">${escapeHtml(p.name || '')}${p.status ? `<em>${escapeHtml(p.status)}</em>` : ''}</span>`).join('');

    // Date
    let dateText = 'مؤخراً';
    if (b.lastComputed) {
        try {
            const d = new Date(b.lastComputed);
            if (!isNaN(d.getTime())) {
                dateText = new Intl.DateTimeFormat('ar-DZ', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
            }
        } catch (e) {}
    }

    const isInsufficient = (verdict.tier === 'بيانات غير كافية');
    const avgScore = (typeof verdict.avgScore === 'number' && !isInsufficient) ? Math.round(verdict.avgScore) : null;

    let tierClass = 'tier-badge-trusted';
    if (verdict.tier === 'جيدة مع تحفظات') tierClass = 'tier-badge-good';
    else if (verdict.tier === 'متوسطة') tierClass = 'tier-badge-moderate';
    else if (verdict.tier === 'غير متسقة، يُنصح بالحذر') tierClass = 'tier-badge-caution';
    else if (isInsufficient) tierClass = 'tier-badge-insufficient';

    // ─── HERO (always visible, no accordion) ─────────────────────
    let heroHtml = `
        <div class="brand-hero-v2">
            <div class="bh-row">
                <div style="min-width:0;flex:1;">
                    <div class="bh-label">خلاصة تدقيق العلامة</div>
                    <div style="font-size:1.3rem;font-weight:800;color:#0f172a;line-height:1.25;margin-bottom:6px;">${brandName}</div>
                    <span class="bh-tier ${tierClass}">${escapeHtml(verdict.tier || 'تقييم غير محدد')}</span>
                </div>
                <div style="text-align:left;flex-shrink:0;">
                    <div class="bh-label">المتوسط العام</div>
                    <div class="bh-score">${avgScore !== null ? avgScore : '—'}<span class="unit">/100</span></div>
                </div>
            </div>
            <div class="bh-meta">
                ${isInsufficient
                    ? `لا تتوفر بيانات كافية لإصدار حكم — تم فحص ${sampleSize} منتج فقط.`
                    : `تم تحليل <strong>${sampleSize}</strong> منتجاً من كتالوج العلامة · آخر تحديث ${dateText}`
                }
                ${confidenceTier === 'low' ? ' · <span style="color:#b45309;font-weight:700;">ثقة منخفضة (عينة صغيرة)</span>' : ''}
            </div>
        </div>
    `;

    // ─── Helper to build an accordion item ───────────────────────
    const accItem = ({ id, title, subtitle, statusText, tone, iconSvg, bodyHtml, defaultOpen }) => `
        <div class="accordion-item ${defaultOpen ? 'open' : ''}">
            <div class="accordion-header" onclick="toggleAccordion(this)">
                <div class="accordion-icon tone-${tone}">${iconSvg}</div>
                <div class="accordion-titles">
                    <div class="accordion-title">${title}</div>
                    ${subtitle ? `<div class="accordion-subtitle">${subtitle}</div>` : ''}
                </div>
                <div class="accordion-right">
                    ${statusText ? `<span class="accordion-status-pill tone-${tone}">${statusText}</span>` : ''}
                    <svg class="accordion-chevron" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
            </div>
            <div class="accordion-body">${bodyHtml}</div>
        </div>
    `;

    // SVG snippets
    const svgShield  = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6l8-3z"/></svg>`;
    const svgClaim   = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6M9 15h4"/></svg>`;
    const svgEye     = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const svgTag     = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 12l-8 8-9-9V4h7l10 8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`;
    const svgStar    = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polygon points="12 3 15 9 21 10 17 14.5 18 21 12 18 6 21 7 14.5 3 10 9 9 12 3"/></svg>`;
    const svgNote    = `<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/></svg>`;

    let html = '';

    // ─── 1. SAFETY ────────────────────────────────────────────────
    const alertRatePct = Math.round((safety.alertRate || 0) * 100);
    const safetyTone = alertRatePct >= 40 ? 'danger' : alertRatePct >= 15 ? 'warn' : 'safe';
    const critCount = safety.conflictSeverityCounts?.critical || 0;
    const modCount  = safety.conflictSeverityCounts?.moderate || 0;
    const minCount  = safety.conflictSeverityCounts?.minor || 0;

    const pTiers = safety.preservativeTierCounts || {};
    const modernP = pTiers.modern || 0, modP = pTiers.moderate || 0;
    const controP = pTiers.controversial || 0, bannedP = pTiers.banned || 0;
    const unclassP = pTiers.unclassified || 0;
    const totalPres = (modernP + modP + controP + bannedP + unclassP) || 1;

    const safetyBody = `
        <div class="acc-row">
            <span class="acc-row-label">نسبة المنتجات التي بها تعارضات تركيبية</span>
            <span class="acc-row-value">${alertRatePct}%</span>
        </div>
        <div class="acc-row">
            <span class="acc-row-label">تعارضات خطيرة</span>
            <span class="acc-row-value ${critCount === 0 ? 'muted' : ''}">${critCount}</span>
        </div>
        <div class="acc-row">
            <span class="acc-row-label">تعارضات متوسطة</span>
            <span class="acc-row-value ${modCount === 0 ? 'muted' : ''}">${modCount}</span>
        </div>
        <div class="acc-row">
            <span class="acc-row-label">تعارضات طفيفة</span>
            <span class="acc-row-value ${minCount === 0 ? 'muted' : ''}">${minCount}</span>
        </div>
        <div class="acc-row">
            <span class="acc-row-label">منتجات خالية من العطور</span>
            <span class="acc-row-value">${safety.fragranceFreeCount || 0} من ${sampleSize}</span>
        </div>
        <div class="acc-row">
            <span class="acc-row-label">منتجات تحتوي زيوتاً أساسية</span>
            <span class="acc-row-value">${safety.essentialOilProductCount || 0} من ${sampleSize}</span>
        </div>

        <div style="margin-top:0.9rem;">
            <div style="font-size:0.82rem;font-weight:700;color:#475569;margin-bottom:0.5rem;">أنظمة الحفظ المستخدمة</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                <span class="acc-chip safe">حديثة: ${modernP}</span>
                <span class="acc-chip">مقبولة: ${modP}</span>
                <span class="acc-chip warn">جدلية: ${controP}</span>
                ${bannedP > 0 ? `<span class="acc-chip danger">محظورة: ${bannedP}</span>` : ''}
                <span class="acc-chip">غير مصنفة: ${unclassP}</span>
            </div>
        </div>
        ${(Array.isArray(safety.conflictDetails) && safety.conflictDetails.length) ? `
            <div class="acc-sub-title">التعارضات المرصودة</div>
            ${safety.conflictDetails.map(g => { const sv = SEV_AR[g.severity] || SEV_AR.minor; return `
                <details class="acc-detail">
                    <summary>
                        <span class="acc-chip ${sv[1]}" style="margin:0;">${sv[0]}</span>
                        <span class="acc-detail-name">${escapeHtml(g.title)}</span>
                        <span class="acc-detail-count">${g.productCount} منتج</span>
                    </summary>
                    <div class="acc-detail-body">
                        ${g.description ? `<div class="acc-detail-desc">${escapeHtml(g.description)}</div>` : ''}
                        ${(g.ingredients && g.ingredients.length) ? `<div class="acc-detail-label">المكونات المتعارضة</div><div>${g.ingredients.map(i => `<span class="acc-chip">${escapeHtml(i)}</span>`).join('')}</div>` : ''}
                        <div class="acc-detail-label">المنتجات المتأثرة</div>
                        <div>${prodPills(g.products)}</div>
                    </div>
                </details>`; }).join('')}
        ` : ''}

        ${(Array.isArray(safety.preservativeDetails) && safety.preservativeDetails.length) ? `
            <div class="acc-sub-title">المواد الحافظة المرصودة وأين توجد</div>
            ${safety.preservativeDetails.map(g => { const tr = TIER_AR[g.tier] || TIER_AR.unclassified; return `
                <details class="acc-detail">
                    <summary>
                        <span class="acc-chip ${tr[1]}" style="margin:0;">${tr[0]}</span>
                        <span class="acc-detail-name">${escapeHtml(g.name)}</span>
                        <span class="acc-detail-count">${g.productCount} منتج</span>
                    </summary>
                    <div class="acc-detail-body">
                        ${g.scientificName ? `<div class="acc-detail-desc" dir="ltr" style="text-align:right;">${escapeHtml(g.scientificName)}</div>` : ''}
                        <div class="acc-detail-label">موجودة في</div>
                        <div>${prodPills(g.products)}</div>
                    </div>
                </details>`; }).join('')}
        ` : ''}
    `;
    html += accItem({
        title: 'السلامة والتعارضات',
        subtitle: 'مستوى الأمان العام ومواد الحفظ المستخدمة',
        statusText: `${alertRatePct}% تحذير`,
        tone: safetyTone,
        iconSvg: svgShield,
        bodyHtml: safetyBody,
        defaultOpen: alertRatePct >= 25
    });

    // ─── 2. CLAIMS HONESTY ────────────────────────────────────────
    if (claimsHonesty && typeof claimsHonesty.substantiatedRate === 'number') {
        const subRate = Math.round(claimsHonesty.substantiatedRate * 100);
        const claimsTone = subRate >= 70 ? 'safe' : subRate >= 40 ? 'warn' : 'danger';
        const unsuppList = Array.isArray(claimsHonesty.commonUnsupportedClaims) ? claimsHonesty.commonUnsupportedClaims : [];
        const claimsBody = `
            <div class="acc-row">
                <span class="acc-row-label">نسبة الادعاءات المدعومة علمياً</span>
                <span class="acc-row-value">${subRate}%</span>
            </div>
            <div class="acc-row">
                <span class="acc-row-label">عدد الادعاءات المفحوصة</span>
                <span class="acc-row-value">${claimsHonesty.totalClaimsEvaluated || 0}</span>
            </div>
            ${unsuppList.length > 0 ? `
                <div style="margin-top:0.9rem;">
                    <div style="font-size:0.82rem;font-weight:700;color:#475569;margin-bottom:0.5rem;">ادعاءات شائعة غير مدعومة</div>
                    ${(Array.isArray(claimsHonesty.unsupportedClaimDetails) && claimsHonesty.unsupportedClaimDetails.length)
                        ? claimsHonesty.unsupportedClaimDetails.map(g => `
                            <details class="acc-detail">
                                <summary>
                                    <span class="acc-detail-name">${escapeHtml(g.claim)}</span>
                                    <span class="acc-detail-count">${g.count} منتج</span>
                                </summary>
                                <div class="acc-detail-body">
                                    <div class="acc-detail-label">منتجات لا تدعم هذا الادعاء (وحالة كل منها)</div>
                                    <div>${prodPills(g.products)}</div>
                                </div>
                            </details>`).join('')
                        : `<div style="display:flex;flex-wrap:wrap;gap:4px;">${unsuppList.slice(0, 6).map(c => `<span class="acc-chip danger">${escapeHtml(c)}</span>`).join('')}</div>`}
                </div>
            ` : `<div class="acc-note">لا توجد ادعاءات مبالغ فيها متكررة — تسويق العلامة يبدو صادقاً.</div>`}
        `;
        html += accItem({
            title: 'مصداقية الادعاءات التسويقية',
            subtitle: `هل تفي العلامة بما تعد به؟`,
            statusText: `${subRate}% مدعومة`,
            tone: claimsTone,
            iconSvg: svgClaim,
            bodyHtml: claimsBody,
            defaultOpen: false
        });
    }

    // ─── 3. TRANSPARENCY ──────────────────────────────────────────
    const unkRatePct = Math.round((transparency.unknownIngredientRate || 0) * 100);
    const transTone = unkRatePct >= 25 ? 'warn' : 'safe';
    const transBody = `
        <div class="acc-row">
            <span class="acc-row-label">مكونات غير مفهرسة في قاعدتنا</span>
            <span class="acc-row-value">${unkRatePct}%</span>
        </div>
        <div class="acc-note">
            ${unkRatePct > 0
                ? `${unkRatePct}% من المكونات غير مفهرسة، مما قد يخفض دقة التحليل بنفس النسبة.`
                : 'جميع مكونات منتجات العلامة مفهرسة بدقة في المعاجم القياسية.'}
        </div>
    `;
    html += accItem({
        title: 'الشفافية وقابلية الفحص',
        subtitle: 'نسبة المكونات المعروفة في قاعدة بياناتنا',
        statusText: `${unkRatePct}% مجهول`,
        tone: transTone,
        iconSvg: svgEye,
        bodyHtml: transBody,
        defaultOpen: false
    });

    // ─── 4. COVERAGE + PRICING ────────────────────────────────────
    const categories = Array.isArray(coverage.categories) ? coverage.categories : [];
    const countries = Array.isArray(coverage.countriesOfOrigin) ? coverage.countriesOfOrigin : [];

    let pricingRows = '';
    if (pricing && typeof pricing.avg === 'number') {
        const cur = escapeHtml(pricing.currency || 'دج');
        pricingRows = `
            <div class="acc-row">
                <span class="acc-row-label">متوسط السعر</span>
                <span class="acc-row-value">${pricing.avg} ${cur}</span>
            </div>
            <div class="acc-row">
                <span class="acc-row-label">أرخص منتج</span>
                <span class="acc-row-value">${pricing.min} ${cur}</span>
            </div>
            <div class="acc-row">
                <span class="acc-row-label">أغلى منتج</span>
                <span class="acc-row-value">${pricing.max} ${cur}</span>
            </div>
        `;
    } else {
        pricingRows = `<div class="acc-note">بيانات الأسعار غير متوفرة لهذه العلامة حالياً.</div>`;
    }

    let priceStatus = '—';
    if (pricing && typeof pricing.avg === 'number') {
        priceStatus = `${pricing.avg} ${escapeHtml(pricing.currency || 'دج')}`;
    }

    const coverageBody = `
        ${categories.length > 0 ? `
            <div style="margin-bottom:0.8rem;">
                <div style="font-size:0.82rem;font-weight:700;color:#475569;margin-bottom:0.5rem;">التصنيفات المتوفرة</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">
                    ${((Array.isArray(coverage.categoryCounts) && coverage.categoryCounts.length) ? coverage.categoryCounts.map(c => `<span class="acc-chip">${escapeHtml(catAr(c.id))} · ${c.count}</span>`) : categories.map(c => `<span class="acc-chip">${escapeHtml(catAr(c))}</span>`)).join('')}
                </div>
            </div>
        ` : ''}
        ${countries.length > 0 ? `
            <div style="margin-bottom:0.8rem;">
                <div style="font-size:0.82rem;font-weight:700;color:#475569;margin-bottom:0.5rem;">بلدان المنشأ</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">
                    ${countries.map(c => `<span class="acc-chip">${escapeHtml(c)}</span>`).join('')}
                </div>
            </div>
        ` : ''}
        <div style="margin-top:0.6rem;">
            <div style="font-size:0.82rem;font-weight:700;color:#475569;margin-bottom:0.4rem;">الأسعار</div>
            ${pricingRows}
        </div>
    `;
    html += accItem({
        title: 'التغطية والأسعار',
        subtitle: 'ما تقدمه العلامة وبأي سعر',
        statusText: priceStatus,
        tone: 'info',
        iconSvg: svgTag,
        bodyHtml: coverageBody,
        defaultOpen: false
    });

    // ─── 5. STANDOUT PRODUCTS ─────────────────────────────────────
    const bestList = Array.isArray(standout.best) ? standout.best : [];
    const worstList = Array.isArray(standout.worst) ? standout.worst : [];
    if (bestList.length > 0 || worstList.length > 0) {
        const bestRows = bestList.map(p => `
            <div class="standout-row" onclick="evaluateProductById('${p.id || ''}')" title="اضغط لتقييم المنتج">
                <div style="min-width:0;flex:1;">
                    <div class="standout-name">${escapeHtml(p.name || '')}</div>
                </div>
                <div class="standout-score good">${p.score}/100</div>
            </div>
        `).join('');
        const worstRows = worstList.map(p => `
            <div class="standout-row" onclick="evaluateProductById('${p.id || ''}')" title="اضغط لتقييم المنتج">
                <div style="min-width:0;flex:1;">
                    <div class="standout-name">${escapeHtml(p.name || '')}</div>
                    ${p.reason ? `<div class="standout-reason">${escapeHtml(p.reason)}</div>` : ''}
                </div>
                <div class="standout-score bad">${p.score}/100</div>
            </div>
        `).join('');

        const standoutBody = `
            ${bestList.length > 0 ? `
                <div style="font-size:0.82rem;font-weight:700;color:#047857;margin-bottom:0.6rem;">▲ الأفضل تقييماً</div>
                ${bestRows}
            ` : ''}
            ${worstList.length > 0 ? `
                <div style="font-size:0.82rem;font-weight:700;color:#b91c1c;margin:0.9rem 0 0.6rem;">▼ تحتاج حذراً</div>
                ${worstRows}
            ` : ''}
        `;
        html += accItem({
            title: 'أبرز منتجات العلامة',
            subtitle: 'الأفضل والأضعف في الكتالوج',
            statusText: `${bestList.length + worstList.length} منتج`,
            tone: 'info',
            iconSvg: svgStar,
            bodyHtml: standoutBody,
            defaultOpen: true
        });
    }

    // ─── 6. ANALYST NOTES ─────────────────────────────────────────
    if (generalNotes.length > 0) {
        const notesBody = generalNotes.map(n => `
            <div style="display:flex;gap:0.6rem;padding:0.5rem 0;font-size:0.88rem;color:#334155;line-height:1.7;">
                <span style="color:#94a3b8;font-weight:700;flex-shrink:0;">•</span>
                <span>${escapeHtml(n)}</span>
            </div>
        `).join('');
        html += accItem({
            title: 'ملاحظات المحللين',
            subtitle: 'ملاحظات إضافية من فريق وثيق',
            statusText: `${generalNotes.length} ملاحظة`,
            tone: 'info',
            iconSvg: svgNote,
            bodyHtml: notesBody,
            defaultOpen: false
        });
    }

    return `<div class="brand-review-card">${heroHtml}${html}</div>`;
}

        // ============================================================
