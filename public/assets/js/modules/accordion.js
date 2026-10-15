        function toggleAccordion(headerEl) {
    const item = headerEl && headerEl.closest('.accordion-item');
    if (!item) return;
    const wasOpen = item.classList.contains('open');
    item.classList.toggle('open');
    if (!wasOpen) {
        item.querySelectorAll('.product-mini, .claim-row, .standout-row').forEach((el, i) => {
            el.style.opacity = '0';
            el.style.animation = `sectionFade 0.35s ease-out ${i * 40}ms forwards`;
        });
    }
}



