        function setEngine(engine) {
            currentEngine = engine;
            localStorage.setItem('wathiq_ai_engine', engine);
            updateEngineUI();
        }

        function updateEngineUI() {
            const geminiBtn = document.getElementById('engineGeminiBtn');
            const groqBtn = document.getElementById('engineGroqBtn');
            if (geminiBtn && groqBtn) {
                if (currentEngine === 'gemini') {
                    geminiBtn.classList.add('active');
                    groqBtn.classList.remove('active');
                } else {
                    groqBtn.classList.add('active');
                    geminiBtn.classList.remove('active');
                }
            }
        }

