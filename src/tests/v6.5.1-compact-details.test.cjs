const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const context = {
  window: { __PRODUCTS_MAP__: {} },
  escapeHtml,
  formatInline: value => value,
  isRTLText: value => /[\u0600-\u06ff]/.test(String(value || '')),
};
vm.createContext(context);
vm.runInContext(read('public/components/analysis-cards/analysis-cards.js'), context);
assert.equal(typeof context.renderAnalysisCard, 'function');

const card = context.renderAnalysisCard({
  oilGuardScore: 64,
  finalVerdict: 'متوسط',
  safety: { score: 70, flags: [{ type: 'warning', message: 'ملاحظة سلامة تجريبية.' }] },
  efficacy: { score: 58, notes: 'ملاحظة فعالية تجريبية.' },
  marketing_results: [{ claim: 'ترطيب البشرة', status: 'محقق بنسبة متوسطة', explanation: 'مثال توضيحي للاختبار.' }],
  detected_ingredients: [{ id: 'niacinamide', name: 'Niacinamide' }],
  unknown_ingredients: ['Mystery Extract'],
  notes: ['ملاحظة عامة من المحرك.'],
  scoreBreakdown: [
    { type: 'calculation', text: 'التقييم النهائي: 64/100', value: 'متوسط' },
    { type: 'deduction', text: 'خصم بسبب مكون مثير للتهيج', value: '-15 (أمان)' },
    { type: 'good', text: 'ميزة: يحتوي على مرطبات', value: 'مناسب لك' },
    { type: 'warning', text: 'تنبيه يتعلق بملاءمة التركيبة', value: '-10 (ملاءمة)' },
    { type: 'info', text: 'ميزة دعم مرطب من المحرك', value: 'ميزة' },
    { type: 'info', text: 'معلومة إضافية من المحرك لا تغيّر الدرجة مباشرة', value: 'استثناء' },
  ],
  personalMatch: { status: 'warning', reasons: [{ type: 'warning', code: 'sensitive_skin', text: 'قد لا يناسب البشرة الحساسة.' }] },
}, 'Test Product', 'Test Brand');

for (const value of [
  'ملاحظات المحرك',
  'الملاءمة لحالتك',
  'ما الذي رفع أو خفّض الدرجة؟',
  'عوامل إيجابية',
  'عوامل سلبية',
  'ميزة: يحتوي على مرطبات',
  'خصم بسبب مكون مثير للتهيج',
  'قد لا يناسب البشرة الحساسة.',
  'ملاحظة عامة من المحرك.',
  'ملاحظة سلامة تجريبية.',
  'ملاحظة فعالية تجريبية.',
  'الادعاءات التسويقية',
  'المكونات المطابقة',
  'مكونات غير معروفة',
]) assert.ok(card.includes(value), `Rendered card missing: ${value}`);

assert.ok(!card.includes('التقييم النهائي: 64/100'), 'Calculation rows must not be rendered.');
assert.ok(!card.includes('-15 (أمان)'), 'Numeric deduction values must not be rendered.');
assert.ok(!card.includes('-10 (ملاءمة)'), 'Numeric suitability penalty values must not be rendered.');
assert.ok(!card.includes('عرض بقية تفاصيل الدرجة'), 'Old verbose score list should be gone.');

const detailsTags = [...card.matchAll(/<details\b[^>]*>/g)].map(m => m[0]);
assert.ok(detailsTags.length >= 6, `Expected separate detail accordions, got ${detailsTags.length}`);
assert.ok(detailsTags.every(tag => !/\bopen\b/i.test(tag)), 'All detail accordions must be collapsed by default.');
assert.ok(card.includes('score-factor-sign'), 'Score factors should render plus/minus markers.');

const prompt = read('agent/prompt.ts');
assert.ok(prompt.includes('Do not proactively list every note or score factor'));
assert.ok(prompt.includes('Only when the user asks why the score'));
assert.ok(!prompt.includes('All entries are shown in the card.'));
assert.ok(!prompt.includes('`scoreBreakdown`'), 'Prompt must not have unescaped template-literal backticks around field names.');

const server = read('server.ts');
assert.ok(server.includes("const WATHIQ_AGENT_VERSION = '6.5.1'"));
console.log('PASS v6.5.1 compact accordions, plus/minus-only score factors, and prompt behavior');
