// Keep the composer responsive without mixing its behavior into the markup template.
const wathiqMessageInput = document.getElementById('messageInput');
if (wathiqMessageInput) {
  wathiqMessageInput.addEventListener('input', () => {
    if (typeof window.autoResize === 'function') window.autoResize(wathiqMessageInput);
    if (typeof window.checkClearButtonVisibility === 'function') window.checkClearButtonVisibility();
  });
}
