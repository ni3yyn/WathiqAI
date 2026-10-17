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

        // ── Photo / image attach (v6.3.1: discoverable button + robust decoder) ──
        let _pendingPhotos = [];

        const SUPPORTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
        const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

        function isSupportedImageFile(file) {
            if (!file) return false;
            const mime = String(file.type || '').toLowerCase();
            const ext = String(file.name || '').split('.').pop().toLowerCase();
            return SUPPORTED_IMAGE_MIMES.has(mime) || ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
        }

        async function decodeImageFile(file) {
            if (typeof createImageBitmap === 'function') {
                try {
                    const bitmap = await createImageBitmap(file);
                    return {
                        image: bitmap,
                        width: bitmap.width,
                        height: bitmap.height,
                        cleanup: () => bitmap.close?.(),
                    };
                } catch (error) {
                    // Safari/older browser codecs may reject an otherwise viewable image.
                    console.debug('[IMAGE ATTACH] createImageBitmap failed; using Image fallback.', error);
                }
            }

            const objectUrl = URL.createObjectURL(file);
            try {
                const image = await new Promise((resolve, reject) => {
                    const element = new Image();
                    element.onload = () => resolve(element);
                    element.onerror = () => reject(new Error('image_decode_failed'));
                    element.src = objectUrl;
                });
                return {
                    image,
                    width: image.naturalWidth || image.width,
                    height: image.naturalHeight || image.height,
                    cleanup: () => URL.revokeObjectURL(objectUrl),
                };
            } catch (error) {
                URL.revokeObjectURL(objectUrl);
                throw error;
            }
        }

        function filesToArray(files) {
            if (!files) return [];
            if (typeof FileList !== 'undefined' && files instanceof FileList) return Array.from(files);
            if (Array.isArray(files)) return files;
            return [files];
        }

        async function handlePhotoAttach(files) {
            const allSelected = filesToArray(files).filter(Boolean);
            if (!allSelected.length) return;

            const unsupported = allSelected.filter(file => !isSupportedImageFile(file));
            const oversized = allSelected.filter(file => Number(file.size || 0) > MAX_SOURCE_IMAGE_BYTES);
            const selected = allSelected.filter(file => isSupportedImageFile(file) && Number(file.size || 0) <= MAX_SOURCE_IMAGE_BYTES);

            if (unsupported.length || oversized.length) {
                const reason = oversized.length
                    ? 'حجم الصورة كبير جدًا (الحد 20 ميغابايت). اختر صورة أصغر.'
                    : 'الصيغ المدعومة هي JPG وPNG وWebP فقط.';
                showPhotoUploadMessage(reason);
            }
            if (!selected.length) {
                if (!unsupported.length && !oversized.length) showPhotoUploadMessage('اختر صورة بصيغة JPG أو PNG أو WebP.');
                return;
            }

            const remaining = Math.max(0, 2 - _pendingPhotos.length);
            if (!remaining) {
                showPhotoUploadMessage('يمكن إرفاق صورتين فقط: واجهة المنتج وقائمة المكونات. احذف صورة لاستبدالها.');
                return;
            }
            if (selected.length > remaining) {
                showPhotoUploadMessage('يمكن إرفاق صورتين فقط؛ تمت معالجة أول صورتين متاحتين.');
            }

            const additions = [];
            const usedRoles = new Set(_pendingPhotos.map(photo => photo.role));
            for (const file of selected.slice(0, remaining)) {
                let decoded;
                try {
                    decoded = await decodeImageFile(file);
                    let { width, height } = decoded;
                    if (!width || !height) throw new Error('image_dimensions_unavailable');

                    const MAX_SIDE = 1600;
                    if (width > MAX_SIDE || height > MAX_SIDE) {
                        const ratio = Math.min(MAX_SIDE / width, MAX_SIDE / height);
                        width = Math.max(1, Math.round(width * ratio));
                        height = Math.max(1, Math.round(height * ratio));
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('canvas_unavailable');
                    context.drawImage(decoded.image, 0, 0, width, height);
                    const blob = await new Promise((resolve, reject) => canvas.toBlob(
                        result => result ? resolve(result) : reject(new Error('image_compression_failed')),
                        'image/jpeg', 0.82
                    ));
                    const base64 = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const dataUrl = String(reader.result || '');
                            const comma = dataUrl.indexOf(',');
                            if (comma < 0) return reject(new Error('image_read_failed'));
                            resolve(dataUrl.slice(comma + 1));
                        };
                        reader.onerror = () => reject(new Error('image_read_failed'));
                        reader.readAsDataURL(blob);
                    });

                    let role;
                    if (window.__WATHIQ_NEXT_PHOTO_ROLE && !usedRoles.has(window.__WATHIQ_NEXT_PHOTO_ROLE)) {
                        role = window.__WATHIQ_NEXT_PHOTO_ROLE;
                        delete window.__WATHIQ_NEXT_PHOTO_ROLE;
                    } else {
                        role = !usedRoles.has('front') ? 'front' : 'inci';
                    }
                    usedRoles.add(role);
                    additions.push({
                        base64,
                        mimeType: 'image/jpeg',
                        width,
                        height,
                        role,
                        fileName: String(file.name || (role === 'inci' ? 'ingredient-label.jpg' : 'product-front.jpg')),
                        previewUrl: URL.createObjectURL(blob),
                    });
                } catch (error) {
                    console.warn('[IMAGE ATTACH] Could not prepare image:', error);
                    showPhotoUploadMessage('تعذّر تجهيز الصورة. جرّب صورة JPG أو PNG أو WebP أوضح وأصغر.');
                } finally {
                    decoded?.cleanup?.();
                }
            }

            if (additions.length) {
                _pendingPhotos = _pendingPhotos.concat(additions).slice(0, 2);
                renderPhotoPreview();
                const photoButton = document.getElementById('photoBtn');
                if (photoButton) {
                    photoButton.classList.add('has-photos');
                    photoButton.setAttribute('aria-label', `تم إرفاق ${_pendingPhotos.length} صورة. إضافة أو استبدال الصور`);
                }
            }
        }

        function showPhotoUploadMessage(message) {
            const bar = document.getElementById('photoPreviewBar');
            if (!bar) return;
            if (_pendingPhotos.length) {
                // Keep the existing previews visible if a third photo or an invalid
                // file is selected; never hide attachments that will still be sent.
                bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 12px;background:#f0fdf4;border:1px solid #fed7d7;border-radius:10px;margin-bottom:6px;';
            } else {
                bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;margin-bottom:6px;color:#9a3412;font-size:0.8rem;';
            }
            let note = bar.querySelector('[data-photo-warning]');
            if (!note) {
                note = document.createElement('span');
                note.dataset.photoWarning = 'true';
                note.style.cssText = 'font-size:0.8rem;color:#9a3412;flex-basis:100%;';
                bar.prepend(note);
            }
            note.textContent = message;
        }

        function renderPhotoPreview() {
            const bar = document.getElementById('photoPreviewBar');
            if (!bar) return;
            if (!_pendingPhotos.length) {
                bar.style.display = 'none';
                bar.replaceChildren();
                const photoButton = document.getElementById('photoBtn');
                if (photoButton) {
                    photoButton.classList.remove('has-photos');
                    photoButton.setAttribute('aria-label', 'إرفاق صورة');
                }
                return;
            }

            bar.className = 'photo-preview-bar';
            bar.style.display = 'flex';
            bar.replaceChildren();

            const heading = document.createElement('div');
            heading.className = 'photo-preview-heading';
            heading.textContent = `الصور المرفقة (${_pendingPhotos.length}/2)`;
            heading.style.cssText = 'flex-basis:100%;font-size:.78rem;font-weight:750;color:#345b3c;';
            bar.appendChild(heading);

            _pendingPhotos.forEach((photo, index) => {
                const item = document.createElement('div');
                item.className = 'photo-preview-item';
                const img = document.createElement('img');
                img.src = photo.previewUrl || (photo.base64 ? `data:${photo.mimeType || 'image/jpeg'};base64,${photo.base64}` : '');
                img.alt = photo.role === 'inci' ? 'معاينة صورة قائمة المكونات' : 'معاينة صورة واجهة المنتج';

                const meta = document.createElement('div');
                meta.className = 'photo-preview-meta';
                const fileName = document.createElement('span');
                fileName.className = 'photo-preview-name';
                fileName.title = String(photo.fileName || 'صورة مرفقة');
                fileName.textContent = String(photo.fileName || (photo.role === 'inci' ? 'قائمة المكونات' : 'واجهة المنتج'));

                const roleControl = document.createElement('select');
                roleControl.className = 'photo-preview-role';
                roleControl.setAttribute('aria-label', `نوع الصورة ${index + 1}`);
                roleControl.add(new Option('واجهة / اسم المنتج', 'front'));
                roleControl.add(new Option('قائمة المكونات (INCI)', 'inci'));
                roleControl.value = photo.role || (index === 0 ? 'front' : 'inci');
                roleControl.addEventListener('change', () => {
                    const oldRole = _pendingPhotos[index]?.role || (index === 0 ? 'front' : 'inci');
                    const newRole = roleControl.value;
                    const otherIndex = _pendingPhotos.findIndex((candidate, i) => i !== index && candidate.role === newRole);
                    _pendingPhotos[index] = { ..._pendingPhotos[index], role: newRole };
                    if (otherIndex >= 0) _pendingPhotos[otherIndex] = { ..._pendingPhotos[otherIndex], role: oldRole };
                    renderPhotoPreview();
                });
                meta.append(fileName, roleControl);

                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'photo-preview-remove';
                remove.textContent = '×';
                remove.setAttribute('aria-label', `حذف الصورة ${index + 1}`);
                remove.addEventListener('click', () => removeAttachedPhoto(index));
                item.append(img, meta, remove);
                bar.appendChild(item);
            });

            if (_pendingPhotos.length < 2) {
                const hint = document.createElement('span');
                hint.className = 'photo-attach-hint';
                hint.textContent = 'يمكن إضافة صورة ثانية لقائمة INCI';
                bar.appendChild(hint);
            }
        }

        function removeAttachedPhoto(index) {
            const removed = _pendingPhotos.splice(index, 1)[0];
            if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
            renderPhotoPreview();
        }

        function clearPhotoPreview() {
            _pendingPhotos.forEach(photo => { if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl); });
            _pendingPhotos = [];
            renderPhotoPreview();
        }
        function wirePhotoPicker() {
            const button = document.getElementById('photoBtn');
            const fileInput = document.getElementById('photoFileInput');
            if (button && fileInput && !button.dataset.photoPickerBound) {
                button.dataset.photoPickerBound = 'true';
                button.addEventListener('click', event => {
                    event.preventDefault();
                    // Calling click synchronously inside this user gesture opens the native picker.
                    fileInput.click();
                });
                fileInput.addEventListener('change', async () => {
                    const chosenFiles = Array.from(fileInput.files || []);
                    fileInput.value = '';
                    if (chosenFiles.length) await handlePhotoAttach(chosenFiles);
                });
            }
        }

        window.clearPhotoPreview = clearPhotoPreview;
        window.handlePhotoAttach = handlePhotoAttach;
        window.removeAttachedPhoto = removeAttachedPhoto;
        window.wirePhotoPicker = wirePhotoPicker;
        wirePhotoPicker();

