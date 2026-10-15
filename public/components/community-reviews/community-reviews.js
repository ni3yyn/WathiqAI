        function renderCommunityReviewsCard(data) {
    if (!data) return '';
    
    const pros = data.pros || [];
    const cons = data.cons || [];
    const quotes = data.rawVerifiedQuotes || [];
    const sources = data.sources || {};
    const satisfactionColor = data.satisfactionRate >= 75 ? '#3f7249' : data.satisfactionRate >= 50 ? '#97641f' : '#a34141';

    let prosHtml = pros.map(p => `<li class="mb-1">${escapeHtml(p)}</li>`).join('');
    let consHtml = cons.map(c => `<li class="mb-1">${escapeHtml(c)}</li>`).join('');
    
    // Renders ALL quotes dynamically (up to 8)
    let quotesHtml = quotes.map(q => `
        <div class="review-quote-box">
            <div class="review-author">
                <span class="acc-chip" style="margin:0;">${escapeHtml(q.skinProfile)}</span>
                <span>${escapeHtml(q.author)}</span>
                <span style="background:black;color:white;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-size:10px;">🎵</span>
            </div>
            <div class="review-text rtl-text" dir="rtl">"${escapeHtml(q.verbatimText)}"</div>
        </div>
    `).join('');

    // Provenance badge text
    const videoCountText = sources.videosScanned ? `${sources.videosScanned} فيديوهات` : 'فيديوهات متعددة';
    const totalCommentsText = sources.totalRawHarvested ? `(من أصل ${sources.totalRawHarvested} تعليق)` : '';

    return `
        <div class="brand-review-card" style="margin-top:0.5rem; background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);">
            <div class="flex items-center justify-between mb-4 pb-3 border-b border-slate-200">
                <div style="flex:1;min-width:0;">
                    <div class="flex items-center gap-2 mb-1">
                        <span style="font-size:10px;font-weight:700;color:#64748b;letter-spacing:0.05em;text-transform:uppercase;">نبض المجتمع (TikTok)</span>
                        <span class="acc-chip safe" style="font-size:10px;padding:1px 6px;">تدقيق ${videoCountText}</span>
                    </div>
                    <div style="font-size:15px;font-weight:800;color:#0f172a;" class="truncate">${escapeHtml(data.productName)}</div>
                </div>
                <div style="text-align:left;flex-shrink:0;">
                    <div style="font-size:10px;font-weight:700;color:#64748b;">نسبة الرضا</div>
                    <div style="font-size:24px;font-weight:800;color:${satisfactionColor};line-height:1;">${data.satisfactionRate}%</div>
                </div>
            </div>
            
            <div style="font-size:13px;color:#334155;line-height:1.6;margin-bottom:1rem;font-weight:500;">
                ${escapeHtml(data.summary)}
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:0.75rem;padding:0.6rem;">
                    <div style="font-size:11px;font-weight:800;color:#047857;margin-bottom:0.4rem;">👍 أبرز الإيجابيات</div>
                    <ul style="font-size:12px;color:#065f46;padding-right:1rem;list-style-type:disc;">${prosHtml}</ul>
                </div>
                <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:0.75rem;padding:0.6rem;">
                    <div style="font-size:11px;font-weight:800;color:#b91c1c;margin-bottom:0.4rem;">⚠️ أبرز التحذيرات</div>
                    <ul style="font-size:12px;color:#991b1b;padding-right:1rem;list-style-type:disc;">${consHtml}</ul>
                </div>
            </div>

            <div>
                <div class="flex items-center justify-between mb-2">
                    <div style="font-size:12px;font-weight:800;color:#475569;">أصوات حقيقية (${quotes.length} تجارب مختارة)</div>
                    <div style="font-size:10.5px;color:#94a3b8;font-weight:600;">${totalCommentsText}</div>
                </div>
                <div style="max-height: 280px; overflow-y: auto; padding-right: 4px;">
                    ${quotesHtml}
                </div>
            </div>
        </div>
    `;
}
