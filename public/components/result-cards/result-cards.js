        // NEW CARD RENDERERS (v3)
        // ═══════════════════════════════════════════════════════════════════

        // ── ingredient_presence ─────────────────────────────────────────────
        function renderIngredientPresenceCard(d) {
            if (!d) return '';
            const lang = document.documentElement.lang || 'ar';
            const rows = (d.checks || []).map(c => {
                const icon = c.present ? '✅' : '❌';
                const label = escapeHtml(c.conceptLabel || c.query);
                const matchInfo = c.present && c.matches && c.matches.length
                    ? `<span style="color:#558f62;font-size:0.78rem;margin-inline-start:6px;">${escapeHtml(c.matches[0].name)} #${c.matches[0].position}</span>` : '';
                const avoidBadge = c.onAvoidList
                    ? `<span style="background:#fee2e2;color:#b91c1c;border-radius:999px;padding:1px 8px;font-size:0.7rem;font-weight:700;margin-inline-start:6px;">على قائمة التجنب</span>` : '';
                return `<div style="display:flex;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.05);">
                    <span style="font-size:1.05rem;">${icon}</span>
                    <span style="font-size:0.88rem;font-weight:600;">${label}</span>
                    ${matchInfo}${avoidBadge}
                </div>`;
            }).join('');
            const avoidHeader = d.anyAvoidHit ? `<div style="background:#fee2e2;border-radius:8px;padding:7px 12px;font-size:0.82rem;color:#b91c1c;font-weight:700;margin-bottom:10px;">⚠️ يحتوي على مكوّن في قائمة تجنّبك</div>` : '';
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="font-size:0.78rem;color:#7c857d;margin-bottom:4px;">فحص المكوّنات</div>
                <div style="font-size:0.97rem;font-weight:800;margin-bottom:10px;">${escapeHtml(d.brand||'')} ${escapeHtml(d.name||'')}</div>
                ${avoidHeader}${rows}
                <div style="font-size:0.72rem;color:#a8b0a9;margin-top:8px;">${d.ingredientCount || 0} مكوّن في القائمة</div>
            </div>`;
        }

        // ── compatibility ───────────────────────────────────────────────────
        function renderCompatibilityCard(d) {
            if (!d) return '';
            const lang = document.documentElement.lang || 'ar';
            const overallColors = { ok: '#22c55e', caution: '#f59e0b', avoid_together: '#ef4444' };
            const overallLabels = { ok: '✅ متوافق', caution: '⚠️ تحفظات', avoid_together: '🚫 لا يُجمع بينهما' };
            const overallColor = overallColors[d.overall] || '#7c857d';
            const conflictRows = (d.conflicts || []).map(c => {
                const sevColor = c.severity === 'avoid_together' ? '#ef4444' : '#f59e0b';
                return `<div style="border-inline-start:3px solid ${sevColor};padding:6px 10px;margin:6px 0;border-radius:0 8px 8px 0;">
                    <div style="font-size:0.82rem;font-weight:700;">${escapeHtml(c.concepts[0])} + ${escapeHtml(c.concepts[1])}</div>
                    <div style="font-size:0.78rem;color:#5b635c;margin-top:2px;">${escapeHtml(l10n(c.advice, lang))}</div>
                </div>`;
            }).join('');
            const amChips = (d.placement?.AM || []).map(x => `<span style="background:#fef9c3;color:#854d0e;border-radius:999px;padding:2px 10px;font-size:0.75rem;font-weight:600;">☀️ ${escapeHtml(x)}</span>`).join(' ');
            const pmChips = (d.placement?.PM || []).map(x => `<span style="background:#e0e7ff;color:#3730a3;border-radius:999px;padding:2px 10px;font-size:0.75rem;font-weight:600;">🌙 ${escapeHtml(x)}</span>`).join(' ');
            const spfRow = d.needsSunscreen ? `<div style="background:#fef3c7;border-radius:8px;padding:7px 12px;font-size:0.82rem;color:#92400e;margin-top:8px;">☀️ لا تنسَ واقي الشمس كل صباح</div>` : '';
            const bufTip = d.bufferingTip ? `<div style="background:#f0fdf4;border-radius:8px;padding:7px 12px;font-size:0.8rem;color:#166534;margin-top:6px;">💡 ${escapeHtml(l10n(d.bufferingTip, lang))}</div>` : '';
            const pregNote = d.pregnancyNote ? `<div style="background:#fdf4ff;border-radius:8px;padding:7px 12px;font-size:0.8rem;color:#7e22ce;margin-top:6px;">🤰 ${escapeHtml(l10n(d.pregnancyNote, lang))}</div>` : '';
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
                    <span style="background:${overallColor}22;color:${overallColor};border-radius:999px;padding:4px 14px;font-size:0.85rem;font-weight:700;">${overallLabels[d.overall] || d.overall}</span>
                </div>
                ${conflictRows}
                ${(d.conflicts||[]).length === 0 ? '<div style="font-size:0.82rem;color:#558f62;">✅ لا تعارضات ملحوظة بين هذه المكوّنات</div>' : ''}
                ${(amChips || pmChips) ? `<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">${amChips}${pmChips}</div>` : ''}
                ${spfRow}${bufTip}${pregNote}
                <div style="font-size:0.68rem;color:#a8b0a9;margin-top:10px;">${escapeHtml(d.disclaimer||'')}</div>
            </div>`;
        }

        // ── usage_schedule ──────────────────────────────────────────────────
        function renderUsageScheduleCard(d) {
            if (!d) return '';
            const lang = document.documentElement.lang || 'ar';
            const dayNames = d.dayNames ? (d.dayNames[lang] || d.dayNames.ar || ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']) : ['الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت','الأحد'];
            const weekRows = (d.weeks || []).map(w => {
                const dayDots = w.exampleDays ? dayNames.map((dn, i) => {
                    const active = w.exampleDays.includes(i);
                    return `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:2px;">
                        <span style="width:8px;height:8px;border-radius:50%;background:${active ? '#558f62' : '#d5dad6'};"></span>
                        <span style="font-size:0.56rem;color:${active ? '#345b3c' : '#a8b0a9'};">${dn.substring(0,2)}</span>
                    </span>`;
                }).join('') : '';
                return `<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);">
                    <span style="background:#e8f1e9;border-radius:8px;padding:2px 8px;font-size:0.75rem;font-weight:700;color:#345b3c;white-space:nowrap;">أسبوع ${escapeHtml(w.weeks)}</span>
                    <div style="flex:1;">
                        <div style="font-size:0.82rem;font-weight:600;">${escapeHtml(l10n(w.frequency, lang))}</div>
                        ${w.note ? `<div style="font-size:0.75rem;color:#7c857d;">${escapeHtml(l10n(w.note, lang))}</div>` : ''}
                        ${dayDots ? `<div style="display:flex;gap:4px;margin-top:6px;">${dayDots}</div>` : ''}
                    </div>
                </div>`;
            }).join('');
            const timeIcon = d.applyTime === 'PM' ? '🌙 مساءً' : '☀️ صباحاً';
            const methodNote = d.method === 'sandwich' ? '<div style="background:#f0fdf4;border-radius:8px;padding:6px 10px;font-size:0.78rem;color:#166534;margin:8px 0;">طريقة السندويش: مرطّب → المكوّن الفعّال → مرطّب</div>' : '';
            const rules = (d.rules || []).map(r => `<div style="font-size:0.78rem;padding:3px 0;">• ${escapeHtml(l10n(r, lang))}</div>`).join('');
            const stopSigns = d.stopSigns ? `<div style="background:#fee2e2;border-radius:8px;padding:7px 12px;font-size:0.8rem;color:#b91c1c;margin-top:8px;">🛑 أوقف الاستخدام إذا: ${escapeHtml(l10n(d.stopSigns, lang))}</div>` : '';
            const pregNote = d.pregnancyNote ? `<div style="background:#fdf4ff;border-radius:8px;padding:7px 12px;font-size:0.8rem;color:#7e22ce;margin-top:6px;">🤰 ${escapeHtml(l10n(d.pregnancyNote, lang))}</div>` : '';
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="font-size:0.78rem;color:#7c857d;margin-bottom:4px;">جدول الاستخدام</div>
                <div style="font-size:0.97rem;font-weight:800;margin-bottom:4px;">${escapeHtml(d.active||'')} · ${timeIcon}</div>
                <div style="font-size:0.78rem;color:#558f62;margin-bottom:10px;">مستوى: ${escapeHtml(d.sensitivity||'')}</div>
                ${methodNote}${weekRows}
                <div style="margin-top:10px;">${rules}</div>
                ${stopSigns}${pregNote}
                <div style="font-size:0.68rem;color:#a8b0a9;margin-top:8px;">${escapeHtml(d.disclaimer||'')}</div>
            </div>`;
        }

        // ── label_scan ──────────────────────────────────────────────────────
        function renderLabelScanCard(d) {
            if (!d) return '';
            if (!d.recognized) {
                return `<div class="surface-card" style="border-radius:14px;padding:12px 16px;margin:8px 0;border:1.5px dashed #d5dad6;">
                    <div style="font-size:0.82rem;color:#7c857d;">📷 تعذّر التعرف على المنتج من الصورة، يرجى إعادة التصوير بوضوح أكبر.</div>
                </div>`;
            }
            return `<div class="surface-card" style="border-radius:14px;padding:12px 16px;margin:8px 0;">
                <div style="font-size:0.72rem;color:#7c857d;margin-bottom:4px;">📷 ما قرأه وثيق من الصورة</div>
                <div style="font-size:0.97rem;font-weight:800;">${escapeHtml(d.brand||'')} — ${escapeHtml(d.name||'')}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
                    ${d.category ? `<span style="background:#e8f1e9;border-radius:999px;padding:2px 10px;font-size:0.75rem;color:#345b3c;">${escapeHtml(d.category)}</span>` : ''}
                    ${d.quantity ? `<span style="background:#f3f5f3;border-radius:999px;padding:2px 10px;font-size:0.75rem;color:#5b635c;">${escapeHtml(d.quantity)}</span>` : ''}
                    <span style="background:#f3f5f3;border-radius:999px;padding:2px 10px;font-size:0.75rem;color:#5b635c;">${d.ingredientCount||0} مكوّن</span>
                </div>
            </div>`;
        }

        // ── reaction_triage ─────────────────────────────────────────────────
        function renderReactionTriageCard(d) {
            if (!d) return '';
            const lang = document.documentElement.lang || 'ar';
            const urgencyColors = { urgent: '#ef4444', doctor_soon: '#f59e0b', self_care: '#558f62' };
            const urgencyBg = { urgent: '#fee2e2', doctor_soon: '#fef3c7', self_care: '#f0fdf4' };
            const urgencyLabels = { urgent: '🚨 حالة طارئة — اذهب للطبيب فوراً', doctor_soon: '⚠️ يُنصح بمراجعة الطبيب قريباً', self_care: 'ℹ️ رعاية ذاتية' };
            const uc = urgencyColors[d.urgency] || '#7c857d';
            const ubg = urgencyBg[d.urgency] || '#f3f5f3';
            const banner = `<div style="background:${ubg};border-inline-start:4px solid ${uc};border-radius:8px;padding:10px 14px;margin-bottom:12px;">
                <div style="font-size:0.95rem;font-weight:800;color:${uc};">${urgencyLabels[d.urgency]||d.urgency}</div>
                ${(d.redFlags||[]).slice(0,3).map(f => `<div style="font-size:0.82rem;color:${uc};margin-top:3px;">• ${escapeHtml(l10n(f,lang))}</div>`).join('')}
            </div>`;
            const steps = (d.steps||[]).map((s,i) => `<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;">
                <span style="background:#e8f1e9;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:700;flex-shrink:0;">${i+1}</span>
                <span style="font-size:0.82rem;">${escapeHtml(l10n(s,lang))}</span>
            </div>`).join('');
            const culprits = (d.culprits||[]).map(c => `<div style="background:#fff7ed;border-radius:8px;padding:6px 10px;margin:4px 0;">
                <div style="font-size:0.82rem;font-weight:700;">🔍 ${escapeHtml(c.label)}</div>
                ${(c.reasons||[]).map(r => `<div style="font-size:0.76rem;color:#7c857d;">- ${escapeHtml(l10n(r,lang))}</div>`).join('')}
            </div>`).join('');
            const backOff = d.backOff ? `<div style="background:#f0fdf4;border-radius:8px;padding:7px 12px;font-size:0.82rem;color:#166534;margin-top:8px;">🔄 ${escapeHtml(l10n(d.backOff,lang))}</div>` : '';
            const docNote = d.whenToSeeDoctor ? `<div style="background:#fff7ed;border-radius:8px;padding:7px 12px;font-size:0.8rem;color:#92400e;margin-top:6px;">🏥 ${escapeHtml(l10n(d.whenToSeeDoctor,lang))}</div>` : '';
            const pregNote = d.pregnancyNote ? `<div style="background:#fdf4ff;border-radius:8px;padding:7px 12px;font-size:0.8rem;color:#7e22ce;margin-top:6px;">🤰 ${escapeHtml(l10n(d.pregnancyNote,lang))}</div>` : '';
            const moreInfo = d.needsMoreInfo ? `<div style="background:#eff6ff;border-radius:8px;padding:7px 12px;font-size:0.82rem;color:#1d4ed8;margin-top:8px;cursor:pointer;" onclick="document.getElementById('messageInput').focus()">💬 أخبرني ماذا بدأت مؤخراً من منتجات جديدة</div>` : '';
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                ${banner}
                ${culprits}
                ${steps ? `<div style="margin-top:10px;">${steps}</div>` : ''}
                ${backOff}${docNote}${pregNote}${moreInfo}
                <div style="font-size:0.68rem;color:#a8b0a9;margin-top:10px;">${escapeHtml(d.disclaimer||'إرشادات عامة وليست تشخيصاً طبياً')}</div>
            </div>`;
        }

        // ── routine_diff ────────────────────────────────────────────────────
        function renderRoutineDiffCard(d) {
            if (!d) return '';
            const delta = d.totalDelta || 0;
            const deltaColor = delta < 0 ? '#22c55e' : delta > 0 ? '#ef4444' : '#7c857d';
            const deltaText = delta === 0 ? 'نفس التكلفة' : (delta < 0 ? `${Math.abs(delta)} دج أقل 🎉` : `${delta} دج أكثر`);
            const rows = [
                ...(d.swapped||[]).map(x => `<div style="padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:0.82rem;">🔄 <strong>${escapeHtml(x.step)}</strong>: ${escapeHtml(x.from)} → ${escapeHtml(x.to)}</div>`),
                ...(d.added||[]).map(x => `<div style="padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:0.82rem;color:#166534;">➕ ${escapeHtml(x.step)}: ${escapeHtml(x.product)}</div>`),
                ...(d.removed||[]).map(x => `<div style="padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:0.82rem;color:#b91c1c;">➖ ${escapeHtml(x.step)}: ${escapeHtml(x.product)}</div>`),
            ].join('');
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="font-size:0.78rem;color:#7c857d;margin-bottom:6px;">تغييرات الروتين</div>
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
                    <span style="font-size:0.85rem;">الإجمالي: <del style="color:#a8b0a9;">${d.totalFrom||0} دج</del> → <strong>${d.totalTo||0} دج</strong></span>
                    <span style="background:${deltaColor}22;color:${deltaColor};border-radius:999px;padding:2px 10px;font-size:0.78rem;font-weight:700;">${deltaText}</span>
                </div>
                ${rows}
                ${d.unchanged ? `<div style="font-size:0.75rem;color:#a8b0a9;margin-top:6px;">${d.unchanged} خطوة بقيت كما هي</div>` : ''}
            </div>`;
        }

        // ── share (routine share preview) ───────────────────────────────────
        function renderShareCard(d) {
            if (!d) return '';
            const total = d.total || {};
            const stepsHtml = (d.steps||[]).map(s => {
                const prod = s.product || {};
                const priceStr = prod.priceKnown === false ? 'السعر غير متوفر' : formatPrice(prod.price, prod.currency);
                return `<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.05);">
                    <span style="background:#e8f1e9;border-radius:8px;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:700;flex-shrink:0;">${s.number}</span>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:0.82rem;font-weight:700;">${escapeHtml(s.name||'')}</div>
                        <div style="font-size:0.75rem;color:#7c857d;">${escapeHtml(prod.brand||'')} ${escapeHtml(prod.name||'')} · ${priceStr}</div>
                    </div>
                </div>`;
            }).join('');
            const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(d.whatsappText||'')}`;
            const canNativeShare = !!navigator.share;
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="font-size:0.78rem;color:#7c857d;margin-bottom:4px;">🎁 معاينة الروتين للمشاركة</div>
                <div style="font-size:0.97rem;font-weight:800;margin-bottom:2px;">${escapeHtml(d.title||'')}</div>
                <div style="font-size:0.8rem;color:#7c857d;margin-bottom:10px;">${escapeHtml(d.subtitle||'')}</div>
                ${stepsHtml}
                <div style="font-size:0.88rem;font-weight:700;margin-top:10px;">الإجمالي: ${formatPrice(total.value, total.currency)}</div>
                <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
                    <a href="${whatsappUrl}" target="_blank" style="background:#25d366;color:#fff;border-radius:8px;padding:6px 14px;font-size:0.82rem;font-weight:700;text-decoration:none;">واتساب</a>
                    ${canNativeShare ? `<button onclick="navigator.share({text:${JSON.stringify(d.whatsappText||'')}})" style="background:#e8f1e9;color:#345b3c;border-radius:8px;padding:6px 14px;font-size:0.82rem;font-weight:700;cursor:pointer;">مشاركة...</button>` : ''}
                    <button onclick="navigator.clipboard.writeText(${JSON.stringify(d.whatsappText||'')}).then(()=>this.textContent='✅ تم النسخ')" style="background:#f3f5f3;color:#5b635c;border-radius:8px;padding:6px 14px;font-size:0.82rem;font-weight:700;cursor:pointer;">نسخ النص</button>
                </div>
                ${(d.disclaimers||[]).map(x => `<div style="font-size:0.68rem;color:#a8b0a9;margin-top:4px;">${escapeHtml(x)}</div>`).join('')}
            </div>`;
        }

        // ── shopping_list ───────────────────────────────────────────────────
        let _shoppingListChecked = JSON.parse(localStorage.getItem('wq_shopping') || '{}');
        function saveShoppingChecked() { try { localStorage.setItem('wq_shopping', JSON.stringify(_shoppingListChecked)); } catch(e){} }
        function renderShoppingListCard(d, sessionId) {
            if (!d) return '';
            const key = sessionId || 'default';
            const items = (d.items||[]).map(item => {
                const ck = _shoppingListChecked[key+':'+item.id] ?? item.checked;
                const priceStr = item.priceKnown === false ? 'السعر غير متوفر' : formatPrice(item.price, item.price?.currency);
                const owned = item.owned;
                return `<label style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.05);cursor:pointer;${owned||ck?'opacity:0.55;':''}" 
                    onclick="event.preventDefault();_shoppingListChecked['${key+':'+escapeHtml(item.id)}']=!_shoppingListChecked['${key+':'+escapeHtml(item.id)}'];saveShoppingChecked();this.style.opacity=_shoppingListChecked['${key+':'+escapeHtml(item.id)}']?'0.55':'1';this.querySelector('input').checked=_shoppingListChecked['${key+':'+escapeHtml(item.id)}'];">
                    <input type="checkbox" ${ck||owned?'checked':''} style="accent-color:#558f62;width:16px;height:16px;" onclick="event.stopPropagation()">
                    <div style="flex:1;${(ck||owned)?'text-decoration:line-through;':''}" >
                        <div style="font-size:0.85rem;font-weight:700;">${escapeHtml(item.brand||'')} ${escapeHtml(item.name||'')}</div>
                        <div style="font-size:0.75rem;color:#7c857d;">${priceStr}${owned?' · عندك بالفعل':''}</div>
                    </div>
                </label>`;
            }).join('');
            const total = d.total || {};
            const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(d.whatsappText||'')}`;
            const budgetWarn = d.overBudget ? `<div style="background:#fee2e2;border-radius:8px;padding:6px 10px;font-size:0.8rem;color:#b91c1c;margin-top:8px;">⚠️ يتجاوز الميزانية (${d.budget||0} دج)</div>` : '';
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="font-size:0.78rem;color:#7c857d;margin-bottom:6px;">🛒 قائمة التسوق</div>
                ${items}
                ${budgetWarn}
                <div style="font-size:0.88rem;font-weight:700;margin-top:10px;">الإجمالي: ${formatPrice({min:total.min,max:total.max}, total.currency)}${total.unpriced>0?` <span style="color:#a8b0a9;font-size:0.75rem;">+ ${total.unpriced} بلا سعر</span>`:''}</div>
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
                    <a href="${whatsappUrl}" target="_blank" style="background:#25d366;color:#fff;border-radius:8px;padding:5px 12px;font-size:0.8rem;font-weight:700;text-decoration:none;">واتساب 📤</a>
                    ${navigator.share?`<button onclick="navigator.share({text:${JSON.stringify(d.whatsappText||'')}});" style="background:#e8f1e9;color:#345b3c;border-radius:8px;padding:5px 12px;font-size:0.8rem;font-weight:700;cursor:pointer;">مشاركة...</button>`:''}
                    <button onclick="navigator.clipboard.writeText(${JSON.stringify(d.whatsappText||'')}).then(()=>this.textContent='✅')" style="background:#f3f5f3;color:#5b635c;border-radius:8px;padding:5px 12px;font-size:0.8rem;font-weight:700;cursor:pointer;">نسخ</button>
                </div>
            </div>`;
        }

        // ── pick_explanation ────────────────────────────────────────────────
        function renderPickExplanationCard(d) {
            if (!d) return '';
            const lang = document.documentElement.lang || 'ar';
            const conf = d.confidence || {};
            const confColors = { high:'#22c55e', medium:'#f59e0b', low:'#ef4444' };
            const confLabels = { high:'ثقة عالية', medium:'ثقة متوسطة', low:'ثقة محدودة' };
            const cc = confColors[conf.level] || '#7c857d';
            const flags = conf.flags || {};
            const missingFlags = Object.entries(flags).filter(([,v]) => !v).map(([k]) => k);
            const reasons = (d.reasons||[]).map(r => `<div style="font-size:0.82rem;padding:3px 0;">✅ ${escapeHtml(l10n(r,lang))}</div>`).join('');
            const caveats = (d.caveats||[]).map(c => `<div style="font-size:0.8rem;color:#7c857d;padding:3px 0;">⚠️ ${escapeHtml(l10n(c,lang))}</div>`).join('');
            const missList = missingFlags.map(f => `<span style="background:#fee2e2;border-radius:999px;padding:1px 8px;font-size:0.7rem;color:#b91c1c;">${escapeHtml(f)}</span>`).join(' ');
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="font-size:0.78rem;color:#7c857d;margin-bottom:4px;">لماذا هذا المنتج؟</div>
                <div style="font-size:0.95rem;font-weight:800;margin-bottom:10px;">${escapeHtml(d.product?.name||'')}</div>
                ${reasons}
                ${caveats ? `<div style="margin-top:8px;background:#f3f5f3;border-radius:8px;padding:8px 10px;">${caveats}</div>` : ''}
                <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;">
                    <span style="background:${cc}22;color:${cc};border-radius:999px;padding:3px 12px;font-size:0.78rem;font-weight:700;cursor:pointer;" 
                        onclick="this.nextElementSibling.classList.toggle('hidden')">${confLabels[conf.level]||conf.level} ▾</span>
                    <div class="hidden" style="display:flex;flex-wrap:wrap;gap:4px;">${missList||'<span style="font-size:0.72rem;color:#558f62;">جميع البيانات متوفرة</span>'}</div>
                </div>
            </div>`;
        }

        // ── cabinet ─────────────────────────────────────────────────────────
        function renderCabinetCard(d) {
            if (!d) return '';
            // Tool cards wrap the actual cabinet payload as { cabinet: { items, summary } }.
            // Streamed cards are flattened one level before reaching this renderer.
            const cabinet = d.cabinet || d.data?.cabinet || d.data || d;
            const { items = [], summary = {}, highlight } = cabinet;
            const statusLabels = { using:'يستخدم الآن', finished:'انتهى', wishlist:'قائمة الرغبات', stopped:'توقف' };
            const verdictEmoji = { loved:'😍', ok:'🙂', didnt_suit:'👎' };
            const groups = {};
            for (const item of items) { (groups[item.status] = groups[item.status]||[]).push(item); }
            const gapsHtml = (summary.gaps||[]).map(g => `<span style="background:#fee2e2;color:#b91c1c;border-radius:999px;padding:2px 10px;font-size:0.75rem;font-weight:600;">يُنصح: ${g}</span>`).join(' ');
            const dislikeNote = (summary.dislikes?.commonConcepts||[]).length
                ? `<div style="font-size:0.78rem;color:#92400e;background:#fff7ed;border-radius:8px;padding:6px 10px;margin-top:6px;">المنتجات التي لم تناسبك تشترك في: ${escapeHtml((summary.dislikes.commonConcepts||[]).join(', '))}</div>` : '';
            let sectionsHtml = Object.entries(statusLabels).map(([status, label]) => {
                const grp = groups[status] || [];
                if (!grp.length) return '';
                const rowsHtml = grp.map(item => {
                    const priceStr = item.price ? formatPrice(item.price, item.price.currency) : 'السعر غير متوفر';
                    const hl = highlight && highlight.id === item.id;
                    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.05);${hl?'animation:pulseSoft 1.5s 3;':''}" >
                        ${item.image ? `<img src="${escapeHtml(item.image)}" style="width:38px;height:38px;border-radius:8px;object-fit:cover;flex-shrink:0;" loading="lazy">` : `<div style="width:38px;height:38px;border-radius:8px;background:#e8f1e9;flex-shrink:0;"></div>`}
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:0.85rem;font-weight:700;">${escapeHtml(item.brand||'')} ${escapeHtml(item.name||'')}</div>
                            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px;">
                                ${(item.actives||[]).slice(0,3).map(a=>`<span style="background:#e8f1e9;border-radius:999px;padding:1px 8px;font-size:0.68rem;color:#345b3c;">${escapeHtml(a)}</span>`).join('')}
                            </div>
                            <div style="font-size:0.75rem;color:#7c857d;">${priceStr} ${item.verdict?verdictEmoji[item.verdict]||'':''}</div>
                        </div>
                    </div>`;
                }).join('');
                return `<div style="margin-bottom:12px;"><div style="font-size:0.75rem;font-weight:700;color:#7c857d;margin-bottom:4px;">${label} (${grp.length})</div>${rowsHtml}</div>`;
            }).join('');
            return `<div class="surface-card" style="border-radius:14px;padding:14px 16px;margin:8px 0;">
                <div style="font-size:0.78rem;color:#7c857d;margin-bottom:4px;">🧴 خزانة منتجاتي</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                    <span style="font-size:0.82rem;font-weight:700;">${summary.total||0} منتج</span>
                    ${gapsHtml}
                </div>
                ${dislikeNote}
                ${sectionsHtml || '<div style="font-size:0.82rem;color:#a8b0a9;">الخزانة فارغة</div>'}
            </div>`;
        }

        // ── gift_set ────────────────────────────────────────────────────────
        function renderGiftSetCard(payload) {
            if (!payload) return '';
            // Both the eager SSE card and final sections wrap the gift under `gift`.
            const gift = payload.gift || payload.data?.gift || payload.data || payload;
            const routine = gift.routine || gift;
            if (!Array.isArray(routine.steps) || routine.steps.length === 0) return '';

            const recipient = typeof gift.recipient === 'string' && gift.recipient.trim()
                ? `هدية لـ ${gift.recipient.trim()}` : 'مجموعة هدية';
            const cost = Number(routine.totalCost);
            const budget = Number(routine.maxBudget);
            const budgetLine = Number.isFinite(cost) && Number.isFinite(budget) && budget > 0
                ? `<span class="shelf-chip">الإجمالي ${cost} دج من ${budget} دج</span>`
                : `<span class="shelf-chip">${routine.steps.length} منتجات مختارة</span>`;
            const notes = (Array.isArray(gift.giftNotes) ? gift.giftNotes : [])
                .filter(note => typeof note === 'string' && note.trim())
                .map(note => `<p class="gift-set-note">${escapeHtml(note)}</p>`).join('');
            const title = typeof gift.title === 'string' && gift.title.trim() ? gift.title : 'اختيار لطيف ومدروس';

            return `<section class="surface-card" aria-label="مجموعة هدية" style="border-radius:16px;padding:12px;margin:8px 0;">
                <div class="gift-set-banner">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span aria-hidden="true" style="width:42px;height:42px;display:grid;place-items:center;flex:none;border-radius:14px;background:rgba(255,255,255,.8);font-size:1.4rem;">🎁</span>
                        <div style="min-width:0;flex:1;">
                            <div style="font-size:.72rem;font-weight:700;color:#8b5a8e;">${escapeHtml(recipient)}</div>
                            <h3 style="margin:2px 0 0;font-size:1rem;font-weight:800;color:#253d2c;">${escapeHtml(title)}</h3>
                        </div>
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:9px;">${budgetLine}<span class="shelf-chip">لطيف للاستخدام اليومي</span></div>
                    ${notes ? `<div style="display:grid;gap:5px;margin-top:9px;">${notes}</div>` : ''}
                </div>
                ${renderRoutineCard(routine)}
            </section>`;
        }

        function unwrapCardPayload(section, key) {
            return section?.[key] ?? section?.data?.[key] ?? section?.data ?? section;
        }

        function renderSections(sections, legacyData, msgId) {
            const dispatchOne = (s) => {
                // dedupe: never render the same cardType twice per assistant message
                if (msgId && s.type) {
                    const dKey = msgId + ':' + s.type;
                    if (_renderedCards.has(dKey)) return '';
                    _renderedCards.add(dKey);
                }
                // ── existing card types (preserved exactly) ────────────────
                if (s.type === 'product_results' && s.products?.length > 0) return renderProductsGrid(s.products, 'results');
                if (s.type === 'product' && s.product) return renderProductsGrid([s.product], 'single');
                if (s.type === 'product_analysis' && s.analysis) return renderAnalysisCard(s.analysis, s.productName, s.brand, s.image);
                if (s.type === 'routine' && s.routine) return renderRoutineCard(s.routine);
                if (s.type === 'brand_evaluation' && s.brandEvaluation) return renderBrandReviewCard(s.brandEvaluation);
                if (s.type === 'community_reviews') return renderCommunityReviewsCard(s);
                if (s.type === 'comparison') return renderComparisonCard(s.comparison || s.data || s);
                if (s.type === 'ingredient_check') return renderIngredientCheckCard(s.ingredientCheck || s.data || s);
                if (s.type === 'brand_reviews') return renderBrandReviewsCard(s.brandReviews || s.data || s);
                if ((s.type === 'brand_review' || s.type === 'brand_analysis') || s.brandReview) {
                    return renderBrandReviewCard(s.brandReview || s.review || s.data || s);
                }
                // ── v3 new card types ──────────────────────────────────────
                if (s.type === 'ingredient_presence') return renderIngredientPresenceCard(s.data || s);
                if (s.type === 'compatibility') return renderCompatibilityCard(s.data || s);
                if (s.type === 'usage_schedule') return renderUsageScheduleCard(s.data || s);
                if (s.type === 'label_scan') return renderLabelScanCard(s.data || s);
                if (s.type === 'cabinet') return renderCabinetCard(s.data || s);
                if (s.type === 'reaction_triage') return renderReactionTriageCard(unwrapCardPayload(s, 'triage'));
                if (s.type === 'routine_diff') return renderRoutineDiffCard(unwrapCardPayload(s, 'diff'));
                if (s.type === 'share') return renderShareCard(unwrapCardPayload(s, 'share'));
                if (s.type === 'shopping_list') return renderShoppingListCard(unwrapCardPayload(s, 'shoppingList'), _wathiqSessionId);
                if (s.type === 'gift_set') return renderGiftSetCard(s.data || s);
                if (s.type === 'pick_explanation') return renderPickExplanationCard(unwrapCardPayload(s, 'explanation'));
                return '';
            };
            if (Array.isArray(sections) && sections.length > 0) {
                return sections.map(dispatchOne).join('');
            }
            const d = legacyData || {};
            if (d.type) return dispatchOne(d);
            return '';
        }
        // ============================================================
