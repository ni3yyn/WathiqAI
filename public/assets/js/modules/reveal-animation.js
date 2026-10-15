        function revealCardsIn(root) {
            if (!root) return;
            let innerIdx = 0;
            root.querySelectorAll('.products-rail > .product-mini, .claims-rail > .claim-row, .routine-steps > .routine-step, .routine-summary-rail > .routine-summary-card, .standout-product-row, .brand-audit-box').forEach(el => {
                el.classList.add('reveal-card-item');
                el.style.animationDelay = (innerIdx * 70) + 'ms';
                innerIdx++;
            });
            let secIdx = 0;
            Array.from(root.children).forEach(el => {
                el.style.opacity = '0';
                el.style.animation = `sectionFade 0.45s ease-out ${secIdx * 60}ms forwards`;
                secIdx++;
            });
        }

        const CARD_CLASS_NAMES = ['analysis-card', 'routine-card', 'product-mini', 'claim-row', 'routine-step', 'routine-summary-card', 'brand-review-card'];

        function isCardElement(el) {
            if (!el || !el.classList) return false;
            for (const c of CARD_CLASS_NAMES) {
                if (el.classList.contains(c)) return true;
            }
            return false;
        }

        function animateReveal(containerEl, finalHtml) {
            containerEl.innerHTML = '';
            const temp = document.createElement('div');
            temp.innerHTML = finalHtml;
            const childNodes = Array.from(temp.childNodes);
            const totalWords = countWords(temp);
            const perWord = totalWords > 300 ? 4 : (totalWords > 150 ? 6 : (totalWords > 80 ? 10 : 16));
            const queue = [];

            function enqueueNode(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.nodeValue;
                    if (!text) return;
                    const tokens = text.split(/(\s+)/);
                    tokens.forEach(tok => {
                        if (tok === '') return;
                        if (/^\s+$/.test(tok)) queue.push({ type: 'text', value: tok });
                        else queue.push({ type: 'word', value: tok });
                    });
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    const tag = node.tagName;
                    if (tag === 'PRE' || tag === 'CODE' || tag === 'TABLE' || tag === 'IMG' || tag === 'HR' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'BDI' || tag === 'SVG' || tag === 'USE') {
                        queue.push({ type: 'block', value: node.cloneNode(true), isCard: false });
                    } else {
                        const clone = node.cloneNode(false);
                        queue.push({ type: 'open', value: clone });
                        Array.from(node.childNodes).forEach(enqueueNode);
                        queue.push({ type: 'close', value: clone });
                    }
                }
            }
            childNodes.forEach(enqueueNode);

            let currentParent = containerEl;
            const parentStack = [containerEl];
            let i = 0;
            let cardIdx = 0;

            function step() {
                if (i >= queue.length) { 
                    applyAutoRTLToProse(containerEl);
                    scrollToBottomSmart();
                    return; 
                }
                const item = queue[i];
                if (item.type === 'open') {
                    const clone = item.value.cloneNode(false);
                    currentParent.appendChild(clone);
                    parentStack.push(clone);
                    currentParent = clone;
                    i++; step(); return;
                }
                if (item.type === 'close') {
                    parentStack.pop();
                    currentParent = parentStack[parentStack.length - 1];
                    i++; step(); return;
                }
                if (item.type === 'text') {
                    currentParent.appendChild(document.createTextNode(item.value));
                    i++; step(); return;
                }
                if (item.type === 'block') {
                    const clone = item.value.cloneNode(true);
                    if (isCardElement(clone)) {
                        clone.classList.add('reveal-card-block');
                        clone.style.animationDelay = (cardIdx * 70) + 'ms';
                        cardIdx++;
                    } else {
                        clone.classList.add('reveal-block');
                        clone.style.animationDelay = '0ms';
                    }
                    currentParent.appendChild(clone);
                    i++; step(); return;
                }
                if (item.type === 'word') {
                    const span = document.createElement('span');
                    span.className = 'reveal-word';
                    span.textContent = item.value;
                    currentParent.appendChild(span);
                    i++;
                    scrollToBottomSmart();
                    setTimeout(step, perWord);
                }
            }
            step();
        }

        function applyAutoRTLToProse(container) {
            const candidates = container.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, td, th, .product-mini-name, .product-mini-claim, .claim-title, .claim-explain, .claim-status-text, .brand-review-card');
            candidates.forEach(el => {
                if (el.dataset.rtlApplied === '1') return;
                const text = el.textContent || '';
                if (isRTLText(text)) {
                    el.classList.add('rtl-text');
                    el.setAttribute('dir', 'rtl');
                }
                el.dataset.rtlApplied = '1';
            });
        }

        function countWords(root) {
            let count = 0;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                    if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                    const p = node.parentElement;
                    if (p && (p.tagName === 'PRE' || p.tagName === 'CODE' || p.tagName === 'SVG')) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            while (walker.nextNode()) count += walker.currentNode.nodeValue.trim().split(/\s+/).filter(Boolean).length;
            return count;
        }

