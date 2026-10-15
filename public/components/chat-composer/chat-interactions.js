        function renderQuickReplies(suggestions) {
            if (!Array.isArray(suggestions) || !suggestions.length) return null;
            const wrap = document.createElement('div');
            wrap.className = 'flex flex-wrap gap-2 mt-2 pb-1';
            suggestions.forEach((suggestion) => {
                const label = typeof suggestion === 'string' ? suggestion : suggestion?.label || suggestion?.text;
                const value = typeof suggestion === 'string' ? suggestion : suggestion?.value || suggestion?.text || label;
                if (typeof label !== 'string' || typeof value !== 'string' || !label.trim() || !value.trim()) return;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'qr-chip';
                button.style.cssText = 'background:rgba(255,255,255,0.85);border:1.5px solid #d1e3d3;border-radius:999px;padding:5px 14px;font-size:0.82rem;font-weight:600;color:#345b3c;cursor:pointer;white-space:nowrap;transition:all 0.15s;';
                button.textContent = label;
                button.addEventListener('click', () => injectQuickReply(value, button));
                wrap.appendChild(button);
            });
            return wrap.childElementCount ? wrap : null;
        }
        function injectQuickReply(text, sourceButton) {
            if (isAnimating) return;
            const input = document.getElementById('messageInput');
            const form = document.getElementById('chatForm');
            if (!input || !form) return;
            input.value = text;
            autoResize(input);
            checkClearButtonVisibility();
            input.focus();
            if (sourceButton) sourceButton.disabled = true;
            form.requestSubmit();
            if (sourceButton) window.setTimeout(() => { sourceButton.disabled = false; }, 0);
        }
        function displayQuickReplies(container, suggestions) {
            if (!container) return;
            const replies = renderQuickReplies(suggestions);
            container.replaceChildren();
            if (replies) container.appendChild(replies);
        }

        // ── Feedback thumbs helper ────────────────────────────────────────
        function renderFeedbackRow(messageId) {
            const mid = escapeHtml(messageId);
            return `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;" data-msg-id="${mid}">
                <span style="font-size:0.72rem;color:#a8b0a9;">هل كانت الإجابة مفيدة؟</span>
                <button title="نعم" onclick="sendFeedback('${mid}','up',this)" style="background:transparent;padding:4px 8px;border-radius:6px;font-size:1rem;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='transparent'">👍</button>
                <button title="لا" onclick="sendFeedback('${mid}','down',this)" style="background:transparent;padding:4px 8px;border-radius:6px;font-size:1rem;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='#fee2e2'" onmouseout="this.style.background='transparent'">👎</button>
            </div>`;
        }
        async function sendFeedback(messageId, vote, btn) {
            // Optimistic UI: disable both buttons
            const row = btn.closest('[data-msg-id]');
            if (row) row.querySelectorAll('button').forEach(b => b.disabled = true);
            const icon = vote === 'up' ? '👍' : '👎';
            btn.style.background = vote === 'up' ? '#dcfce7' : '#fee2e2';
            try {
                await window.apiFetch('/api/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messageId, vote, sessionId: _wathiqSessionId })
                });
            } catch(e) { /* fire and forget */ }
        }

        // ── Photo / image attach ──────────────────────────────────────────
        async function handlePhotoAttach(file) {
            if (!file) return;
            // Compress: max 1600px, max 1.5MB output quality
            const MAX_SIDE = 1600;
            const bmp = await createImageBitmap(file);
            let { width, height } = bmp;
            if (width > MAX_SIDE || height > MAX_SIDE) {
                const ratio = Math.min(MAX_SIDE / width, MAX_SIDE / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
            const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
            const base64 = await new Promise((res, rej) => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result.split(',')[1]);
                fr.onerror = rej;
                fr.readAsDataURL(blob);
            });
            // Show preview in input area
            showPhotoPreview(URL.createObjectURL(blob));
            _pendingPhoto = { base64, mimeType: 'image/jpeg', width, height };
        }
        let _pendingPhoto = null;
        function showPhotoPreview(url) {
            const bar = document.getElementById('photoPreviewBar');
            if (!bar) return;
            bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;background:#f0fdf4;border-radius:8px;margin-bottom:6px;';
            bar.innerHTML = `<img src="${url}" style="width:44px;height:44px;border-radius:6px;object-fit:cover;">
                <span style="font-size:0.8rem;color:#345b3c;flex:1;">صورة مرفقة</span>
                <button onclick="clearPhotoPreview()" style="background:transparent;cursor:pointer;font-size:1rem;color:#5b635c;">✕</button>`;
        }
        function clearPhotoPreview() {
            _pendingPhoto = null;
            const bar = document.getElementById('photoPreviewBar');
            if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
        }

