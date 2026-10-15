/**
 * Practical outputs — pure logic that turns the agent's results into things
 * people actually use: a shareable routine card + WhatsApp-ready text, and a
 * shopping list (with what the user already owns removed). The frontend only
 * renders these structures.
 */
import { tr, TLang } from './voice';
import type { CabinetItem } from './cabinet';

// ── shared helpers ───────────────────────────────────────────────────────────
const fmtMoney = (n: number, cur: string) => `${n} ${cur === 'DZD' ? 'دج' : cur}`;
const dn = (brand?: string, name?: string) => {
    const b = (brand || '').trim(), n = (name || '').trim();
    return !b ? n : n.toLowerCase().startsWith(b.toLowerCase()) ? n : `${b} ${n}`;
};
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const num = (i: number) => NUM[i] || `${i + 1}.`;

export interface ShareStep {
    number: number;
    name: string;
    when: string;
    howTo: string;
    product: { id: string; brand: string; name: string; price: number; priceKnown: boolean; currency: string; image?: string };
}

export interface RoutineShare {
    title: string;
    subtitle: string;
    lang: TLang;
    steps: ShareStep[];
    total: { value: number; currency: string; budget?: number; savings?: number };
    notes: string[];
    disclaimers: string[];
    whatsappText: string;
    markdown: string;
    generatedAt: string;
}

export function buildRoutineShare(routine: any, lang: TLang = 'ar', opts: { appName?: string } = {}): RoutineShare {
    const appName = opts.appName || 'Wathiq';
    const steps: ShareStep[] = (routine.steps || []).map((s: any, i: number) => ({
        number: i + 1,
        name: s.stepName,
        when: s.usageTime,
        howTo: s.howToUse,
        product: {
            id: s.product.id, brand: s.product.brand, name: s.product.name,
            price: s.product.price, priceKnown: typeof s.product.price === 'number' && s.product.price > 0,
            currency: s.product.currency || 'DZD', image: s.product.image,
        },
    }));
    const currency = steps[0]?.product.currency || 'DZD';
    const total = { value: routine.totalCost || steps.reduce((a, s) => a + (s.product.price || 0), 0), currency, budget: routine.maxBudget, savings: routine.savings };

    const title = routine.title || tr(lang, { ar: 'روتين العناية', fr: 'Routine de soins', en: 'Care routine' });
    const subtitle = [routine.concern, routine.maxBudget ? tr(lang, { ar: `ميزانية ${routine.maxBudget} دج`, fr: `budget ${routine.maxBudget} DA`, en: `budget ${routine.maxBudget} DZD` }) : ''].filter(Boolean).join(' · ');
    const notes: string[] = [...(routine.usageTips || [])].slice(0, 4);
    const disclaimers = [
        tr(lang, { ar: 'الأسعار تقريبية وقد تختلف حسب الصيدلية.', fr: 'Prix indicatifs, variables selon la pharmacie.', en: 'Prices are indicative and vary by pharmacy.' }),
        tr(lang, { ar: 'إرشاد عام وليس بديلاً عن استشارة طبيب الجلدية.', fr: 'Conseil général, ne remplace pas un dermatologue.', en: 'General guidance, not a substitute for a dermatologist.' }),
    ];

    const lines: string[] = [];
    lines.push(`🧴 *${title}*`);
    if (subtitle) lines.push(subtitle);
    lines.push('');
    steps.forEach((s, i) => {
        lines.push(`${num(i)} *${s.name}* — ${dn(s.product.brand, s.product.name)}${s.product.priceKnown ? ` — ${fmtMoney(s.product.price, s.product.currency)}` : ''}`);
        if (s.when) lines.push(`   ⏰ ${s.when}`);
    });
    lines.push('');
    lines.push(`💰 ${tr(lang, { ar: 'المجموع', fr: 'Total', en: 'Total' })}: *${fmtMoney(total.value, currency)}*${total.budget ? ` (${tr(lang, { ar: 'من ميزانية', fr: 'sur un budget de', en: 'of a budget of' })} ${fmtMoney(total.budget, currency)})` : ''}`);
    notes.slice(0, 2).forEach(n => lines.push(`• ${n}`));
    lines.push('');
    lines.push(`_${disclaimers[1]}_`);
    lines.push(`— ${appName}`);
    const whatsappText = lines.join('\n');

    const md: string[] = [`# ${title}`, subtitle ? `*${subtitle}*` : '', ''];
    steps.forEach(s => md.push(`${s.number}. **${s.name}** — ${dn(s.product.brand, s.product.name)}${s.product.priceKnown ? ` — ${fmtMoney(s.product.price, s.product.currency)}` : ''}\n   - ${s.when}\n   - ${s.howTo}`));
    md.push('', `**${tr(lang, { ar: 'المجموع', fr: 'Total', en: 'Total' })}:** ${fmtMoney(total.value, currency)}`, '', ...disclaimers.map(d => `> ${d}`));

    return { title, subtitle, lang, steps, total, notes, disclaimers, whatsappText, markdown: md.filter(x => x !== undefined).join('\n'), generatedAt: new Date().toISOString() };
}

// ── shopping list ────────────────────────────────────────────────────────────
export interface ShoppingItem {
    id: string;                 // stable checkbox id
    productId?: string;
    brand: string;
    name: string;
    category: string;
    priority: number;           // 1 = buy first
    price?: { min?: number; max?: number; currency: string };
    priceKnown: boolean;
    owned: boolean;             // already in the user's cabinet (using/finished)
    checked: boolean;
}

export interface ShoppingList {
    items: ShoppingItem[];
    toBuy: ShoppingItem[];
    owned: ShoppingItem[];
    total: { min: number; max: number; currency: string; unpriced: number };
    budget?: number;
    overBudget: boolean;
    buyFirst: string[];                       // names of the first 3 to buy
    whatsappText: string;
}

const PRIORITY: Array<[RegExp, number]> = [
    [/cleanser|face_wash|body_wash/, 1], [/lotion_cream|moisturi[sz]er|cream/, 2], [/sunscreen|spf/, 3],
    [/serum|treatment/, 4], [/toner|mask|eye|scrub|oil/, 5],
];
const prio = (cat: string) => (PRIORITY.find(([re]) => re.test((cat || '').toLowerCase())) || [null, 6])[1] as number;

export function buildShoppingList(input: {
    routine?: any;
    products?: any[];                     // search results / any products with {id, brand, name, price, category}
    cabinet?: CabinetItem[];
    budget?: number;
    lang?: TLang;
}): ShoppingList {
    const lang = input.lang || 'ar';
    const cab = input.cabinet || [];
    const rows: Array<{ id?: string; brand: string; name: string; category: string; price?: any }> = [];
    for (const s of input.routine?.steps || []) rows.push({ id: s.product.id, brand: s.product.brand, name: s.product.name, category: s.category, price: { min: s.product.price, max: s.product.price, currency: s.product.currency || 'DZD' } });
    for (const p of input.products || []) {
        // Display prices may be ranges ("350 – 400"): read every number, min = first, max = last.
        const nums = typeof p.price === 'number' ? [p.price] : (String(p.price || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
        const valid = nums.filter(x => isFinite(x) && x > 0);
        const lo = valid.length ? Math.min(...valid) : 0, hi = valid.length ? Math.max(...valid) : 0;
        rows.push({ id: p.id, brand: p.brand, name: p.name, category: p.category?.id || p.category || '', price: p.priceKnown === false || valid.length === 0 ? undefined : { min: lo, max: hi, currency: p.currency || 'DZD' } });
    }
    const seen = new Set<string>();
    const items: ShoppingItem[] = [];
    for (const r of rows) {
        const key = r.id || `${r.brand}|${r.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const owned = !!r.id && cab.some(c => c.productId === r.id && (c.status === 'using' || c.status === 'finished'));
        items.push({
            id: `shop_${items.length + 1}`, productId: r.id, brand: r.brand, name: r.name, category: String(r.category || ''),
            priority: prio(String(r.category || '')), price: r.price, priceKnown: !!r.price && (r.price.min !== undefined || r.price.max !== undefined),
            owned, checked: owned,
        });
    }
    items.sort((a, b) => a.priority - b.priority);
    const toBuy = items.filter(i => !i.owned), owned = items.filter(i => i.owned);
    let min = 0, max = 0, unpriced = 0;
    for (const i of toBuy) {
        if (i.priceKnown) { min += i.price!.min ?? i.price!.max ?? 0; max += i.price!.max ?? i.price!.min ?? 0; } else unpriced++;
    }
    const budget = input.budget ?? input.routine?.maxBudget;
    const overBudget = !!budget && max > budget;

    const L: string[] = [];
    L.push(`🛒 *${tr(lang, { ar: 'قائمة التسوق', fr: 'Liste de courses', en: 'Shopping list' })}*`);
    toBuy.forEach(i => L.push(`☐ ${dn(i.brand, i.name)}${i.priceKnown ? ` — ${fmtMoney(i.price!.min ?? i.price!.max!, i.price!.currency)}` : ` — ${tr(lang, { ar: 'السعر غير متوفر', fr: 'prix indisponible', en: 'price n/a' })}`}`));
    owned.forEach(i => L.push(`☑ ${dn(i.brand, i.name)} — ${tr(lang, { ar: 'عندك', fr: 'déjà chez vous', en: 'already own' })}`));
    L.push('');
    L.push(`💰 ${tr(lang, { ar: 'المجموع', fr: 'Total', en: 'Total' })}: *${min === max ? fmtMoney(min, 'DZD') : `${min}–${fmtMoney(max, 'DZD')}`}*${unpriced ? ` (+${unpriced} ${tr(lang, { ar: 'بلا سعر', fr: 'sans prix', en: 'unpriced' })})` : ''}`);

    return {
        items, toBuy, owned, total: { min, max, currency: 'DZD', unpriced }, budget, overBudget,
        buyFirst: toBuy.slice(0, 3).map(i => dn(i.brand, i.name)), whatsappText: L.join('\n'),
    };
}
