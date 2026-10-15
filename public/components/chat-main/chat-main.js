        function clearChat() {
            conversation = [];
            _wathiqSessionId = null;
            const container = document.getElementById('chatMessages');
            container.innerHTML = `
                <div class="agent-flow animate-slide-up" style="margin-bottom: 1.25rem;">
                    <div class="flex items-center gap-2.5" style="margin-bottom: 0.7rem;">
                        <div class="agent-avatar rounded-xl flex items-center justify-center text-white" style="width: 30px; height: 30px;">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="#i-flask"/></svg>
                        </div>
                        <span class="font-bold text-sage-900" style="font-size: 0.85rem;">وكيل وثيق</span>
                    </div>
                    <div class="chat-prose">
                        <p class="font-bold text-sage-900" style="font-size: 1.08rem;">تم مسح سجل المحادثة.</p>
                        <p class="text-mist-600">أستطيع تقييم الماركات والمنتجات فعلياً، مقارنة 2–4 منتجات جنباً إلى جنب، فحص أي قائمة مكونات خام (INCI) حتى لو المنتج غير موجود في الكتالوج، سماع رأي المجتمع من TikTok، وبناء روتين كامل ضمن ميزانيتك.</p>
                        <p class="text-mist-400" style="font-size: 0.85rem; margin-top: 0.6rem;">جرّب: "ما رأيك في ماركة بيلنكو وخصوصاً الغسول تاعهم؟" · "قارن بين هاذو" · أو الصق مكونات أي منتج.</p>
                    </div>
                </div>
            `;
            userHasScrolledUp = false;
            hasNewContentWhileScrolled = false;
            updateFabState();
        }

        function sendPreset(text) {
            const input = document.getElementById('messageInput');
            input.value = text;
            autoResize(input);
            checkClearButtonVisibility();
            handleSubmit(new Event('submit'));
        }

        function autoResize(textarea) {
            textarea.style.height = 'auto';
            const newHeight = Math.min(textarea.scrollHeight, 140);
            textarea.style.height = newHeight + 'px';
        }

        function initTextarea() {
            const input = document.getElementById('messageInput');
            if (!input) return;
            autoResize(input);
            input.addEventListener('input', () => {
                autoResize(input);
                checkClearButtonVisibility();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    handleSubmit(e);
                }
            });
            input.addEventListener('focus', () => {
                input.style.outline = 'none';
                input.style.boxShadow = 'none';
            });
        }

