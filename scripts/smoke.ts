/**
 * Offline smoke tests — no API keys, no network.
 *   npx tsx scripts/smoke.ts
 *
 * Covers: router intents (incl. the new tools), follow-up parsing, routine-edit
 * parsing, ingredient knowledge, the 4 new tools against a tiny synthetic
 * catalog, the evaluation cache (mocked fetch), and the fast-lane dispatcher.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// Run inside a temp cwd with a synthetic catalog so nothing touches the network.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wathiq-smoke-'));
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
const P = (id: string, brand: string, name: string, category: string, price: number, ing: string, extra: any = {}) =>
    ({ id, brand, name, category, price, country: 'Algeria', ingredients: ing, marketingClaims: [], targetTypes: [], ...extra });
fs.writeFileSync(path.join(tmp, 'data', 'catalog.json'), JSON.stringify([
    P('DZ-SSE-AAA-001', 'Alpha', 'Alpha Serum', 'skin_serum', 2000, 'Aqua, Glycerin, Niacinamide, Zinc PCA, Cetearyl Alcohol, Parfum'),
    P('DZ-SSE-BBB-002', 'Beta', 'Beta Serum', 'skin_serum', 1500, 'Aqua, Niacinamide, Zinc PCA, Panthenol'),
    P('DZ-SSE-CCC-003', 'Gamma', 'Gamma Serum', 'skin_serum', 1200, 'Aqua, Glycerin, Alcohol Denat., Retinol'),
    P('DZ-CLE-DDD-001', 'Delta', 'Delta Cleanser', 'cleanser', 900, 'Aqua, Glycerin, Sodium Lauryl Sulfate'),
    P('DZ-SSE-DDD-004', 'Delta', 'Delta Serum', 'skin_serum', 1800, 'Aqua, Glycerin, Niacinamide'),
    P('DZ-CLE-EEE-002', 'Echo', 'Echo Cleanser', 'cleanser', 700, 'Aqua, Glycerin, Cocamidopropyl Betaine'),
    P('DZ-LOT-FFF-001', 'Foxtrot', 'Foxtrot Cream', 'lotion_cream', 1500, 'Aqua, Ceramide NP, Glycerin'),
    P('DZ-SUN-GGG-001', 'Golf', 'Golf Sunscreen', 'sunscreen', 1800, 'Aqua, Zinc Oxide, Titanium Dioxide'),
    P('DZ-TON-HHH-001', 'Hotel', 'Hotel Toner', 'toner', 800, 'Aqua, Glycerin, Panthenol'),
]));
process.env.LONGTERM_MEMORY = 'true';
process.env.LONGTERM_FILE = path.join(tmp, 'data', 'longterm.jsonl');
process.env.LONGTERM_SALT = 'test-salt';
process.chdir(tmp);

let passed = 0, failed = 0;
const ok = (cond: any, label: string) => {
    if (cond) { passed++; } else { failed++; console.log(`  ✗ FAIL: ${label}`); }
};
const section = (t: string) => console.log(`\n▸ ${t}`);

async function main() {
    const { classifyIntent } = await import('../src/agent/agent');
    const { sessionMemory } = await import('../src/agent/sessionMemory');
    const { buildSearchRefinement } = await import('../src/agent/followups');
    const { parseRoutineEdit, isContainsQuestion, isCompatQuestion, detectLang, parseStepNumber } = await import('../src/agent/intents');
    const { resolveConcept, resolveAllConcepts, matchConceptInList } = await import('../src/agent/ingredientKnowledge');
    const { productContains } = await import('../src/agent/tools/productContains');
    const { findAlternatives } = await import('../src/agent/tools/findAlternatives');
    const { checkCompatibility } = await import('../src/agent/tools/checkCompatibility');
    const { modifyRoutine } = await import('../src/agent/tools/modifyRoutine');
    const { searchProducts } = await import('../src/agent/tools/searchProducts');
    const { tryFastLane } = await import('../src/agent/fastLane');
    const { evaluateProduct, getEvalCacheStats } = await import('../src/wathiq/backendClient');
    const { emitCardForTool } = await import('../src/agent/cards');
    const { analyzeNegation, findNegatedCategories, isPhraseNegated } = await import('../src/agent/negation');
    const { detectCorrection } = await import('../src/agent/corrections');
    const { updateMissionAfterTurn, buildMissionContext, activeMission, isClosingMessage } = await import('../src/agent/goals');
    const { isAffirmative } = await import('../src/agent/fastLane');
    const LT = await import('../src/agent/longterm');
    const { buildRoutine } = await import('../src/agent/tools/buildRoutine');

    // ── fixtures ─────────────────────────────────────────────────────────────
    const routine: any = {
        routineId: 'r1', title: 't', concern: 'بشرة دهنية', routineType: 'skin', maxBudget: 5000, totalCost: 4400, savings: 600,
        stepsCount: 3, includedRequired: [], requiredNotPlaced: [], usageTips: ['x'],
        steps: [
            { stepNumber: 1, stepName: 'الغسول', category: 'cleanser', usageTime: 'x', howToUse: 'x', whyChosen: 'a — b', product: { id: 'DZ-CLE-DDD-001', brand: 'Delta', name: 'Delta Cleanser', price: 900, currency: 'DZD', claims: [] } },
            { stepNumber: 2, stepName: 'السيروم', category: 'skin_serum', usageTime: 'x', howToUse: 'x', whyChosen: 'a — b', product: { id: 'DZ-SSE-AAA-001', brand: 'Alpha', name: 'Alpha Serum', price: 2000, currency: 'DZD', claims: [] } },
            { stepNumber: 3, stepName: 'المرطب', category: 'lotion_cream', usageTime: 'x', howToUse: 'x', whyChosen: 'a — b', product: { id: 'DZ-LOT-FFF-001', brand: 'Foxtrot', name: 'Foxtrot Cream', price: 1500, currency: 'DZD', claims: [] } },
        ],
    };
    const mkState = (id: string, setup?: (s: any) => void) => {
        const s: any = sessionMemory.getOrCreate(id);
        setup?.(s);
        return s;
    };
    const mkTurnTracker = () => ({ lastProductResults: null, lastProduct: null, lastAnalysis: null, lastRoutine: null, lastBrandEvaluation: null, lastReviewData: null } as any);
    const withProduct = (s: any) => { s.lastProduct = { id: 'DZ-SSE-AAA-001', brand: 'Alpha', name: 'Alpha Serum' }; };
    const withRoutine = (s: any) => { s.lastRoutine = routine; };

    // ── 1. ROUTER ────────────────────────────────────────────────────────────
    section('router intents');
    const routerCases: Array<[string, string, ((s: any) => void) | undefined, string | null, 'high' | 'any']> = [
        ['evaluate', 'قيم لي سيروم Alpha Serum', undefined, 'evaluate_product', 'any'],
        ['brand', 'what do u think about Venus brand', undefined, 'evaluate_brand', 'any'],
        ['reviews', 'واش راي الناس في هذا المنتج', undefined, 'get_community_reviews', 'any'],
        ['routine', 'أريد روتين للبشرة الدهنية بـ 5000 دج', undefined, 'build_routine', 'any'],
        ['contains-ar', 'هل فيه عطر؟', withProduct, 'product_contains', 'high'],
        ['contains-en', 'does it contain alcohol?', withProduct, 'product_contains', 'high'],
        ['contains-fr', "est-ce qu'il contient du rétinol ?", withProduct, 'product_contains', 'high'],
        ['contains-NOT-search', 'أريد سيروم يحتوي على نياسيناميد', withProduct, null, 'any'],
        ['compat-ar', 'هل أستعمل الريتينول مع فيتامين سي؟', undefined, 'check_compatibility', 'high'],
        ['compat-en', 'can I use AHA and retinol together?', undefined, 'check_compatibility', 'high'],
        ['compat-routine', 'هل منتجات روتيني تتعارض؟', withRoutine, 'check_compatibility', 'high'],
        ['alt-ar', 'عندك بديل لهذا المنتج؟', withProduct, 'find_alternatives', 'high'],
        ['alt-cheaper', 'أرخص منه بنفس المفعول', withProduct, 'find_alternatives', 'any'],
        ['alt-en', 'a cheaper dupe of this one', withProduct, 'find_alternatives', 'any'],
        ['edit-swap', 'بدّل الخطوة 2 بشي أرخص', withRoutine, 'modify_routine', 'high'],
        ['edit-remove', 'احذف الواقي', withRoutine, 'modify_routine', 'any'], // tool will report "no such step" and fall back
        ['edit-add', 'أضف تونر للروتين', withRoutine, 'modify_routine', 'high'],
        ['edit-en', 'remove step 3', withRoutine, 'modify_routine', 'high'],
        ['edit-refit', 'خلي الروتين تحت 3000 دج', withRoutine, 'modify_routine', 'any'],
        ['edit-without-routine', 'بدّل الخطوة 2', undefined, null, 'any'],
        ['inci', 'هل هذه التركيبة آمنة؟ Aqua, Niacinamide, Parfum, Glycerin', undefined, 'check_ingredient_list', 'any'],
        ['compare', 'قارن بينهما', undefined, 'compare_products', 'any'],
    ];
    let i = 0;
    for (const [label, msg, setup, expected, conf] of routerCases) {
        const st = mkState(`router-${i++}`, setup);
        const hint = classifyIntent(msg, st);
        if (expected === null) {
            // must NOT be hijacked by the new intents
            ok(!['product_contains', 'check_compatibility', 'modify_routine'].includes(hint.likelyTools[0]), `router ${label}: not a new-intent false positive (got ${hint.likelyTools[0]})`);
        } else {
            ok(hint.likelyTools[0] === expected, `router ${label}: expected ${expected}, got ${hint.likelyTools[0]}`);
            if (conf === 'high') ok(hint.confidence === 'high', `router ${label}: confidence high (got ${hint.confidence})`);
        }
    }

    // ── 2. PARSERS ───────────────────────────────────────────────────────────
    section('parsers');
    ok(parseStepNumber('بدل الخطوة الثانية') === 2, 'step ordinal ar');
    ok(parseStepNumber('change step 3') === 3, 'step number en');
    ok(parseStepNumber("remplace l'étape 1") === 1, 'step number fr');
    ok(parseRoutineEdit('بدّل الخطوة 2 بشي أرخص')?.action === 'swap', 'edit swap');
    ok(parseRoutineEdit('بدّل الخطوة 2 بشي أرخص')?.cheaper === true, 'edit cheaper flag');
    ok(parseRoutineEdit('remove the sunscreen')?.action === 'remove', 'edit remove by category');
    ok(parseRoutineEdit('add a toner')?.action === 'add', 'edit add');
    ok(parseRoutineEdit('make my routine under 3000 DA')?.max_budget === 3000, 'edit refit budget');
    ok(parseRoutineEdit('مرحبا كيف حالك') === null, 'edit: greeting is not an edit');
    ok(isContainsQuestion('هل فيه كحول؟') === true, 'contains ar');
    ok(isContainsQuestion('recommend a serum with niacinamide') === false, 'contains: search is not a question');
    ok(isCompatQuestion('can I mix retinol and vitamin C?', false).yes, 'compat en');
    ok(!isCompatQuestion('what is retinol?', false).yes, 'compat: single concept is not compat');
    ok(detectLang('قيم لي Alpha Serum') === 'ar', 'lang ar with latin name');
    ok(detectLang('est-ce que ce produit est bon pour la peau') === 'fr', 'lang fr');
    ok(detectLang('is this good') === 'en', 'lang en');

    section('follow-ups');
    const last = { query: 'serum', skin_type: 'بشرة دهنية', max_price: 3000 };
    ok(buildSearchRefinement('المزيد', last, 10)?.args.offset === 10, 'more → offset');
    ok(buildSearchRefinement('show me more', last, 10)?.kind === 'more', 'more en');
    ok(buildSearchRefinement('المزيد', last, null)?.kind === 'no_more', 'no more results');
    const r1 = buildSearchRefinement('فقط الجزائرية', last, 10);
    ok(r1?.args.country === 'Algeria' && r1?.args.skin_type === 'بشرة دهنية', 'country refine keeps old filters');
    ok(buildSearchRefinement('تحت 2000', last, 10)?.args.max_price === 2000, 'max price refine');
    ok(buildSearchRefinement('بدون كحول', last, 10)?.args.exclude_ingredients?.includes('كحول'), 'exclusion refine');
    ok(buildSearchRefinement('cheapest', last, 10)?.args.sort_by === 'price_asc', 'cheapest refine');
    ok(buildSearchRefinement('وفي المقابل أريد غسول للبشرة الحساسة', last, 10) === null, 'new category is not a refinement');
    ok(buildSearchRefinement('قيم هذا المنتج', last, 10) === null, 'evaluate is not a refinement');
    ok(buildSearchRefinement('تحت 2000', null, null) === null, 'no previous search → null');

    // ── 3. INGREDIENT KNOWLEDGE ──────────────────────────────────────────────
    section('ingredient knowledge');
    ok(resolveConcept('هل فيه عطر')?.key === 'fragrance', 'عطر → fragrance');
    ok(resolveConcept('vitamin c')?.key === 'vitc', 'vitamin c');
    ok(resolveConcept('ريتينول')?.key === 'retinoid', 'ريتينول');
    ok(resolveAllConcepts('الريتينول مع فيتامين سي').length === 2, 'two concepts in one sentence');
    ok(resolveConcept('aha')?.key === 'aha' && resolveConcept('ahaaa') === null, 'short alias needs word boundary');
    const alc = resolveConcept('alcohol')!;
    ok(matchConceptInList(alc, ['Aqua', 'Cetearyl Alcohol']).length === 0, 'fatty alcohol is NOT drying alcohol');
    ok(matchConceptInList(alc, ['Aqua', 'Alcohol Denat.']).length === 1, 'alcohol denat matches');
    ok(matchConceptInList(resolveConcept('zinc')!, ['Zinc Oxide']).length === 0, 'zinc oxide is not the zinc active');

    // ── 4. TOOLS ─────────────────────────────────────────────────────────────
    section('product_contains');
    let r: any = await productContains({ productId: 'DZ-SSE-AAA-001', ingredient: 'عطر' });
    ok(r.checks?.[0].present && r.checks[0].matches[0].position === 6, 'parfum found at position 6 of 6');
    r = await productContains({ productId: 'DZ-SSE-AAA-001', ingredient: 'كحول' });
    ok(r.checks?.[0].present === false, 'cetearyl alcohol is not flagged as alcohol');
    r = await productContains({ productId: 'DZ-SSE-CCC-003', ingredient: 'alcohol و retinol' });
    ok(r.checks?.length === 2 && r.checks.every((c: any) => c.present), 'two ingredients in one question');
    r = await productContains({ productId: 'DZ-SSE-AAA-001', ingredient: 'parfum', avoid: ['fragrance'] });
    ok(r.anyAvoidHit === true, 'avoid-list hit flagged');
    r = await productContains({ productId: 'NOPE-000', ingredient: 'parfum' });
    ok(!!r.error, 'unknown product → error');

    section('find_alternatives');
    r = await findAlternatives({ productId: 'DZ-SSE-AAA-001' });
    ok(r.products?.[0]?.id === 'DZ-SSE-BBB-002', 'best alt shares niacinamide+zinc');
    ok(r.products?.[0]?.sharedActives?.length >= 2, 'shared actives reported');
    ok(r.products?.[0]?.priceDiffPct === 25, 'price diff 25%');
    ok(!r.products.some((p: any) => p.category !== 'skin_serum'), 'same category only');
    r = await findAlternatives({ productId: 'DZ-SSE-AAA-001', cheaper_only: true });
    ok(r.products.every((p: any) => parseFloat(p.price) < 2000), 'cheaper_only respected');
    r = await findAlternatives({ productId: 'DZ-SSE-AAA-001', avoid: ['alcohol'] });
    ok(!r.products.some((p: any) => p.id === 'DZ-SSE-CCC-003'), 'avoid list is a hard filter');

    section('check_compatibility');
    r = await checkCompatibility({ actives: ['ريتينول', 'vitamin c'] });
    ok(r.overall === 'caution' && r.conflicts.length === 1, 'retinol + vit C → caution');
    ok(r.placement.AM.length === 1 && r.placement.PM.length === 1, 'AM/PM split');
    r = await checkCompatibility({ actives: ['retinol and benzoyl peroxide'] });
    ok(r.overall === 'avoid_together', 'retinol + BPO → avoid together');
    r = await checkCompatibility({ actives: ['niacinamide', 'vitamin c'] });
    ok(r.overall === 'ok' && r.compatibleNotes.length === 1, 'niacinamide + vit C → ok (myth)');
    r = await checkCompatibility({ actives: ['retinol', 'niacinamide'] });
    ok(r.needsSunscreen === true && !!r.pregnancyNote, 'sunscreen + pregnancy notes for retinoid');
    r = await checkCompatibility({ productIds: ['DZ-SSE-CCC-003', 'DZ-SUN-GGG-001'] });
    ok(r.needsSunscreen === false, 'sunscreen present → no reminder');
    r = await checkCompatibility({ actives: ['retinol'] });
    ok(!!r.error, 'single item → error');

    section('modify_routine');
    r = await modifyRoutine(routine, { action: 'swap', step_number: 1, cheaper: true });
    ok(!('error' in r) && r.steps[0].product.id === 'DZ-CLE-EEE-002', 'swap cleanser → cheaper Echo');
    ok(!('error' in r) && r.steps[1].product.id === 'DZ-SSE-AAA-001' && r.steps[2].product.id === 'DZ-LOT-FFF-001', 'other steps untouched');
    ok(!('error' in r) && r.totalCost === 700 + 2000 + 1500, 'total recomputed');
    r = await modifyRoutine(routine, { action: 'swap', step_number: 1, cheaper: true }, { avoid_ingredients: ['betaine'] });
    ok('error' in r, 'avoid list blocks the only cheaper candidate (never relaxed)');
    r = await modifyRoutine(routine, { action: 'remove', category: 'cream' });
    ok(!('error' in r) && r.stepsCount === 2 && r.steps.every((s: any, idx: number) => s.stepNumber === idx + 1), 'remove + renumber');
    r = await modifyRoutine(routine, { action: 'add', category: 'toner', max_budget: 6000 });
    ok(!('error' in r) && r.steps[1].category === 'toner' && r.steps[1].product.id === 'DZ-TON-HHH-001', 'toner inserted right after cleanser');
    r = await modifyRoutine(routine, { action: 'add', category: 'sunscreen', max_budget: 7000 });
    ok(!('error' in r) && r.steps[r.steps.length - 1].category === 'sunscreen', 'sunscreen appended');
    r = await modifyRoutine(routine, { action: 'add', category: 'sunscreen' });
    ok('error' in r, 'add refused when no budget left (600 DZD < 1800)');
    r = await modifyRoutine(routine, { action: 'swap', step_number: 2, replacement: { name: 'Beta Serum' } });
    ok(!('error' in r) && r.steps[1].product.id === 'DZ-SSE-BBB-002', 'swap with a named product');
    r = await modifyRoutine(routine, { action: 'refit', max_budget: 3500 });
    ok(!('error' in r) && r.totalCost <= 4400, 'refit lowers cost where possible');
    r = await modifyRoutine(null, { action: 'remove', step_number: 1 });
    ok('error' in r, 'no routine → error');

    section('search index');
    r = await searchProducts({ category: 'cleanser', exclude_ingredients: ['sulfate'] });
    ok(r.products.length === 1 && r.products[0].id === 'DZ-CLE-EEE-002', 'exclusion uses precomputed ingredient text');
    r = await searchProducts({ country: 'Algeria', category: 'skin_serum', sort_by: 'price_asc' });
    ok(r.products[0].id === 'DZ-SSE-CCC-003', 'price sort');
    r = await searchProducts({ category: 'skin_serum', limit: 2, offset: 0 });
    ok(r.hasMore === true && r.nextOffset === 2, 'pagination info');

    // ── 5. EVALUATION CACHE ──────────────────────────────────────────────────
    section('evaluation cache');
    let calls = 0;
    (globalThis as any).fetch = async () => {
        calls++;
        await new Promise(res => setTimeout(res, 20));
        return { ok: true, json: async () => ({ oilGuardScore: 77, finalVerdict: 'x' }) } as any;
    };
    const payload = { ingredients_list: ['Aqua', 'Glycerin'], product_type: 'serum', selected_claims: [], user_profile: { allergies: [] } };
    const [a, b] = await Promise.all([evaluateProduct(payload), evaluateProduct({ ...payload })]);
    ok(calls === 1 && a.oilGuardScore === 77 && b.oilGuardScore === 77, 'concurrent identical evaluations share ONE fetch');
    await evaluateProduct({ user_profile: { allergies: [] }, selected_claims: [], product_type: 'serum', ingredients_list: ['Aqua', 'Glycerin'] });
    ok(calls === 1, 'key order does not matter; cache hit');
    await evaluateProduct({ ...payload, product_type: 'cream' });
    ok(calls === 2, 'different payload → new fetch');
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ error: 'oops' }) } as any);
    await evaluateProduct({ ...payload, product_type: 'oil' });
    (globalThis as any).fetch = async () => { throw new Error('should not be called'); };
    let threw = false;
    try { await evaluateProduct({ ...payload, product_type: 'oil' }); } catch { threw = true; }
    ok(threw, 'malformed responses are never cached');
    ok(getEvalCacheStats().hits >= 1, 'cache stats track hits');

    // ── 6. FAST LANE ─────────────────────────────────────────────────────────
    section('fast lane');
    const mkTurn = () => ({ lastProductResults: null, lastProduct: null, lastAnalysis: null, lastRoutine: null, lastBrandEvaluation: null, lastReviewData: null } as any);
    {
        const st = mkState('fast-1', (s) => { s.lastSearchArgs = { query: 'serum' }; s.lastSearchNextOffset = null; });
        const texts: string[] = [];
        const res = await tryFastLane({ message: 'المزيد', state: st, turnState: mkTurn(), tools: {}, intent: { likelyTools: [], confidence: 'low', entities: {} }, emitText: t => texts.push(t) });
        ok(res?.tool === 'search_products' && texts.length === 1, 'fast: "more" with no more results answers instantly');
    }
    {
        const st = mkState('fast-2', withRoutine);
        const turn = mkTurn();
        const cards: string[] = [];
        const tools = {
            modify_routine: { execute: async (args: any) => {
                const out: any = await modifyRoutine(st.lastRoutine, args);
                if (out.error) return { error: out.error };
                st.lastRoutine = out; turn.lastRoutine = out;
                return { modification: out.modification, totalCost: out.totalCost };
            } },
        };
        const intent = classifyIntent('بدّل الخطوة 1 بشي أرخص', st);
        const res = await tryFastLane({ message: 'بدّل الخطوة 1 بشي أرخص', state: st, turnState: turn, tools, intent: intent as any, emitCard: (t) => cards.push(t) });
        ok(res?.tool === 'modify_routine' && /Echo/.test(res.text), 'fast: routine swap answered from template');
        ok(cards.includes('routine'), 'fast: routine card emitted');
    }
    {
        const st = mkState('fast-3', withRoutine);
        const turn = mkTurn();
        const tools = { modify_routine: { execute: async () => ({ error: 'nope' }) } };
        const intent = classifyIntent('احذف الخطوة 2', st);
        const res = await tryFastLane({ message: 'احذف الخطوة 2', state: st, turnState: turn, tools, intent: intent as any });
        ok(res === null && turn.lastRoutine === null, 'fast: tool error → null (falls back to LLM) with clean turn state');
    }
    {
        const st = mkState('fast-4');
        const intent = classifyIntent('what do u think about Venus brand and their sunscreen specifically?', st);
        const res = await tryFastLane({ message: 'what do u think about Venus brand and their sunscreen specifically?', state: st, turnState: mkTurn(), tools: {}, intent: intent as any });
        ok(res === null, 'fast: compound questions always go to the LLM');
    }
    {
        const emitted: string[] = [];
        const t = mkTurn(); t.lastCompatibility = { x: 1 };
        emitCardForTool('check_compatibility', t, (type) => emitted.push(type));
        ok(emitted[0] === 'compatibility', 'cards: compatibility card type');
    }


    // ── 7. NEGATION GUARD ────────────────────────────────────────────────────
    section('negation guard');
    const scenario2 = 'اعطيني روتين للبشرة الدهنية بصح ما رانيش حاب واقي شمس، عندي ديجا';
    ok(findNegatedCategories(scenario2).includes('sunscreen'), 'darija: "ما رانيش حاب واقي شمس" → sunscreen excluded');
    ok(findNegatedCategories('I want a routine but not sunscreen').includes('sunscreen'), 'en: "but not sunscreen"');
    ok(findNegatedCategories('une routine sans écran solaire').includes('sunscreen'), 'fr: "sans écran solaire"');
    ok(findNegatedCategories('روتين ماشي واقي شمس').includes('sunscreen'), 'ar: "ماشي واقي شمس"');
    ok(findNegatedCategories('اعطيني روتين مع واقي شمس').length === 0, 'no negation → nothing excluded');
    ok(analyzeNegation('غسول بدون كحول وسيروم').positive.includes('سيروم'), 'prep negation governs only 2 tokens (serum kept)');
    ok(!analyzeNegation('I want a cleanser but not a toner').positive.includes('toner'), 'negated toner removed from positive text');
    ok(analyzeNegation('what do you think about sunscreen').positive.includes('sunscreen'), 'positive mention kept');
    ok(isPhraseNegated('ما نبغيش روتين', /روتين/) === true, 'negated intent word detected');
    ok(isPhraseNegated('أريد روتين', /روتين/) === false, 'positive intent word not negated');
    {
        const st = mkState('neg-1');
        const h = classifyIntent(scenario2, st);
        ok(h.likelyTools[0] === 'build_routine', `router: routine request still routes to build_routine (got ${h.likelyTools[0]})`);
        ok(h.entities.category === undefined, 'router: negated sunscreen is NOT the category entity');
        ok(h.entities.excludeCategories?.includes('sunscreen') === true, 'router: excludeCategories carries sunscreen');
        const h2 = classifyIntent('ما نبغيش روتين، نبغي غسول', mkState('neg-2'));
        ok(!h2.likelyTools.includes('build_routine'), 'router: negated "routine" intent is dropped');
    }

    // ── 8. ROUTINE BUILDER HONORS EXCLUSIONS ─────────────────────────────────
    section('build_routine exclude_categories');
    {
        const base: any = await buildRoutine({ target_concern: 'بشرة دهنية', max_budget: 9000 });
        const withoutSun: any = await buildRoutine({ target_concern: 'بشرة دهنية', max_budget: 9000, exclude_categories: ['sunscreen'] });
        ok(!('error' in base) && base.steps.some((x: any) => x.category === 'sunscreen'), 'baseline routine includes sunscreen at 9000 DZD');
        ok(!('error' in withoutSun) && !withoutSun.steps.some((x: any) => x.category === 'sunscreen'), 'excluded sunscreen is absent');
        ok(!('error' in withoutSun) && withoutSun.skippedByRequest?.length === 1 && withoutSun.usageTips.some((t: string) => /كما طلبت/.test(t)), 'exclusion reported honestly');
    }

    // ── 9. ACTIVE MISSION ────────────────────────────────────────────────────
    section('active mission');
    {
        const st: any = mkState('mission-1'); st.turnCount = 3;
        updateMissionAfterTurn(st, scenario2, { ...mkTurnTracker(), lastRoutine: { ...routine, concern: 'بشرة دهنية', maxBudget: 4000 } });
        ok(st.mission?.kind === 'routine' && st.mission.budget === 4000, 'routine → routine mission with budget');
        ok(st.mission.excluded?.includes('sunscreen'), 'mission remembers the exclusion');
        const detour = buildMissionContext(st, true) || '';
        ok(/SIDE QUESTION/.test(detour) && /budget<=4000/.test(detour), 'detour context bridges back to the mission');
        ok(!/SIDE QUESTION/.test(buildMissionContext(st, false) || ''), 'non-detour context is short');
        updateMissionAfterTurn(st, 'صح حمض الكوجيك يقشر البشرة؟', mkTurnTracker());
        ok(!!activeMission(st), 'a detour (no tools) does not clear the mission');
        st.turnCount = 12;
        ok(activeMission(st) === null, 'mission expires after the TTL');
        st.turnCount = 3;
        updateMissionAfterTurn(st, 'شكراً', mkTurnTracker());
        ok(st.mission === null, 'closing message ends the mission');
        ok(isClosingMessage('thanks') && isClosingMessage("c'est tout") && !isClosingMessage('thanks, but what about retinol?'), 'closing-message detector');

        const st2: any = mkState('mission-2'); st2.turnCount = 2;
        st2.lastSearchArgs = { skin_type: 'بشرة دهنية', marketing_claims: ['تفتيح البقع الداكنة'], max_price: 3500 };
        updateMissionAfterTurn(st2, 'أبحث عن علاج للبقع الداكنة بميزانية 3500', { ...mkTurnTracker(), lastProductResults: [{ id: 'x' }] });
        ok(st2.mission?.kind === 'search' && st2.mission.budget === 3500, 'concern search → search mission');
        const st3: any = mkState('mission-3'); st3.turnCount = 2;
        updateMissionAfterTurn(st3, 'قيم هذا', { ...mkTurnTracker(), lastAnalysis: { productId: 'x' } });
        ok(!st3.mission, 'a plain evaluation creates no mission');
    }

    // ── 10. CORRECTIONS ──────────────────────────────────────────────────────
    section('graceful corrections');
    const corrMsg = 'لا، قصدي الغسول تاعهم مش السيروم!';
    const corrState = (id: string, evaluated: boolean) => mkState(id, (s) => {
        s.turnCount = 3;
        s.lastAnalysis = { brand: 'Delta', productId: 'DZ-SSE-DDD-004', name: 'Delta Serum' };
        s.productHistory = [{ id: 'DZ-SSE-DDD-004', brand: 'Delta', name: 'Delta Serum', turn: evaluated ? 2 : 1, source: evaluated ? 'analysis' : 'search' }];
    });
    {
        const st = corrState('corr-1', true);
        const c = detectCorrection(corrMsg, st);
        ok(c?.category === 'cleanser', `correction detected, category from POSITIVE text only (got ${c?.category})`);
        ok(detectCorrection("no, I meant their cleanser", st)?.category === 'cleanser', 'correction en');
        ok(detectCorrection('قيم هذا المنتج', st) === null, 'normal message is not a correction');
        ok(detectCorrection(corrMsg, mkState('corr-fresh', (s) => { s.turnCount = 1; })) === null, 'no context → no correction');
        const h = classifyIntent(corrMsg, st);
        ok(h.likelyTools[0] === 'evaluate_product' && h.confidence === 'high', `router pivots to evaluate_product (got ${h.likelyTools[0]}/${h.confidence})`);

        // fast lane: instant pivot, no apology paragraph, offer queued
        const turn: any = mkTurnTracker(); const cards: string[] = [];
        const tools: any = {
            evaluate_product: { execute: async (a: any) => {
                turn.lastAnalysis = { evaluation: {}, productId: a.productId, name: 'Delta Cleanser', brand: 'Delta' };
                return { productId: a.productId, name: 'Delta Cleanser', brand: 'Delta', oilGuardScore: 81, finalVerdict: 'جيد', safetyScore: 80, efficacyScore: 70, claimsSummary: [] };
            } },
        };
        const res = await tryFastLane({ message: corrMsg, state: st, turnState: turn, tools, intent: h as any, emitCard: (t) => cards.push(t) });
        ok(res?.tool === 'evaluate_product' && res.text.startsWith('عذراً —') && /Delta Cleanser/.test(res.text), 'fast: instant pivot with ONE short apology word');
        ok(res!.text.split('عذراً').length === 2 && !/أعتذر/.test(res!.text), 'fast: no repeated/defensive apology');
        ok(cards.includes('product_analysis'), 'fast: cleanser card shown immediately');
        ok(st.pendingOffer?.tool === 'find_alternatives', 'fast: proactive next step queued');

        const st2 = corrState('corr-2', false);
        const turn2: any = mkTurnTracker();
        const tools2: any = { search_products: { execute: async () => { turn2.lastProductResults = [{ id: 'a' }, { id: 'b' }]; return { returnedCount: 2, foundCount: 2, relaxedFilters: [] }; } } };
        const res2 = await tryFastLane({ message: corrMsg, state: st2, turnState: turn2, tools: tools2, intent: classifyIntent(corrMsg, st2) as any });
        ok(res2?.tool === 'search_products' && /Delta/.test(res2.text), 'fast: non-evaluation context pivots to the brand\'s category products');
    }

    // ── 11. PROACTIVE OFFERS ─────────────────────────────────────────────────
    section('proactive next step');
    ok(isAffirmative('نعم') && isAffirmative('yes please') && isAffirmative('oui') && isAffirmative('أكيد'), 'affirmatives');
    ok(!isAffirmative('نعم قارن بينهما') && !isAffirmative('what is retinol') && !isAffirmative(''), 'non-affirmatives');
    {
        const st: any = mkState('offer-1'); st.turnCount = 5;
        st.pendingOffer = { tool: 'find_alternatives', args: { productId: 'DZ-SSE-AAA-001' }, turn: 4 };
        const turn: any = mkTurnTracker(); const cards: string[] = [];
        const tools: any = { find_alternatives: { execute: async (a: any) => {
            turn.lastProductResults = [{ id: 'DZ-SSE-BBB-002', brand: 'Beta', name: 'Beta Serum', sharedActives: ['النياسيناميد'], priceDiffPct: 25 }];
            return { reference: { id: a.productId, brand: 'Alpha', name: 'Alpha Serum' }, weakMatch: false };
        } } };
        const res = await tryFastLane({ message: 'نعم', state: st, turnState: turn, tools, intent: { likelyTools: [], confidence: 'low', entities: {} }, emitCard: (t) => cards.push(t) });
        ok(res?.tool === 'find_alternatives' && cards.includes('product_results'), 'bare "yes" executes the offered tool with no model call');
        ok(st.pendingOffer?.tool === 'compare_products', 'the answer queues the next offer (compare original vs alternative)');

        const st2: any = mkState('offer-2'); st2.turnCount = 9;
        st2.pendingOffer = { tool: 'find_alternatives', args: {}, turn: 4 };      // stale
        const r2 = await tryFastLane({ message: 'نعم', state: st2, turnState: mkTurnTracker(), tools, intent: { likelyTools: [], confidence: 'low', entities: {} } });
        ok(r2 === null, 'a stale offer is ignored');
    }

    // ── 12. OPT-IN LONG-TERM MEMORY ──────────────────────────────────────────
    section('long-term memory');
    {
        ok(LT.LONGTERM_ENABLED === true, 'enabled via env in tests');
        const profile: any = { concerns: [], allergies: ['عطر'], avoidIngredients: [], preferredBrands: ['x'], skinType: 'بشرة دهنية', budgetMax: 4000, country: 'Algeria', language: 'ar' };
        const facts = LT.extractDurableFacts(profile);
        ok(!('preferredBrands' in facts) && !('concerns' in facts), 'only durable facts are extracted');
        LT.saveFacts('user-123', facts);
        const loaded = LT.loadFacts('user-123');
        ok(loaded?.skinType === 'بشرة دهنية' && loaded.allergies?.[0] === 'عطر' && loaded.budgetMax === 4000, 'facts round-trip');
        const raw = fs.readFileSync(process.env.LONGTERM_FILE!, 'utf-8');
        ok(!raw.includes('user-123'), 'raw userId is never written (hashed)');
        ok((fs.statSync(process.env.LONGTERM_FILE!).mode & 0o777) === 0o600, 'file mode is 0600');
        ok(LT.loadFacts('someone-else') === null, 'other users see nothing');

        const fresh: any = { concerns: [], allergies: [], avoidIngredients: [], preferredBrands: [], skinType: 'بشرة جافة' };
        LT.applyFactsToProfile(fresh, loaded!);
        ok(fresh.skinType === 'بشرة جافة' && fresh.allergies.includes('عطر') && fresh.budgetMax === 4000, 'saved facts fill gaps but never override what the user said now');
        ok(/أهلاً بعودتك/.test(LT.welcomeBackNote('ar', loaded!)) && /Welcome back/.test(LT.welcomeBackNote('en', loaded!)), 'welcome-back note ar/en');

        const before = fs.readFileSync(process.env.LONGTERM_FILE!, 'utf-8').length;
        LT.saveFacts('user-123', facts);
        ok(fs.readFileSync(process.env.LONGTERM_FILE!, 'utf-8').length === before, 'unchanged facts are not re-written');
        LT.saveFacts('user-123', { ...facts, allergies: Array.from({ length: 30 }, (_, i) => `allergen-${i}`) as any });
        ok((LT.loadFacts('user-123')?.allergies || []).length <= 30, 'save accepted');
        const longList = LT.extractDurableFacts({ ...profile, allergies: Array.from({ length: 30 }, (_, i) => `allergen-${i}`) });
        ok((longList.allergies || []).length === 10, 'lists are capped at 10 entries');

        ok(LT.FORGET_RE.test('انسَ كل شيء') && LT.FORGET_RE.test('please forget me') && LT.FORGET_RE.test('oublie-moi') && !LT.FORGET_RE.test('I forgot my password'), 'forget phrases');
        ok(LT.forgetUser('user-123') === true && LT.loadFacts('user-123') === null, 'forgetUser erases everything');
        ok(!fs.readFileSync(process.env.LONGTERM_FILE!, 'utf-8').includes('allergen'), 'erased data is gone from the file');
    }


    // ── 13. END-TO-END (fast lane only, no model) ────────────────────────────
    section('end-to-end: returning user → contains → "yes" → forget');
    {
        const { processChat } = await import('../src/agent/agent');
        LT.saveFacts('u9', { skinType: 'بشرة دهنية', allergies: ['عطر'] });
        const st: any = mkState('e2e-1'); st.lastProduct = { id: 'DZ-SSE-AAA-001', brand: 'Alpha', name: 'Alpha Serum' };
        const r1: any = await processChat({ message: 'هل فيه عطر؟', sessionId: 'e2e-1', userId: 'u9', rememberMe: true } as any);
        ok(r1.lane === 'fast', `e2e: contains question answered by the fast lane (lane=${r1.lane})`);
        ok(/أهلاً بعودتك/.test(r1.message || ''), 'e2e: welcome-back shown once for a returning user');
        ok(/Parfum/.test(r1.message || '') && /تتجنبه/.test(r1.message || ''), 'e2e: full-list check + avoid-list warning');
        ok(/بدائل خالية منه/.test(r1.message || ''), 'e2e: ONE proactive next step appended');
        const r2: any = await processChat({ message: 'نعم', sessionId: 'e2e-1', userId: 'u9', rememberMe: true } as any);
        ok(r2.lane === 'fast' && /Beta Serum/.test(r2.message || ''), 'e2e: bare "yes" runs the offered alternatives search');
        ok(!/أهلاً بعودتك/.test(r2.message || ''), 'e2e: welcome-back is not repeated');
        await processChat({ message: 'انسَ كل شيء', sessionId: 'e2e-1', userId: 'u9', rememberMe: true } as any);
        ok(LT.loadFacts('u9') === null, 'e2e: "forget everything" erases stored facts');
    }

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
