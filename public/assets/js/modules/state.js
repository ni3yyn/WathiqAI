        let conversation = [];
        let isAnimating = false;
        // Change this line:
let currentEngine = 'gemini'; // Locked to Gemini while the switcher is hidden
        let userHasScrolledUp = false;
        let hasNewContentWhileScrolled = false;
        let recognition = null;
        let isListening = false;

        const chatContainer = document.getElementById('chatMessages');
        const scrollFab = document.getElementById('scrollBottomFab');
        const scrollUnreadDot = document.getElementById('scrollUnreadDot');
        const scrollFabText = document.getElementById('scrollFabText');

