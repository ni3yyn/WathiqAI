// Header behavior stays separate from presentation.
document.getElementById('resetChatBtn')?.addEventListener('click', () => {
  if (typeof window.clearChat === 'function') window.clearChat();
});
