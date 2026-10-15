        // Scroll Intelligence & FAB Controller
        function isUserNearBottom() {
            if (!chatContainer) return true;
            const threshold = 120;
            return (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) <= threshold;
        }

        function updateFabState() {
            if (!chatContainer || !scrollFab) return;
            const isNear = isUserNearBottom();

            if (isNear) {
                userHasScrolledUp = false;
                hasNewContentWhileScrolled = false;
                scrollFab.classList.remove('visible');
                if (scrollUnreadDot) scrollUnreadDot.classList.add('hidden');
                if (scrollFabText) scrollFabText.textContent = 'النزول للأسفل';
            } else {
                userHasScrolledUp = true;
                scrollFab.classList.add('visible');
                if (hasNewContentWhileScrolled) {
                    if (scrollUnreadDot) scrollUnreadDot.classList.remove('hidden');
                    if (scrollFabText) scrollFabText.textContent = 'رسائل جديدة ↓';
                } else {
                    if (scrollUnreadDot) scrollUnreadDot.classList.add('hidden');
                    if (scrollFabText) scrollFabText.textContent = 'النزول للأسفل';
                }
            }
        }

        function scrollToBottomSmart(force = false) {
            if (!chatContainer) return;
            if (force || (!userHasScrolledUp && isUserNearBottom())) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
                updateFabState();
            } else if (userHasScrolledUp) {
                hasNewContentWhileScrolled = true;
                updateFabState();
            }
        }

        function scrollToBottomAction() {
            if (!chatContainer) return;
            userHasScrolledUp = false;
            hasNewContentWhileScrolled = false;
            chatContainer.scrollTo({
                top: chatContainer.scrollHeight,
                behavior: 'smooth'
            });
            updateFabState();
        }

        if (chatContainer) {
            chatContainer.addEventListener('scroll', () => {
                updateFabState();
            }, { passive: true });
        }
