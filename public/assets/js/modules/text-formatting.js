        const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
        const ARABIC_GLOBAL = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
        const LATIN_GLOBAL = /[A-Za-z]/g;

        function containsArabic(text) { return text ? ARABIC_REGEX.test(text) : false; }

        function isRTLText(text) {
            if (!text) return false;
            const arabicCount = (text.match(ARABIC_GLOBAL) || []).length;
            const latinCount = (text.match(LATIN_GLOBAL) || []).length;
            if (arabicCount === 0) return false;
            if (latinCount === 0) return true;
            return (arabicCount / (arabicCount + latinCount)) > 0.15;
        }

        function applyBidiIsolation(html) {
            if (!html) return html;
            // Protect HTML tags AND HTML entities (like &quot;) from being split by the Bidi regex
            return html.replace(/(<[^>]+>)|(&[a-zA-Z0-9#]+;)|([^<&]+)/g, (match, tag, entity, text) => {
                if (tag) return tag;
                if (entity) return entity;
                if (!text) return text;
                const hasArabic = ARABIC_REGEX.test(text);
                if (!hasArabic) return text;
                return text.replace(/([A-Za-z0-9][A-Za-z0-9\s\.\,\-\+\/\:\%\(\)]*[A-Za-z0-9]|[A-Za-z0-9])/g, (run) => {
                    if (!run.trim()) return run;
                    return `<bdi class="ltr-inline">${run}</bdi>`;
                });
            });
        }

        function escapeHtml(str) {
            if (typeof str !== 'string') return str;
            return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }


        // ── SHARED HELPERS (formatPrice, l10n) ────────────────────────────────
        function formatPrice(price, currency) {
            const cur = currency || 'دج';
            if (!price && price !== 0) return 'السعر غير متوفر';
            if (typeof price === 'object') {
                const { min, max } = price;
                if (!min && min !== 0) return 'السعر غير متوفر';
                if (min === max || !max) return `${min} ${cur}`;
                return `${min}–${max} ${cur}`;
            }
            return `${price} ${cur}`;
        }
        function l10n(obj, lang) {
            if (!obj || typeof obj !== 'object') return obj || '';
            const l = lang || document.documentElement.lang || 'ar';
            if (l === 'dz' || l === 'dz-DZ') return obj.dz || obj.ar || obj.en || '';
            return obj[l] || obj.ar || obj.en || '';
        }
        let _wathiqSessionId = null;
        let _wathiqMessageId = null;
        let _rateLimitUntil = 0;
        let _pendingQuickReplies = null;
        let _lastRenderedMsgEl = null;
        const _renderedCards = new Set(); // dedupe: "msgId:cardType"
        function formatInline(text) {
            if (!text) return '';
            let s = text;
            s = s.replace(/\*\*\*([^\*\n]+?)\*\*\*/g, '<strong class="font-bold text-sage-900"><em class="text-mist-500">$1</em></strong>');
            s = s.replace(/\*\*([^\*\n]+?)\*\*/g, '<strong class="font-bold text-sage-900">$1</strong>');
            s = s.replace(/__([^_\n]+?)__/g, '<strong class="font-bold text-sage-900">$1</strong>');
            s = s.replace(/(^|[^\*])\*([^\*\n\s][^\*\n]*?)\*(?!\*)/g, '$1<em class="text-mist-500">$2</em>');
            s = s.replace(/(^|[^_])_([^_\n\s][^_\n]*?)_(?!_)/g, '$1<em class="text-mist-500">$2</em>');
            s = s.replace(/`([^`]+)`/g, '<code class="bg-sage-100 text-sage-700 font-mono px-1.5 py-0.5 rounded-md" dir="ltr" style="font-size:0.85em;">$1</code>');
            return s;
        }

        function parseCustomMarkdown(str) {
            if (!str) return '';
            let safe = escapeHtml(str);
            const codeBlocks = [];
            safe = safe.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
                const ph = `@@@CODE_PH_${codeBlocks.length}@@@`;
                codeBlocks.push(`<pre dir="ltr"><code>${code.trim()}</code></pre>`);
                return ph;
            });
            const tablePlaceholders = [];
            safe = extractMarkdownTables(safe, tablePlaceholders);
            safe = safe.replace(/^### (.*$)/gim, '<h4>$1</h4>');
            safe = safe.replace(/^## (.*$)/gim, '<h3>$1</h3>');
            safe = safe.replace(/^# (.*$)/gim, '<h2>$1</h2>');
            safe = safe.replace(/^\s*[-*•]\s+(.+)$/gim, '<div class="flex items-start gap-2 my-1"><span class="text-sage-600 text-xs mt-0.5">•</span><span>$1</span></div>');
            safe = safe.replace(/^\s*(\d+)\.\s+(.+)$/gim, '<div class="flex items-start gap-2 my-1"><span class="font-bold text-sage-700 text-xs">$1.</span><span>$2</span></div>');
            safe = formatInline(safe);
            safe = safe.replace(/^(?:---|___|\*\*\*)$/gim, '<hr/>');
            safe = safe.replace(/\n\n/g, '<div class="h-2"></div>');
            safe = safe.replace(/\n/g, '<br/>');
            tablePlaceholders.forEach((tblHtml, idx) => { safe = safe.split(`@@@TABLE_PH_${idx}@@@`).join(tblHtml); });
            codeBlocks.forEach((cbHtml, idx) => { safe = safe.split(`@@@CODE_PH_${idx}@@@`).join(cbHtml); });
            return safe;
        }

        function formatMarkdown(str) {
            if (!str) return '';
            // Clean up any raw entity quotes from the LLM
            let cleanStr = str.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'");
            
            let html = '';
            try {
                if (typeof marked !== 'undefined') {
                    const opts = { breaks: true, gfm: true };
                    if (typeof marked.parse === 'function') html = marked.parse(cleanStr, opts);
                    else if (typeof marked === 'function') html = marked(cleanStr, opts);
                }
            } catch (e) { console.warn('marked.parse error:', e); }
            if (!html) html = parseCustomMarkdown(cleanStr);
            
            // Ensure no &quot; remains after markdown parsing
            html = html.replace(/&quot;/g, '"');
            html = applyBidiIsolation(html);
            html = wrapBareTables(html);
            return html;
        }

        function wrapBareTables(html) {
            if (!html || html.indexOf('<table') === -1) return html;
            const temp = document.createElement('div');
            temp.innerHTML = html;

            const tables = temp.querySelectorAll('table');
            tables.forEach(table => {
                const parent = table.parentElement;
                if (parent && parent.classList && parent.classList.contains('table-wrap')) return;
                const wrap = document.createElement('div');
                wrap.className = 'table-wrap';
                parent.insertBefore(wrap, table);
                wrap.appendChild(table);
            });
            return temp.innerHTML;
        }

        function extractMarkdownTables(text, placeholders) {
            const lines = text.split(/\r?\n/);
            const result = [];
            let inTable = false;
            let tableLines = [];
            function isSeparatorRow(line) { return /^\|?(\s*:?-{2,}:?\s*\|?)+$/.test(line.trim()); }
            function isTableRow(line) {
                const t = line.trim();
                if (!t || !t.includes('|')) return false;
                if (isSeparatorRow(t)) return true;
                return (t.startsWith('|') && t.endsWith('|')) || /^[^|\n]+(?:\|[^|\n]+)+$/.test(t);
            }
            function renderTable(tblLines) {
                const hasSep = tblLines.some(isSeparatorRow);
                if (tblLines.length < 2 || !hasSep) return tblLines.map(l => formatInline(l)).join('\n');
                let headerLine = tblLines[0];
                let hasSeparator = isSeparatorRow(tblLines[1]);
                let dataLines = hasSeparator ? tblLines.slice(2) : tblLines.slice(1);
                function splitCells(l) {
                    let t = l.trim();
                    if (t.startsWith('|')) t = t.slice(1);
                    if (t.endsWith('|')) t = t.slice(0, -1);
                    return t.split('|').map(c => c.trim());
                }
                const headers = splitCells(headerLine);
                let out = '<div class="table-wrap"><table>';
                out += '<thead><tr>';
                headers.forEach(h => { out += `<th>${formatInline(h)}</th>`; });
                out += '</tr></thead><tbody>';
                dataLines.forEach(dl => {
                    if (isSeparatorRow(dl)) return;
                    const cells = splitCells(dl);
                    out += '<tr>';
                    cells.forEach((c, idx) => {
                        const cellClass = idx === 0 ? 'font-semibold text-sage-900' : '';
                        out += `<td class="${cellClass}">${formatInline(c)}</td>`;
                    });
                    out += '</tr>';
                });
                out += '</tbody></table></div>';
                return out;
            }
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (isTableRow(line)) { inTable = true; tableLines.push(line); }
                else {
                    if (inTable) {
                        if (tableLines.length >= 2 && tableLines.some(isSeparatorRow)) {
                            const ph = `@@@TABLE_PH_${placeholders.length}@@@`;
                            placeholders.push(renderTable(tableLines));
                            result.push(ph);
                        } else { tableLines.forEach(tl => result.push(tl)); }
                        tableLines = []; inTable = false;
                    }
                    result.push(line);
                }
            }
            if (inTable && tableLines.length > 0) {
                if (tableLines.length >= 2 && tableLines.some(isSeparatorRow)) {
                    const ph = `@@@TABLE_PH_${placeholders.length}@@@`;
                    placeholders.push(renderTable(tableLines));
                    result.push(ph);
                } else { tableLines.forEach(tl => result.push(tl)); }
            }
            return result.join('\n');
        }

