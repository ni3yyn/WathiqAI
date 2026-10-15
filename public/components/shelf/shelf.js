// The shelf's account/data lifecycle is coordinated by auth.js; this file owns shelf-only setup.
const shelfDialog = document.getElementById('shelfModal');
if (shelfDialog) shelfDialog.setAttribute('data-shelf-component', 'ready');
