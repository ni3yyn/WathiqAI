        // Image Modal Lightbox
        function openImageModal(imgSrc, name, brand) {
            if (!imgSrc) return;
            const modal = document.getElementById('imageModal');
            const img = document.getElementById('modalImg');
            const title = document.getElementById('modalTitle');
            const brandEl = document.getElementById('modalBrand');

            img.src = imgSrc;
            title.textContent = name || 'منتج العناية';
            brandEl.textContent = brand || 'وثيق';
            modal.classList.add('active');
        }

        function closeImageModal() {
            const modal = document.getElementById('imageModal');
            if (modal) modal.classList.remove('active');
        }

