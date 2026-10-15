// SVG symbols are static markup; this initializer keeps the decorative sprite out of keyboard navigation.
const wathiqIconSprite = document.getElementById('wathiqIconSprite');
if (wathiqIconSprite) wathiqIconSprite.setAttribute('focusable', 'false');
