/* Wathiq product lookup and selection UI.
 * Uses delegated events and data attributes instead of executable inline handlers.
 */
(function installWathiqProductCards() {
    const iconPackage = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.3 7.6 7.7 4.5 7.7-4.5M12 12.1V21"/></svg>`;
    const iconImage = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
    const iconBolt = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m13 2-3 9h7L9 22l2-9H4l9-11Z"/></svg>`;
    const iconArrow = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    const iconUpload = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2"/></svg>`;

    function asText(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string' || typeof value === 'number') return String(value);
        return '';
    }

    function productIdOf(product) {
        return asText(product?.id ?? product?.productId ?? product?.product_id).trim();
    }

    function safeProductImage(value) {
        const raw = asText(value).trim();
        if (!raw) return '';
        // Product artwork may be hosted remotely or served from this app; reject executable/data schemes.
        if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw;
        return '';
    }

    function productPrice(product) {
        const price = product?.price;
        if (price === null || price === undefined || price === '') return '';
        if (typeof price === 'object') {
            try { return formatPrice(price, product.currency || 'دج'); }
            catch (_) { return ''; }
        }
        return `${asText(price)} ${asText(product.currency || 'دج')}`.trim();
    }

    function normaliseClaims(product) {
        const claims = Array.isArray(product?.claims) ? product.claims : [];
        return claims.map((claim) => {
            if (typeof claim === 'string') return claim.trim();
            if (claim && typeof claim === 'object') return asText(claim.label || claim.name || claim.claim || claim.text).trim();
            return '';
        }).filter(Boolean).slice(0, 2);
    }

    function isExplicitlyNotEvaluable(product) {
        return product?.canEvaluate === false || product?.ingredientsAvailable === false;
    }

    function renderProductsGrid(products, variant = 'results') {
        const list = Array.isArray(products) ? products.filter(p => p && typeof p === 'object') : [];
        if (!list.length) return '';

        window.__PRODUCTS_MAP__ = window.__PRODUCTS_MAP__ || Object.create(null);
        const unique = [];
        const seen = new Set();
        list.forEach((product) => {
            const id = productIdOf(product);
            const key = id || `${asText(product.brand)}|${asText(product.name)}`;
            if (seen.has(key)) return;
            seen.add(key);
            if (id) window.__PRODUCTS_MAP__[id] = product;
            unique.push(product);
        });

        const showPickerHeader = variant === 'results' && unique.length > 0;
        const intro = showPickerHeader ? `
            <header class="product-selection-heading" dir="rtl">
                <div class="product-selection-heading-icon" aria-hidden="true">${iconPackage}</div>
                <div class="product-selection-heading-copy">
                    <h3>${unique.length > 1 ? 'اختر المنتج الذي تقصده' : 'هل هذا هو المنتج المقصود؟'}</h3>
                    <p>${unique.length > 1 ? `وجدت ${unique.length} منتجات متشابهة. اختر المنتج الصحيح حتى يكون التقييم دقيقًا.` : 'اختر المنتج لبدء تقييم ادعاءاته وتركيبته.'}</p>
                </div>
                <span class="product-result-count">${unique.length} ${unique.length === 1 ? 'نتيجة' : 'نتائج'}</span>
            </header>` : '';

        const cards = unique.map((product, index) => {
            const id = productIdOf(product);
            const name = asText(product.name || product.productName || 'منتج عناية');
            const brand = asText(product.brand || product.brandName || 'علامة غير محددة');
            const image = safeProductImage(product.image || product.imageUrl || product.image_url);
            const quantity = asText(product.quantity || product.size || product.volume);
            const price = productPrice(product);
            const claims = normaliseClaims(product);
            const safeId = escapeHtml(id);
            const safeName = escapeHtml(name);
            const safeBrand = escapeHtml(brand);
            const safeImage = escapeHtml(image);
            const safePrice = escapeHtml(price);
            const safeQuantity = escapeHtml(quantity);
            const canEvaluate = !isExplicitlyNotEvaluable(product) && Boolean(id);
            const needsIngredientsPhoto = isExplicitlyNotEvaluable(product);
            const nameDir = isRTLText(name) ? 'rtl' : 'auto';
            const brandDir = isRTLText(brand) ? 'rtl' : 'auto';
            const claimTags = claims.map(claim => `<span class="product-mini-claim" dir="${isRTLText(claim) ? 'rtl' : 'auto'}">${escapeHtml(claim)}</span>`).join('');

            let action = '';
            if (canEvaluate) {
                action = `<button type="button" class="product-mini-action" data-product-evaluate="${safeId}" aria-label="اختيار ${safeName} من ${safeBrand} وتقييمه">
                    <span>${iconBolt}</span><span>اختيار وتقييم</span>${iconArrow}
                </button>`;
            } else if (needsIngredientsPhoto) {
                action = `<button type="button" class="product-mini-action product-mini-action-upload" data-product-upload="${safeId}" data-product-name="${safeName}" aria-label="رفع صورة مكونات ${safeName}">
                    <span>${iconUpload}</span><span>رفع صورة المكونات</span>${iconArrow}
                </button>`;
            } else {
                action = `<button type="button" class="product-mini-action" disabled aria-disabled="true" title="لا يتوفر معرّف لهذا المنتج في الكتالوج">تعذّر الاختيار من الكتالوج</button>`;
            }

            const noInciNotice = needsIngredientsPhoto ? `<div class="product-mini-inci-note" role="note">قائمة المكونات غير متوفرة في الكتالوج</div>` : '';
            return `<article class="product-mini" data-product-card data-product-index="${index + 1}">
                <div class="product-mini-top">
                    <button type="button" class="product-mini-img-wrap ${image ? 'has-image' : 'no-image'}" ${image ? `data-product-image="${safeImage}" data-product-name="${safeName}" data-product-brand="${safeBrand}" aria-label="عرض صورة ${safeName}"` : 'disabled aria-label="لا تتوفر صورة للمنتج"'}>
                        ${image ? `<img class="product-mini-image" src="${safeImage}" alt="${safeName}" loading="lazy" decoding="async"><span class="product-mini-image-fallback" hidden>${iconPackage}</span><span class="img-expand-badge">${iconImage}</span>` : `<span class="product-mini-image-fallback">${iconPackage}</span>`}
                    </button>
                    <div class="product-mini-info">
                        <div class="product-mini-brand" dir="${brandDir}">${safeBrand}</div>
                        <h4 class="product-mini-name" dir="${nameDir}">${safeName}</h4>
                        <div class="product-mini-meta">
                            ${safePrice ? `<span class="product-mini-price">${safePrice}</span>` : ''}
                            ${safeQuantity ? `<span class="product-mini-quantity">${safeQuantity}</span>` : ''}
                        </div>
                    </div>
                    <span class="product-mini-index" aria-hidden="true">${index + 1}</span>
                </div>
                ${claims.length ? `<div class="product-mini-claims" aria-label="ادعاءات المنتج">${claimTags}</div>` : ''}
                ${noInciNotice}
                <div class="product-mini-footer">${action}</div>
            </article>`;
        }).join('');

        return `<section class="product-selection-section" aria-label="نتائج البحث عن المنتجات">${intro}<div class="products-rail products-grid">${cards}</div></section>`;
    }

    function evaluateProductById(productId) {
        const id = String(productId || '').trim();
        window.__PRODUCTS_MAP__ = window.__PRODUCTS_MAP__ || Object.create(null);
        const product = window.__PRODUCTS_MAP__[id];
        if (!id || !product) {
            appendErrorMessage('لم أستطع تحديد المنتج من النتائج الحالية. أعد البحث باسمه أو علامته التجارية.');
            return;
        }
        if (isExplicitlyNotEvaluable(product)) {
            prepareProductIngredientUpload(id, product.name || product.productName || 'هذا المنتج');
            return;
        }

        const name = asText(product.name || product.productName || 'المنتج');
        const brand = asText(product.brand || product.brandName || '');
        const claims = normaliseClaims(product);
        const claimsNote = claims.length ? ` الادعاءات التي أريد التحقق منها: ${claims.join('، ')}.` : '';
        window.__WATHIQ_DISPLAY_MESSAGE_NEXT = `قيّم ${name}${brand ? ` من ${brand}` : ''}`;
        sendPreset(`قيّم المنتج بالمعرف: ${id} (${name}${brand ? ` - ${brand}` : ''}).${claimsNote}`);
    }

    function prepareProductIngredientUpload(productId, productName) {
        const name = asText(productName || 'هذا المنتج');
        const input = document.getElementById('messageInput');
        const fileInput = document.getElementById('photoFileInput');
        // This action is specifically asking for the ingredient panel, not the front label.
        window.__WATHIQ_NEXT_PHOTO_ROLE = 'inci';
        if (input) {
            input.value = `افحص قائمة المكونات الظاهرة في الصورة لمنتج ${name}، ثم وضّح ما يمكن التحقق منه من ادعاءاته.`;
            if (typeof autoResize === 'function') autoResize(input);
            if (typeof checkClearButtonVisibility === 'function') checkClearButtonVisibility();
        }
        if (fileInput) fileInput.click();
        else if (input) input.focus();
    }

    function appendErrorMessage(message) {
        if (typeof removeThinkingBubble === 'function') removeThinkingBubble();
        const container = document.getElementById('chatMessages');
        if (!container) return;
        container.querySelectorAll('.wq-error-message').forEach(el => el.remove());

        const alert = document.createElement('div');
        alert.className = 'wq-error-message';
        alert.setAttribute('role', 'alert');
        alert.setAttribute('aria-live', 'assertive');
        alert.dir = 'rtl';
        alert.innerHTML = `<div class="wq-error-icon" aria-hidden="true">!</div>
            <div class="wq-error-content"><strong>لم يكتمل الطلب</strong><p></p>
            <div class="wq-error-actions"><button type="button" data-wathiq-retry>إعادة المحاولة</button><span>يمكنك أيضًا تعديل سؤالك وإرساله من جديد.</span></div></div>`;
        alert.querySelector('p').textContent = asText(message) || 'حدثت مشكلة غير متوقعة. حاول مرة أخرى.';
        container.appendChild(alert);
        if (typeof scrollToBottomSmart === 'function') scrollToBottomSmart();
    }

    // Safe delegated handlers survive streamed insertion and avoid inline JavaScript.
    document.addEventListener('click', (event) => {
        const retry = event.target.closest?.('[data-wathiq-retry]');
        if (retry) {
            if (typeof window.retryLastWathiqMessage === 'function') window.retryLastWathiqMessage();
            return;
        }
        const evaluateButton = event.target.closest?.('[data-product-evaluate]');
        if (evaluateButton) {
            if (!evaluateButton.disabled) evaluateProductById(evaluateButton.dataset.productEvaluate);
            return;
        }
        const uploadButton = event.target.closest?.('[data-product-upload]');
        if (uploadButton) {
            prepareProductIngredientUpload(uploadButton.dataset.productUpload, uploadButton.dataset.productName);
            return;
        }
        const imageButton = event.target.closest?.('[data-product-image]');
        if (imageButton) {
            openImageModal(imageButton.dataset.productImage, imageButton.dataset.productName, imageButton.dataset.productBrand);
        }
    });

    document.addEventListener('error', (event) => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || !image.classList.contains('product-mini-image')) return;
        image.hidden = true;
        const fallback = image.parentElement?.querySelector('.product-mini-image-fallback');
        if (fallback) fallback.hidden = false;
    }, true);

    // Existing renderers use these globals.
    window.renderProductsGrid = renderProductsGrid;
    window.evaluateProductById = evaluateProductById;
    window.appendErrorMessage = appendErrorMessage;
    window.prepareProductIngredientUpload = prepareProductIngredientUpload;
})();
