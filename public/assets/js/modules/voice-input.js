        // Voice Input Controller
        function toggleVoiceInput() {
            const micBtn = document.getElementById('micBtn');
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

            if (!SpeechRecognition) {
                alert('التعرف الصوتي غير مدعوم في متصفحك الحالي.');
                return;
            }

            if (isListening) {
                if (recognition) recognition.stop();
                return;
            }

            try {
                recognition = new SpeechRecognition();
                recognition.lang = 'ar-SA';
                recognition.interimResults = false;
                recognition.maxAlternatives = 1;

                recognition.onstart = () => {
                    isListening = true;
                    if (micBtn) micBtn.classList.add('recording');
                };

                recognition.onresult = (event) => {
                    const transcript = event.results[0][0].transcript;
                    const input = document.getElementById('messageInput');
                    if (input && transcript) {
                        input.value = (input.value ? input.value + ' ' : '') + transcript;
                        autoResize(input);
                        checkClearButtonVisibility();
                    }
                };

                recognition.onerror = () => {
                    isListening = false;
                    if (micBtn) micBtn.classList.remove('recording');
                };

                recognition.onend = () => {
                    isListening = false;
                    if (micBtn) micBtn.classList.remove('recording');
                };

                recognition.start();
            } catch (err) {
                console.warn('Speech recognition error:', err);
                isListening = false;
                if (micBtn) micBtn.classList.remove('recording');
            }
        }

        function clearInputField() {
            const input = document.getElementById('messageInput');
            if (input) {
                input.value = '';
                autoResize(input);
                checkClearButtonVisibility();
                input.focus();
            }
        }

        function checkClearButtonVisibility() {
            const input = document.getElementById('messageInput');
            const clearBtn = document.getElementById('clearInputBtn');
            if (input && clearBtn) {
                if (input.value.trim().length > 0) {
                    clearBtn.classList.remove('hidden');
                } else {
                    clearBtn.classList.add('hidden');
                }
            }
        }

