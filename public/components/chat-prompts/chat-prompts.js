// Prompt chips are declarative: updating copy in chat-prompts.html does not require JS changes.
document.querySelector('.prompt-scenarios')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-prompt]');
  if (!button) return;
  if (typeof window.sendPreset === 'function') window.sendPreset(button.dataset.prompt || '');
});
