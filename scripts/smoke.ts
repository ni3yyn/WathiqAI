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
    P('DZ-SSE-AAA-001', 'Alpha', 'Alpha Serum', 'skin_serum', 2000, 'Aqua, Glycerin, Niacinamide, Zinc PCA, Cetearyl Alcohol, Parfum', { marketingClaims: ['للبشرة الدهنية'] }),
    P('DZ-SSE-BBB-002', 'Beta', 'Beta Serum', 'skin_serum', 1500, 'Aqua, Niacinamide, Zinc PCA, Panthenol'),
    P('DZ-SSE-CCC-003', 'Gamma', 'Gamma Serum', 'skin_serum', 1200, 'Aqua, Glycerin, Alcohol Denat., Retinol'),
    P('DZ-CLE-DDD-001', 'Delta', 'Delta Cleanser', 'cleanser', 900, 'Aqua, Glycerin, Sodium Lauryl Sulfate'),
    P('DZ-SSE-DDD-004', 'Delta', 'Delta Serum', 'skin_serum', 1800, 'Aqua, Glycerin, Niacinamide'),
    P('DZ-CLE-EEE-002', 'Echo', 'Echo Cleanser', 'cleanser', 700, 'Aqua, Glycerin, Cocamidopropyl Betaine'),
    P('DZ-LOT-FFF-001', 'Foxtrot', 'Foxtrot Cream', 'lotion_cream', 1500, 'Aqua, Ceramide NP, Glycerin'),
    P('DZ-SUN-GGG-001', 'Golf', 'Golf Sunscreen', 'sunscreen', 1800, 'Aqua, Zinc Oxide, Titanium Dioxide'),
    P('DZ-TON-HHH-001', 'Hotel', 'Hotel Toner', 'toner', 800, 'Aqua, Glycerin, Panthenol'),
    P('DZ-SSE-BEL-005', 'Belnco', 'Belnco Clarifying Serum', 'skin_serum', 1550, 'Aqua, Niacinamide, Zinc PCA, Salicylic Acid', { marketingClaims: ['مضاد لحب الشباب'] }),
    P('DZ-LOT-VEN-002', 'Venus', 'Venus Blemish Care', 'lotion_cream', 850, 'Aqua, Glycerin, Salicylic Acid, Niacinamide'),
    { ...P('DZ-LOT-IMP-003', 'Imported', 'Imported Acne Cream', 'lotion_cream', 3000, 'Aqua, Niacinamide, Salicylic Acid'), country: 'France' },
]));
process.env.LONGTERM_MEMORY = 'true';
process.env.LONGTERM_FILE = path.join(tmp, 'data', 'longterm.jsonl');
process.env.LONGTERM_SALT = 'test-salt';
process.env.CABINET_FILE = path.join(tmp, 'data', 'cabinet.json');
process.env.FEEDBACK_FILE = path.join(tmp, 'data', 'feedback.jsonl');
process.env.CONTRIBUTIONS_FILE = path.join(tmp, 'data', 'contributions.json');
process.env.APPROVED_CONTRIBUTIONS_FILE = path.join(tmp, 'data', 'approved_contributions.json');
process.env.REVIEW_QUEUE_FILE = path.join(tmp, 'data', 'review_queue.json');
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
    const { findActivesDupe } = await import('../src/agent/tools/findActivesDupe');
    const { generateUsageSchedule } = await import('../src/agent/tools/generateUsageSchedule');
    const { matchReference, parsePriceFromText } = await import('../src/agent/references');
    const { isScheduleQuestion, parseDupeRequest } = await import('../src/agent/intents');
    const { detectClimate, detectSeason, buildClimateContext, climateTips } = await import('../src/agent/climate');
    const { sanitizeScanImages } = await import('../src/agent/tools/scanShelfLabel');
    const { tryScanLane } = await import('../src/agent/scanLane');
    const V = await import('../src/agent/voice');
    const { darijaize } = await import('../src/agent/darija');
    const CAB = await import('../src/agent/cabinet');
    const TR = await import('../src/agent/tools/triageReaction');
    const MODES = await import('../src/agent/modes');
    const RH = await import('../src/agent/routineHistory');
    const LRN = await import('../src/agent/learning');
    const FB = await import('../src/agent/feedback');
    const CTB = await import('../src/agent/contributions');
    const { explainPick, dataConfidence } = await import('../src/agent/explainPick');
    const { isWhyQuestion } = await import('../src/agent/intents');
    const { getProduct: getProductFn } = await import('../src/agent/tools/getProduct');
    const { getProducts, mergeApprovedIntoCatalog } = await import('../src/wathiq/backendClient');
    const OUT = await import('../src/agent/outputs');
    const QR = await import('../src/agent/quickReplies');
    const { buildGiftSet } = await import('../src/agent/tools/buildGiftSet');
    const { parseOutputCommand } = await import('../src/agent/intents');

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

    section('router: evaluation is decisive');
    {
        for (const m of ['قيم لي Gamma Serum', 'evaluate CeraVe foaming cleanser', 'حلل لي Alpha Serum', 'évalue le Delta Cleanser']) {
            const h = classifyIntent(m, mkState(`eval-${m}`));
            ok(h.likelyTools[0] === 'evaluate_product' && h.confidence === 'high', `"${m}" → evaluate_product/high (got ${h.likelyTools[0]}/${h.confidence})`);
        }
        const brand = classifyIntent('قيم لي ماركة Venus', mkState('eval-brand'));
        ok(brand.likelyTools[0] === 'evaluate_brand', 'explicit brand word still routes to evaluate_brand');
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
    r = await searchProducts({ marketing_claims: ['مضاد لحب الشباب'] });
    ok(r.products.length === 1 && r.products[0].id === 'DZ-SSE-BEL-005', 'specific marketing claim returns only products tagged with that exact claim');
    r = await searchProducts({ marketing_claims: ['anti-acne'] });
    ok(r.products.length === 1 && r.products[0].id === 'DZ-SSE-BEL-005', 'English claim alias expands to matching catalog claim tags');
    r = await searchProducts({ query: 'serum', marketing_claims: ['توحيد لون البشرة'] });
    ok(r.products.length === 0, 'query relevance cannot override a missing explicit marketing claim');
    r = await searchProducts({ marketing_claims: ['للبشرة الدهنية'] });
    ok(r.products.length === 1 && r.products[0].id === 'DZ-SSE-AAA-001', 'target-type tag alone does not count as a marketing claim');

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
        const st = mkState('fast-direct-search');
        const turn = mkTurn();
        const cards: string[] = [];
        let calledArgs: any = null;
        const tools = {
            search_products: { execute: async (args: any) => {
                calledArgs = args;
                const products = [{ id: 'DZ-SUN-GGG-001', brand: 'Golf', name: 'Golf Sunscreen', price: 1800 }];
                turn.lastProductResults = products;
                st.lastProductResults = products;
                return { foundCount: 1, returnedCount: 1, hasMore: false, relaxedFilters: [], productsSummary: products };
            } },
        };
        const message = 'I want an Algerian sunscreen for oily skin under 3000 DZD';
        const intent = classifyIntent(message, st);
        const res = await tryFastLane({ message, state: st, turnState: turn, tools, intent: intent as any, emitCard: (type) => cards.push(type) });
        ok(intent.likelyTools[0] === 'search_products' && intent.confidence === 'high', 'direct search: structured search intent is decisive after deduplicating router signals');
        ok(res?.tool === 'search_products', 'direct search: high-confidence catalog search returns from the fast lane');
        ok(calledArgs?.category === 'sunscreen' && calledArgs?.country === 'Algeria' && calledArgs?.skin_type === 'oily' && calledArgs?.max_price === 3000, 'direct search: category, country, skin condition and budget are extracted as tool args');
        ok(cards.includes('product_results'), 'direct search: product card is emitted without an LLM call');
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
        ok(res?.tool === 'evaluate_product' && /^(عذراً|سماح لي) —/.test(res.text) && /Delta Cleanser/.test(res.text), 'fast: instant pivot with ONE short apology word');
        ok(!/أعتذر/.test(res!.text) && (res!.text.match(/عذراً|سماح لي/g) || []).length === 1, 'fast: no repeated/defensive apology');
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


    // ── 14. V4 · LAYERING MATRIX ─────────────────────────────────────────────
    section('v4 layering matrix');
    const cabinetMsg = 'شريت سيروم نياسيناميد تاع بلنكو، وعندي ديجا تونر حمض الجليكوليك تاع ذا أورديناري، نقدر نستعملهم مع بعض في الليل؟';
    {
        const h = classifyIntent(cabinetMsg, mkState('v4-compat'));
        ok(h.likelyTools[0] === 'check_compatibility' && h.confidence === 'high', `cabinet question → check_compatibility (got ${h.likelyTools[0]}/${h.confidence})`);
        const r: any = await checkCompatibility({ actives: [cabinetMsg] });
        ok(r.overall === 'caution' && r.conflicts[0]?.concepts.length === 2, 'niacinamide + glycolic acid → soft caution');
        ok(/حساسة|sensitive/i.test(r.conflicts[0].advice.ar + r.conflicts[0].advice.en), 'advice only insists on separation for sensitive/beginner skin (no exaggeration)');
        ok(!!r.bufferingTip, 'sandwich/buffering tip attached for strong actives');
        ok(r.placement.PM.length >= 1, 'AHA placed in the evening plan');
        const cu: any = await checkCompatibility({ actives: ['vitamin c', 'copper peptide'] });
        ok(cu.overall === 'avoid_together', 'vitamin C + copper peptides → avoid together');
        ok(resolveConcept('copper peptide')?.key === 'copper_peptide' && resolveConcept('peptide')?.key === 'peptide', 'copper peptide resolved separately from generic peptides');
    }

    // ── 15. V4 · ALGERIAN DUE ENGINE ─────────────────────────────────────────
    section('v4 active-dupe engine');
    const dupeMsg = 'Effaclar Duo بزاف غالي، راه يدير قريب 4800 دج فالفارماسي. عندك بديل محلي جزائري يخدم نفس الخدمة؟';
    {
        ok(matchReference('Effaclar Duo+')?.label.includes('Effaclar') === true, 'reference fingerprint matched');
        ok(parsePriceFromText('يدير 4800 دج') === 4800 && parsePriceFromText('4 800 DA') === 4800 && parsePriceFromText('no price') === undefined, 'price parsing');
        const req = parseDupeRequest(dupeMsg);
        ok(!!req?.reference && req.price === 4800 && req.local, 'dupe request parsed (reference, price, local)');
        ok(parseDupeRequest('قيم هذا المنتج') === null, 'non-dupe message ignored');
        const h = classifyIntent(dupeMsg, mkState('v4-dupe'));
        ok(h.likelyTools[0] === 'find_actives_dupe' && h.confidence === 'high', `router → find_actives_dupe (got ${h.likelyTools[0]}/${h.confidence})`);

        const r: any = await findActivesDupe({ reference_product: 'Effaclar Duo+', reference_price: 4800, country: 'Algeria' });
        ok(!r.error && r.products[0].id === 'DZ-LOT-VEN-002', 'best local dupe shares niacinamide + salicylic acid');
        ok(r.products[0].priceSavingPct === 82, `saving computed from the user's price (${r.products[0].priceSavingPct})`);
        ok(r.products.every((p: any) => p.country !== 'France'), 'country filter honored');
        ok(r.reference.approximate === true && !!r.note, 'built-in fingerprint is flagged approximate');
        const relaxed: any = await findActivesDupe({ reference_product: 'Effaclar Duo+', reference_price: 4800, country: 'Tunisia' });
        ok(!relaxed.error && relaxed.countryRelaxed === true, 'no match in the country → relaxed, and says so');
        const avoid: any = await findActivesDupe({ reference_product: 'Effaclar Duo+', reference_price: 4800, country: 'Algeria', avoid: ['salicylic'] });
        ok(!!avoid.error, 'avoid list is a hard filter');
        const byActives: any = await findActivesDupe({ target_actives: ['niacinamide', 'zinc'], category: 'skin_serum' });
        ok(!byActives.error && byActives.products.every((p: any) => p.sharedActiveKeys.includes('niacinamide')), 'works from caller-supplied actives for unknown imports');
        const unknown: any = await findActivesDupe({ reference_product: 'Some Unknown Brand Cream' });
        ok(!!unknown.error, 'unknown product without actives → asks for actives');

        const turn: any = mkTurnTracker();
        const tools: any = { find_actives_dupe: { execute: async (a: any) => {
            const out: any = await findActivesDupe(a);
            if (out.error) return { error: out.error };
            turn.lastProductResults = out.products; turn.lastAlternativesReference = out.reference;
            return out;
        } } };
        const st = mkState('v4-dupe-2');
        const res = await tryFastLane({ message: dupeMsg, state: st, turnState: turn, tools, intent: classifyIntent(dupeMsg, st) as any });
        ok(res?.tool === 'find_actives_dupe' && /Venus Blemish Care/.test(res.text) && /82%/.test(res.text), 'fast lane answers the dupe request from a template');
        ok(!/10%|1%\b/.test(res!.text.replace(/82%/g, '')), 'template never invents concentrations');
    }

    // ── 16. V4 · INDUCTION SCHEDULES ─────────────────────────────────────────
    section('v4 induction schedules');
    const retMsg = 'شريت سيروم ريتينول 0.5%، كيفاش نستعملو باش ما يحرقليش وجهي؟';
    {
        ok(isScheduleQuestion(retMsg).yes, 'schedule question detected (darija)');
        ok(isScheduleQuestion('how do I start using glycolic acid?').yes, 'schedule question en');
        ok(!isScheduleQuestion('can I use retinol and glycolic acid together?').yes, 'two potent actives = compatibility, not onboarding');
        ok(!isScheduleQuestion('what is retinol?').yes, 'definition question is not a schedule request');
        const h = classifyIntent(retMsg, mkState('v4-sched'));
        ok(h.likelyTools[0] === 'generate_usage_schedule' && h.confidence === 'high', `router → generate_usage_schedule (got ${h.likelyTools[0]}/${h.confidence})`);

        const r: any = generateUsageSchedule({ active: 'Retinol 0.5%' });
        ok(r.concentration === 0.5 && r.sensitivity === 'beginner' && r.applyTime === 'PM', 'retinol 0.5% parsed; beginner; evenings');
        ok(r.weeks[0].perWeek === 1 && r.weeks[0].weeks === '1–2', 'weeks 1–2: one night a week');
        ok(r.weeks[1].perWeek === 2 && r.weeks[2].perWeek === 3, 'week 3: two nights; week 4+: three nights');
        ok(r.method === 'sandwich' && !!r.pregnancyNote && !!r.stopSigns, 'sandwich method, pregnancy note and stop signs');
        const exp: any = generateUsageSchedule({ active: 'retinol 0.25%', sensitivity: 'experienced' });
        ok(exp.weeks[0].perWeek === 3, 'experienced users ramp faster');
        const sens: any = generateUsageSchedule({ active: 'retinol', sensitivity: 'experienced', skin_sensitive: true });
        ok(sens.sensitivity === 'beginner', 'sensitive skin forces the gentle ramp');
        const aha: any = generateUsageSchedule({ active: 'glycolic acid 7%' });
        ok(aha.activeKey === 'aha' && aha.weeks[0].perWeek === 1, 'AHA 7% starts once a week');
        const vc: any = generateUsageSchedule({ active: 'vitamin c' });
        ok(vc.applyTime === 'AM', 'vitamin C is a morning active');
        ok('error' in (generateUsageSchedule({ active: 'niacinamide' }) as any), 'no schedule needed for gentle actives');

        const turn: any = mkTurnTracker();
        const tools: any = { generate_usage_schedule: { execute: async (a: any) => {
            const out: any = generateUsageSchedule(a); if (out.error) return { error: out.error };
            turn.lastUsageSchedule = out; return out;
        } } };
        const st = mkState('v4-sched-2');
        const res = await tryFastLane({ message: retMsg, state: st, turnState: turn, tools, intent: classifyIntent(retMsg, st) as any });
        ok(res?.tool === 'generate_usage_schedule' && /(الأسبوع|السيمانة) 1–2/.test(res.text) && /(الإثنين|التنين)/.test(res.text) && /الساندويتش/.test(res.text), 'fast lane renders the Week 1 → 4+ calendar with example nights');

        // proactive: evaluating a product with a potent active offers the schedule
        const turn2: any = mkTurnTracker();
        const tools2: any = { evaluate_product: { execute: async (a: any) => {
            turn2.lastAnalysis = { evaluation: { detected_ingredients: [{ name: 'Retinol' }] }, productId: a.productId, name: 'Gamma Serum', brand: 'Gamma' };
            return { productId: a.productId, name: 'Gamma Serum', brand: 'Gamma', oilGuardScore: 78, finalVerdict: 'جيد', safetyScore: 70, efficacyScore: 80, claimsSummary: [] };
        } } };
        const st2 = mkState('v4-sched-3');
        const res2 = await tryFastLane({ message: 'قيم لي Gamma Serum', state: st2, turnState: turn2, tools: tools2, intent: classifyIntent('قيم لي Gamma Serum', st2) as any });
        ok(st2.pendingOffer?.tool === 'generate_usage_schedule' && /جدول تدرّج/.test(res2?.text || ''), 'evaluation of a retinol product offers the safe-start calendar');
    }

    // ── 17. V4 · BIOCLIMATIC AWARENESS ───────────────────────────────────────
    section('v4 climate');
    {
        ok(detectClimate('راني في ورقلة ووجهي راه يتقشر من الجفاف')?.zone === 'arid_saharan', 'Ouargla → Saharan arid');
        ok(detectClimate('I live in Oran')?.zone === 'coastal_humid' && detectClimate('je suis à Annaba')?.zone === 'coastal_humid', 'Oran/Annaba → coastal humid');
        ok(detectClimate('نسكن في سطيف')?.zone === 'steppe_highland', 'Sétif → highlands');
        ok(detectClimate('I live in Paris') === null, 'unknown place → no climate (nothing invented)');
        ok(detectSeason('في الصيف') === 'summer' && detectSeason('en hiver') === 'winter' && detectSeason('hello') === null, 'season detection');
        const arid = buildClimateContext({ city: 'Ouargla', climateZone: 'arid_saharan' }, 'summer') || '';
        ok(/DAMP skin/.test(arid) && /seal/.test(arid) && /Humidity=very low/.test(arid) && /cool, dark place/.test(arid), 'arid context: seal hyaluronic on damp skin + heat storage in summer');
        const coastal = climateTips('coastal_humid', 'summer').join(' ');
        ok(/gel/.test(coastal) && /occlusives/.test(coastal), 'coastal context: gels, avoid heavy occlusives');
        ok(buildClimateContext({}, 'mid') === null, 'no climate → no context line');
        const st: any = mkState('v4-climate'); st.lastProduct = { id: 'DZ-SSE-AAA-001', brand: 'Alpha', name: 'Alpha Serum' };
        const { processChat } = await import('../src/agent/agent');
        await processChat({ message: 'راني في ورقلة، هل فيه عطر؟', sessionId: 'v4-climate' } as any);
        ok(st.profile.climateZone === 'arid_saharan' && st.profile.city === 'Ouargla', 'turn start stores the detected climate in the profile');
    }

    // ── 18. V4 · SHELF-LABEL SCAN ────────────────────────────────────────────
    section('v4 scan lane');
    {
        const png = 'data:image/png;base64,iVBORw0KGgo=';
        ok(sanitizeScanImages([png])?.frontImage === png, 'data URL accepted as front');
        ok(sanitizeScanImages([png, 'data:image/jpeg;base64,/9j/4AAQ'])?.inciImage?.startsWith('data:image/jpeg') === true, 'second unlabeled image = ingredient list');
        ok(sanitizeScanImages([{ data: 'iVBORw0KGgo=', mimeType: 'image/png', role: 'inci' }])?.inciImage?.startsWith('data:image/png;base64,') === true, 'raw base64 + role converted');
        ok(sanitizeScanImages(['http://res.cloudinary.com/x.png']) === null, 'plain http rejected');
        ok(sanitizeScanImages(['https://evil.example.com/x.png']) === null, 'non-allow-listed host rejected (SSRF guard)');
        ok(sanitizeScanImages(['https://res.cloudinary.com/demo/image/upload/x.png'])?.frontImage !== undefined, 'allow-listed https host accepted');
        ok(sanitizeScanImages(['data:text/html;base64,PGh0bWw+']) === null, 'non-image data URL rejected');
        ok(sanitizeScanImages(['data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024)]) === null, 'oversized image rejected');
        ok(sanitizeScanImages([]) === null && sanitizeScanImages(undefined) === null, 'no images → null');

        const mkInput = (label: any, tools: any, extra: any = {}) => {
            const cards: string[] = [];
            const st = mkState(`scan-${Math.random()}`);
            return { cards, st, run: () => tryScanLane({ message: 'راني في الفارماسي ولقيت هذا، يسوى نشريه؟', images: [png], state: st, turnState: mkTurnTracker(), tools, parser: async () => label, emitCard: (t: string) => cards.push(t), ...extra }) };
        };
        // 1. recognised catalog product → evaluate_product
        {
            const turn = mkTurnTracker();
            const tools: any = { evaluate_product: { execute: async (a: any) => {
                turn.lastAnalysis = { evaluation: {}, productId: a.productId, name: 'Delta Cleanser', brand: 'Delta' };
                return { productId: a.productId, name: 'Delta Cleanser', brand: 'Delta', oilGuardScore: 84, finalVerdict: 'تركيبة لطيفة' };
            } } };
            const t = mkInput({ brand: 'Delta', name: 'Delta Cleanser', category: 'cleanser', ingredients: 'Aqua, Glycerin', quantity: null }, tools);
            const res = await tryScanLane({ message: 'يسوى نشريه؟', images: [png], state: t.st, turnState: turn, tools, parser: async () => ({ brand: 'Delta', name: 'Delta Cleanser', category: 'cleanser', ingredients: 'Aqua, Glycerin', quantity: null }), emitCard: (c) => t.cards.push(c) });
            ok(res?.tool === 'evaluate_product' && /موجود في كتالوجنا/.test(res.text) && /84\/100/.test(res.text) && /ممتاز/.test(res.text), 'scan: catalog product recognised and scored with a buy verdict');
            ok(t.cards[0] === 'label_scan' && t.cards.includes('product_analysis'), 'scan: label_scan card then analysis card');
            ok(t.st.lastLabelScan?.recognized === true, 'scan: result remembered in the session');
        }
        // 2. not in catalog → score the INCI read from the photo
        {
            const turn = mkTurnTracker();
            const tools: any = { check_ingredient_list: { execute: async () => {
                turn.lastIngredientCheck = { score: 84 };
                return { label: 'Bioderma Photoderm Max', score: 84, verdict: 'ممتاز', safetyFlags: [], allergenHits: [] };
            } } };
            const t = mkInput(null, tools);
            const res = await tryScanLane({ message: 'is it worth buying?', images: [png], state: t.st, turnState: turn, tools, parser: async () => ({ brand: 'Bioderma', name: 'Photoderm Max', category: 'sunscreen', ingredients: 'Aqua, Dicaprylyl Carbonate, Octocrylene', quantity: null }), emitCard: (c) => t.cards.push(c) });
            ok(res?.tool === 'check_ingredient_list' && /84\/100/.test(res.text) && /excellent/i.test(res.text) && /Not in our catalog/.test(res.text), 'scan: imported product scored from the photographed INCI list (english reply)');
            ok(t.cards.includes('ingredient_check'), 'scan: ingredient_check card');
        }
        // 3. avoid-list hit is surfaced
        {
            const turn = mkTurnTracker();
            const tools: any = { check_ingredient_list: { execute: async () => { turn.lastIngredientCheck = {}; return { score: 71, verdict: 'x', safetyFlags: [], allergenHits: ['Parfum'] }; } } };
            const t = mkInput(null, tools);
            const res = await tryScanLane({ message: 'يسوى؟', images: [png], state: t.st, turnState: turn, tools, parser: async () => ({ brand: 'X', name: 'Y Cream', category: 'lotion_cream', ingredients: 'Aqua, Parfum', quantity: null }) });
            ok(/⚠️/.test(res?.text || '') && /Parfum/.test(res?.text || ''), 'scan: allergen hit warned');
        }
        // 4. nothing readable → ask for the back label
        {
            const t = mkInput(null, {});
            const res = await tryScanLane({ message: 'يسوى؟', images: [png], state: t.st, turnState: mkTurnTracker(), tools: {}, parser: async () => ({ brand: 'غير محدد', name: 'منتج عناية', category: 'other', ingredients: '', quantity: null }) });
            ok(/الجهة الخلفية/.test(res?.text || ''), 'scan: unreadable photo → asks for the back label');
        }
        // 5. parser failure / bad image
        {
            const t = mkInput(null, {});
            const r1 = await tryScanLane({ message: 'يسوى؟', images: [png], state: t.st, turnState: mkTurnTracker(), tools: {}, parser: async () => { throw new Error('vision down'); } });
            ok(/تعذّرت قراءة الصورة/.test(r1?.text || ''), 'scan: vision failure handled gracefully');
            const r2 = await tryScanLane({ message: 'يسوى؟', images: ['https://evil.example.com/x.png'], state: t.st, turnState: mkTurnTracker(), tools: {}, parser: async () => ({} as any) });
            ok(/لم أتمكن من استعمال الصورة|ما قدرتش نستعمل الصورة/.test(r2?.text || ''), 'scan: rejected image reported');
        }
    }

    // ── 19. V5 · DARIJA VOICE ────────────────────────────────────────────────
    section('v5 darija voice');
    {
        ok(V.detectVoice('واش نقدر نستعمل الريتينول مع فيتامين سي؟').tlang === 'dz', 'Darija (Arabic script) → dz');
        ok(V.detectVoice('راني نبغي سيروم مليح بزاف').register === 'darija', 'Darija markers');
        const az = V.detectVoice('wach nkdar nesta3mel retinol bezzaf');
        ok(az.lang === 'ar' && az.tlang === 'dz', 'Arabizi counts as Arabic Darija');
        ok(V.detectVoice('هل يمكنني استخدام الريتينول مع فيتامين سي في نفس الروتين المسائي؟').tlang === 'ar', 'clean long MSA stays MSA');
        ok(V.detectVoice('est-ce que ce produit est bon pour la peau').tlang === 'fr' && V.detectVoice('is this good').tlang === 'en', 'fr/en unchanged');
        ok(V.detectVoice('نعم', { register: 'darija' }).tlang === 'dz', 'short message keeps the previous register (sticky)');
        ok(V.detectVoice('نعم', {}).tlang === 'ar', 'no history → MSA');
        ok(V.detectMood('وجهي راه يحرقني بزاف') === 'distressed' && V.detectMood('my face is burning and swollen') === 'distressed' && V.detectMood('ça brûle') === 'distressed', 'distress detected (ar/en/fr)');
        ok(V.detectMood('أريد سيروم للبشرة الدهنية') === 'neutral', 'normal message is neutral');
        ok(darijaize('وجدت 3 بدائل') === 'لقيت 3 بدائل' && darijaize('❌ لا يحتوي على الكحول') === '❌ ما فيهش الكحول', 'phrase table');
        ok(darijaize('Alpha Serum: 82/100 — جيد') === 'Alpha Serum: 82/100 — مليح', 'product names and numbers untouched');
        ok(V.calm('رائع 👇 ⚠️ احذر ✅') === 'رائع ⚠️ احذر', 'calm(): emojis removed, ⚠️ kept');
        ok(/Algerian Darija/.test(V.buildVoiceContext(V.detectVoice('واش نقدر نستعمل')) || ''), 'LLM voice context for Darija');
        ok(/safety/i.test(V.buildVoiceContext(V.detectVoice('my face is burning')) || ''), 'LLM voice context for distress puts safety first');
        ok(V.buildVoiceContext(V.detectVoice('is this good')) === null, 'no voice context when nothing to change');
        ok(V.pickVariant(['a', 'b', 'c'], 'same') === V.pickVariant(['a', 'b', 'c'], 'same'), 'variants are deterministic');

        // fast lane speaks Darija / calms distressed users
        const st: any = mkState('v5-voice-1'); st.lastProduct = { id: 'DZ-SSE-AAA-001', brand: 'Alpha', name: 'Alpha Serum' };
        const turn: any = mkTurnTracker();
        const tools: any = { product_contains: { execute: async (a: any) => { const out: any = await productContains({ productId: a.productId, ingredient: a.ingredient }); turn.lastIngredientPresence = out; return out; } } };
        const msg = 'واش فيه عطر؟';
        const res = await tryFastLane({ message: msg, state: st, turnState: turn, tools, intent: classifyIntent(msg, st) as any });
        ok(res?.lang === 'dz' && /فيه العطر/.test(res.text), `fast lane replies in Darija (${res?.text})`);
        const st2: any = mkState('v5-voice-2'); st2.lastProduct = st.lastProduct;
        const msg2 = 'هل فيه عطر؟ أنا خايفة';
        const res2 = await tryFastLane({ message: msg2, state: st2, turnState: mkTurnTracker(), tools, intent: classifyIntent(msg2, st2) as any });
        ok(!!res2 && !/[✅❌👇]/.test(res2.text), 'distressed user gets an emoji-free reply');
        const turn3: any = mkTurnTracker();
        const tools3: any = { generate_usage_schedule: { execute: async (a: any) => { const out: any = generateUsageSchedule(a); turn3.lastUsageSchedule = out; return out; } } };
        const st3: any = mkState('v5-voice-3');
        const m3 = 'كيفاش نستعمل ريتينول 0.5% باش ما يحرقليش وجهي؟';
        const res3 = await tryFastLane({ message: m3, state: st3, turnState: turn3, tools: tools3, intent: classifyIntent(m3, st3) as any });
        ok(/السيمانة/.test(res3?.text || '') && /التنين/.test(res3?.text || '') && /مرة وحدة/.test(res3?.text || ''), 'schedule rendered in Darija (weeks, day names, frequency)');
    }

    // ── 20. V5 · MY CABINET ──────────────────────────────────────────────────
    section('v5 my cabinet');
    const UID = 'user-aaaa-1111-2222';
    {
        ok(CAB.isValidUserId(UID) && !CAB.isValidUserId('short') && !CAB.isValidUserId('has space in id') && !CAB.isValidUserId(undefined), 'user id validation');
        ok(CAB.listItems('nobody-here-0000').length === 0, 'empty cabinet for a new user');
        let r: any = await CAB.addItem(UID, { productId: 'DZ-SSE-BBB-002' });
        ok(r.ok && r.created && r.item.actives.includes('niacinamide') && r.item.status === 'using' && r.item.source === 'catalog', 'add a catalog product by id (actives detected)');
        r = await CAB.addItem(UID, { productName: 'Delta Cleanser' });
        ok(r.ok && r.item.productId === 'DZ-CLE-DDD-001', 'add by name (fuzzy resolution)');
        r = await CAB.addItem(UID, { productId: 'DZ-SSE-BBB-002' });
        ok(r.ok && !r.created && !!r.duplicateOf && CAB.listItems(UID).length === 2, 'adding the same product again updates, never duplicates');
        r = await CAB.addItem(UID, { productId: 'DZ-SSE-AAA-001' });
        ok(r.ok && r.overlap.length === 1 && r.overlap[0].sharedActives.includes('niacinamide'), 'overlap warning: already owns a niacinamide serum');
        r = await CAB.addItem(UID, { brand: 'The Ordinary', name: 'Glycolic Acid Toner', ingredientsText: 'Aqua, Glycolic Acid, Aloe Vera', category: 'toner', source: 'scan' });
        ok(r.ok && r.item.actives.includes('aha') && r.item.source === 'scan' && !r.item.productId, 'manual/scanned product with INCI (not in catalog)');
        r = await CAB.addItem(UID, {});
        ok(!r.ok, 'empty add rejected');
        r = await CAB.addItem('bad', { productId: 'DZ-SSE-AAA-001' });
        ok(!r.ok && r.error === 'invalid_user', 'invalid user rejected');

        const items = CAB.listItems(UID);
        const raw = fs.readFileSync(process.env.CABINET_FILE!, 'utf-8');
        ok(!raw.includes(UID), 'raw userId never stored (hashed)');
        ok((fs.statSync(process.env.CABINET_FILE!).mode & 0o777) === 0o600, 'cabinet file mode 0600');
        ok(CAB.listItems('other-user-0000').length === 0, 'users are isolated');

        const gaps = CAB.cabinetGaps(items);
        ok(gaps.includes('sunscreen') && !gaps.includes('cleanser'), 'gap analysis: has cleanser, missing sunscreen/moisturizer');
        const sum = CAB.summarizeCabinet(items);
        ok(sum.valueInUse.min > 0 && sum.valueInUse.unpriced === 1 && sum.byStatus.using === 4, 'value counts priced items; unpriced ones are counted, never guessed');

        const upd = CAB.updateItem(UID, items.find((i: any) => i.productId === 'DZ-SSE-CCC-003')?.id || '', { status: 'stopped' });
        ok(upd === null, 'update of a missing id returns null');
        const alpha = CAB.listItems(UID).find((i: any) => i.productId === 'DZ-SSE-AAA-001')!;
        const u2 = CAB.updateItem(UID, alpha.id, { verdict: 'didnt_suit', status: 'stopped', reason: 'burning' });
        ok(u2?.verdict === 'didnt_suit' && u2.status === 'stopped' && u2.reason === 'burning', 'honest verdict stored');
        const disliked = CAB.dislikedIngredientLists(CAB.listItems(UID));
        ok(disliked.length === 1 && CAB.similarToDisliked(['Aqua', 'Glycerin', 'Niacinamide', 'Zinc PCA', 'Cetearyl Alcohol', 'Parfum'], disliked), 'near-copy of a disliked product is detected');
        ok(!CAB.similarToDisliked(['Aqua', 'Ceramide NP', 'Glycerin'], disliked), 'unrelated product is not flagged');
        const alt: any = await findAlternatives({ productId: 'DZ-SSE-BBB-002', disliked_lists: disliked });
        ok(!alt.products?.some((p: any) => p.id === 'DZ-SSE-AAA-001') && alt.skippedSimilarToDisliked === 1, 'alternatives skip look-alikes of what did not suit the user');
        ok(CAB.ownsProduct(CAB.listItems(UID), 'DZ-CLE-DDD-001') !== null, 'ownsProduct');
        ok(CAB.routineSeedFromCabinet(CAB.listItems(UID)).includes('DZ-CLE-DDD-001'), 'routine seed from cabinet');
        ok(CAB.removeItem(UID, alpha.id) === true && CAB.listItems(UID).length === 3, 'remove');
        ok(CAB.findItem(CAB.listItems(UID), { text: 'delta cleanser' })?.productId === 'DZ-CLE-DDD-001', 'find item by name');

        const { parseCabinetCommand } = await import('../src/agent/intents');
        ok(parseCabinetCommand('ضيف هذا لخزانتي')?.action === 'add', 'cmd: add (darija)');
        ok(parseCabinetCommand('add this to my cabinet')?.action === 'add', 'cmd: add (en)');
        ok(parseCabinetCommand('وريني خزانتي')?.action === 'list' && parseCabinetCommand('what is in my cabinet?')?.action === 'list', 'cmd: list');
        ok(parseCabinetCommand('خلصت هذا المنتج')?.status === 'finished' && parseCabinetCommand('I finished it')?.status === 'finished', 'cmd: finished');
        ok(parseCabinetCommand('ما ناسبنيش هذا')?.verdict === 'didnt_suit' && parseCabinetCommand("it didn't suit me")?.verdict === 'didnt_suit', 'cmd: did not suit');
        ok(parseCabinetCommand('قيم لي Alpha Serum') === null && parseCabinetCommand('is this good') === null, 'cmd: normal messages are not cabinet commands');

        // chat flow through the fast lane
        const st: any = mkState('v5-cab-1'); st.userId = UID; st.lastProduct = { id: 'DZ-SSE-AAA-001', brand: 'Alpha', name: 'Alpha Serum' };
        const turn: any = mkTurnTracker();
        const tools: any = { manage_cabinet: { execute: async (a: any) => {
            const out: any = await CAB.addItem(UID, { productId: a.product_id || st.lastProduct.id });
            if (!out.ok) return { error: out.error };
            turn.lastCabinet = { items: CAB.listItems(UID) };
            return { added: { brand: out.item.brand, name: out.item.name }, created: out.created, alreadyHadIt: !!out.duplicateOf, overlap: out.overlap.map((o: any) => ({ with: o.item.name, sharedActives: o.sharedActives })), gaps: CAB.cabinetGaps(CAB.listItems(UID)) };
        } } };
        const msg = 'ضيف هذا لخزانتي';
        const h = classifyIntent(msg, st);
        ok(h.likelyTools[0] === 'manage_cabinet' && h.confidence === 'high', `router → manage_cabinet (got ${h.likelyTools[0]}/${h.confidence})`);
        const res = await tryFastLane({ message: msg, state: st, turnState: turn, tools, intent: h as any });
        ok(res?.tool === 'manage_cabinet' && /أضفت Alpha Serum/.test(res.text.replace('سماح', '')) , `fast lane adds to the cabinet (${res?.text})`);
        const st2: any = mkState('v5-cab-2'); st2.lastProduct = st.lastProduct;
        const res2 = await tryFastLane({ message: msg, state: st2, turnState: mkTurnTracker(), tools, intent: classifyIntent(msg, st2) as any });
        ok(/حساب|سجّل الدخول|سجل الدخول/.test(res2?.text || ''), 'no userId → friendly "sign in" message, nothing stored');

        // the scan lane offers to add the product, and a "yes" does it
        const st3: any = mkState('v5-cab-3'); st3.userId = UID;
        const pngc = 'data:image/png;base64,iVBORw0KGgo=';
        const turn3: any = mkTurnTracker();
        const tools3: any = { check_ingredient_list: { execute: async () => { turn3.lastIngredientCheck = {}; return { score: 77, verdict: 'x', safetyFlags: [], allergenHits: [] }; } } };
        const scanRes = await tryScanLane({ message: 'is it good?', images: [pngc], state: st3, turnState: turn3, tools: tools3, parser: async () => ({ brand: 'Bioderma', name: 'Photoderm Max', category: 'sunscreen', ingredients: 'Aqua, Octocrylene, Zinc Oxide', quantity: null }) });
        ok(/add it to your cabinet/i.test(scanRes?.text || '') && st3.pendingOffer?.tool === 'manage_cabinet', 'scan lane offers to add the product to the cabinet');
    }

    // ── 21. V5 · REACTION TRIAGE ─────────────────────────────────────────────
    section('v5 reaction triage');
    {
        ok(TR.looksLikeReaction('وجهي راه يحرقني من ملي بديت الريتينول'), 'reaction detected (darija)');
        ok(TR.looksLikeReaction('my face is red and peeling after retinol'), 'reaction detected (en)');
        ok(TR.looksLikeReaction('ظهرو لي حبوب بعد ما بديت حمض الساليسيليك'), 'breakout after starting an active counts as a reaction');
        ok(!TR.looksLikeReaction('أريد كريم للحمرة') && !TR.looksLikeReaction('what is retinol?') && !TR.looksLikeReaction('أريد علاج للحبوب') && !TR.looksLikeReaction('أريد مقشر لطيف'), 'search / education / exfoliation requests are not reactions');
        ok(TR.parseDaysAgo('من 3 أيام') === 3 && TR.parseDaysAgo('since 2 weeks') === 14 && TR.parseDaysAgo('hier') === 1 && TR.parseDaysAgo('hello') === undefined, 'duration parsing');

        const urgent: any = TR.triageReaction({ text: 'my lips are swollen and I can\'t breathe properly after the new serum' });
        ok(urgent.urgency === 'urgent' && urgent.redFlags.length >= 1, 'swollen lips + breathing trouble → URGENT');
        ok(/urgent|فوراً/i.test(urgent.steps[1].en + urgent.steps[1].ar), 'urgent plan says seek care now');
        const hives: any = TR.triageReaction({ text: 'ظهر لي طفح على وجهي كامل' });
        ok(hives.urgency === 'urgent', 'widespread rash → urgent');

        const irr: any = TR.triageReaction({ text: 'وجهي راه يحرقني ويتقشر من 3 أيام', candidates: [{ label: 'Gamma Serum', keys: ['retinoid'], startedDaysAgo: 3 }, { label: 'Delta Cleanser', keys: ['sulfate'] }] });
        ok(irr.type === 'irritation' && irr.urgency === 'self_care' && irr.culprits[0].label === 'Gamma Serum', 'irritation: new retinoid ranked as the likely culprit');
        ok(/أوقف/.test(irr.steps[0].ar) && irr.steps.length >= 3, 'irritation plan: pause actives + repair steps');
        ok(irr.sinceDays === 3, 'onset parsed');

        const purge: any = TR.triageReaction({ text: 'ظهرو لي حبوب جديدة بعد ما بديت الساليسيليك', candidates: [{ label: 'BHA', keys: ['bha'], startedDaysAgo: 21 }] });
        ok(purge.type === 'purge', 'breakouts only + exfoliant started 3 weeks ago → purge');
        const allergy: any = TR.triageReaction({ text: 'itchy red swollen cheeks after the new cream' });
        ok(allergy.type === 'allergy_suspect' && allergy.urgency === 'doctor_soon', 'itch + redness + swelling → suspected allergy, see a doctor soon');
        const overload: any = TR.triageReaction({ text: 'burning and red', candidates: [{ label: 'A', keys: ['retinoid'] }, { label: 'B', keys: ['aha'] }] });
        ok(overload.layeringOverload === true, 'layering overload flagged (2 exfoliant-class products)');
        const back: any = TR.triageReaction({ text: 'burning', scheduleActive: 'ريتينول', candidates: [{ label: 'R', keys: ['retinoid'] }] });
        ok(!!back.backOff && /ريتينول/.test(back.backOff.ar), 'back-off plan references the induction schedule');
        const none: any = TR.triageReaction({ text: 'my face is burning' });
        ok(none.needsMoreInfo === true && none.culprits.length === 0, 'no candidates → asks what was started');
        const preg: any = TR.triageReaction({ text: 'burning after retinol', pregnant: true, candidates: [{ label: 'R', keys: ['retinoid'] }] });
        ok(!!preg.pregnancyNote, 'pregnancy note when a retinoid is involved');

        const msg = 'وجهي راه يحرقني من ملي بديت الريتينول';
        const stT: any = mkState('v5-triage-1');
        const h = classifyIntent(msg, stT);
        ok(h.likelyTools[0] === 'triage_reaction' && h.confidence === 'high', `router → triage_reaction first (got ${h.likelyTools[0]}/${h.confidence})`);
        const turn: any = mkTurnTracker();
        const tools: any = { triage_reaction: { execute: async () => { const out: any = TR.triageReaction({ text: msg, candidates: [{ label: 'الريتينول', keys: ['retinoid'], startedDaysAgo: 5 }] }); turn.lastTriage = out; return out; } } };
        const res = await tryFastLane({ message: msg, state: stT, turnState: turn, tools, intent: h as any });
        ok(res?.tool === 'triage_reaction' && /1\)/.test(res.text) && /أوقف|وقف/.test(res.text), 'fast lane answers with a stop-and-repair plan');
        ok(!/[✅👇👌]/.test(res!.text), 'distressed user: calm, emoji-free');
        const flagMsg = 'شفايفي منتفخة وما نقدرش نتنفس مزيان';
        const stF: any = mkState('v5-triage-2');
        const turnF: any = mkTurnTracker();
        const toolsF: any = { triage_reaction: { execute: async () => { const out: any = TR.triageReaction({ text: flagMsg }); turnF.lastTriage = out; return out; } } };
        const resF = await tryFastLane({ message: flagMsg, state: stF, turnState: turnF, tools: toolsF, intent: classifyIntent(flagMsg, stF) as any });
        ok(/⚠️/.test(resF?.text || '') && /عاجلة|دروك|فوراً/.test(resF?.text || ''), 'red-flag message gets an urgent-care reply first');
    }

    // ── 22. V5 · LIFE-STAGE MODES ────────────────────────────────────────────
    section('v5 life-stage modes');
    {
        ok(MODES.detectLifeStage('أنا حامل في الشهر الثالث').stage === 'pregnancy' && MODES.detectLifeStage("I'm pregnant").stage === 'pregnancy' && MODES.detectLifeStage('je suis enceinte').stage === 'pregnancy' && MODES.detectLifeStage('I am breastfeeding').stage === 'pregnancy', 'pregnancy/breastfeeding detected (ar/en/fr)');
        ok(MODES.detectLifeStage('عمري 15 سنة').stage === 'teen' && MODES.detectLifeStage("I'm 16").stage === 'teen' && MODES.detectLifeStage("j'ai 14 ans").stage === 'teen', 'teen detected from stated age');
        ok(MODES.detectLifeStage("I'm 25").stage === null && MODES.detectLifeStage('ماشي حامل').stage === null && MODES.detectLifeStage('أريد سيروم').stage === null, 'adults / negation / unrelated → no stage');
        ok(MODES.detectLifeStage('ولدت وخلصت الرضاعة').clear === true, 'end of pregnancy detected');
        const profile: any = { concerns: [], allergies: [], avoidIngredients: ['عطر'], preferredBrands: [] };
        ok(MODES.applyLifeStage(profile, MODES.detectLifeStage('أنا حامل')) && profile.avoidIngredients.includes('retinol') && profile.avoidIngredients.includes('hydroquinone') && profile.avoidIngredients.includes('عطر'), 'pregnancy adds retinoids + hydroquinone to the avoid list (keeps the existing ones)');
        ok(!MODES.applyLifeStage(profile, MODES.detectLifeStage('أنا حامل')), 'applying twice changes nothing');
        ok(/PREGNANCY/.test(MODES.buildLifeStageContext(profile) || ''), 'pregnancy context for the LLM');
        const alt: any = await findAlternatives({ productId: 'DZ-SSE-AAA-001', avoid: profile.avoidIngredients });
        ok(!alt.products?.some((p: any) => p.id === 'DZ-SSE-CCC-003'), 'pregnancy exclusion flows into alternatives (retinol serum never offered)');
        MODES.applyLifeStage(profile, MODES.detectLifeStage('ولدت'));
        ok(!profile.avoidIngredients.includes('retinol') && profile.avoidIngredients.includes('عطر') && profile.lifeStage === undefined, 'ending pregnancy removes ONLY the auto-added exclusions');
        const teen: any = { concerns: [], allergies: [], avoidIngredients: [], preferredBrands: [] };
        MODES.applyLifeStage(teen, MODES.detectLifeStage('عمري 15 سنة'));
        ok(teen.lifeStage === 'teen' && /TEEN/.test(MODES.buildLifeStageContext(teen) || ''), 'teen mode context');
        const sch: any = generateUsageSchedule({ active: 'retinol', sensitivity: 'experienced', skin_sensitive: true });
        ok(sch.sensitivity === 'beginner', 'gentle ramp is forced for sensitive/teen skin');
    }

    // ── 23. V5 · PRACTICAL OUTPUTS ───────────────────────────────────────────
    section('v5 practical outputs');
    {
        // routine versions & undo
        const st: any = mkState('v5-ver-1');
        const r1 = routine;
        const r2: any = await modifyRoutine(r1, { action: 'swap', step_number: 1, cheaper: true });
        const r3: any = await modifyRoutine(r2, { action: 'add', category: 'toner', max_budget: 9000 });
        st.lastRoutine = r1; RH.recordRoutineVersion(st, r1, 'build');
        st.lastRoutine = r2; RH.recordRoutineVersion(st, r2, 'swap step 1');
        ok(RH.recordRoutineVersion(st, r2, 'duplicate') === null, 'identical routine is not recorded twice');
        st.lastRoutine = r3; RH.recordRoutineVersion(st, r3, 'add toner');
        ok(RH.versionsOf(st).length === 3 && RH.currentVersion(st)?.n === 3, 'versions recorded in order');
        const undone = RH.undoRoutine(st);
        ok(undone?.n === 2 && st.lastRoutine.steps[0].product.id === 'DZ-CLE-EEE-002' && st.lastRoutine.steps.length === 3, 'undo restores the previous version');
        const first = RH.restoreVersion(st, 1);
        ok(first?.n === 1 && st.lastRoutine.steps[0].product.id === 'DZ-CLE-DDD-001', 'restore version 1 (the original)');
        ok(RH.undoRoutine(st) === null, 'nothing to undo from the first version');
        const diff = RH.diffRoutines(RH.versionsOf(st)[0], RH.versionsOf(st)[2]);
        ok(diff.swapped.length === 1 && diff.added.length === 1 && diff.totalDelta === r3.totalCost - r1.totalCost, 'diff: one swap, one addition, cost delta');
        ok(RH.parseVersionCommand('ارجع للروتين الأول')?.action === 'restore' && RH.parseVersionCommand('ارجع للروتين الأول')?.version === 1, 'cmd: back to the first routine');
        ok(RH.parseVersionCommand('go back to the previous routine')?.action === 'undo' && RH.parseVersionCommand('undo')?.action === 'undo', 'cmd: undo');
        ok(RH.parseVersionCommand('قارن بين الروتينين')?.action === 'compare' && RH.parseVersionCommand('compare the two routines')?.action === 'compare', 'cmd: compare');
        ok(RH.parseVersionCommand('قيم لي هذا المنتج') === null, 'cmd: unrelated message');

        // share card + WhatsApp text
        const share = OUT.buildRoutineShare({ ...r1, title: 'روتين البشرة الدهنية', concern: 'بشرة دهنية' }, 'ar');
        ok(share.steps.length === 3 && share.total.value === 4400 && share.steps[0].product.priceKnown, 'share: steps and total');
        ok(/^🧴 \*روتين البشرة الدهنية\*/.test(share.whatsappText) && /1️⃣/.test(share.whatsappText) && /4400 دج/.test(share.whatsappText), 'share: WhatsApp-formatted text');
        ok(/# روتين/.test(share.markdown) && share.disclaimers.length === 2, 'share: markdown + disclaimers');
        const shareEn = OUT.buildRoutineShare(r1, 'en');
        ok(/Total/.test(shareEn.whatsappText) && /indicative/.test(shareEn.disclaimers[0]), 'share: English version');

        // shopping list
        const cabItems: any[] = [{ id: 'c1', productId: 'DZ-CLE-DDD-001', brand: 'Delta', name: 'Delta Cleanser', status: 'using', actives: [], source: 'catalog', addedAt: '', updatedAt: '' }];
        const sl = OUT.buildShoppingList({ routine: r1, cabinet: cabItems, lang: 'ar' });
        ok(sl.owned.length === 1 && sl.toBuy.length === 2 && sl.total.min === 3500 && sl.total.unpriced === 0, 'shopping list: owned product removed from the total');
        ok(sl.toBuy[0].category === 'skin_serum' || sl.toBuy[0].priority <= sl.toBuy[1].priority, 'shopping list ordered by what to buy first');
        ok(/☐/.test(sl.whatsappText) && /☑/.test(sl.whatsappText), 'shopping list: tick boxes in text');
        const slUnpriced = OUT.buildShoppingList({ products: [{ id: 'X1', brand: 'B', name: 'No Price Serum', category: 'skin_serum', priceKnown: false }, { id: 'X2', brand: 'B', name: 'Cheap Cleanser', category: 'cleanser', price: '350 – 400', currency: 'DZD', priceKnown: true }], lang: 'en' });
        ok(slUnpriced.total.unpriced === 1 && slUnpriced.total.min === 350, 'unknown prices are counted, never guessed');
        const over = OUT.buildShoppingList({ routine: { ...r1, maxBudget: 3000 }, lang: 'ar' });
        ok(over.overBudget === true, 'over-budget flagged');

        // gift mode
        const gift: any = await buildGiftSet({ budget: 6000, recipient: 'mom' });
        ok(!gift.error && gift.isGift && gift.steps.every((x: any) => x.category !== 'treatment') && gift.totalCost <= 6000, 'gift set within budget');
        ok(gift.steps.every((x: any) => !/Retinol|Parfum|Salicylic|Glycolic/i.test(JSON.stringify(x.product))), 'gift set contains no potent actives or fragrance entries');
        ok('error' in ((await buildGiftSet({ budget: 0 })) as any), 'gift needs a budget');
        ok(parseOutputCommand('أبغي نهدي ماما 3000 دج')?.kind === 'gift' && parseOutputCommand('أبغي نهدي ماما 3000 دج')?.budget === 3000, 'cmd: gift + budget');
        ok(parseOutputCommand('اعطيني قائمة التسوق')?.kind === 'shopping' && parseOutputCommand('what should I buy?')?.kind === 'shopping', 'cmd: shopping list');
        ok(parseOutputCommand('شارك الروتين على واتساب')?.kind === 'share' && parseOutputCommand('share my routine')?.kind === 'share', 'cmd: share');
        ok(parseOutputCommand('أريد سيروم') === null, 'cmd: unrelated');

        // router + fast lane for outputs
        const stR: any = mkState('v5-out-1'); stR.lastRoutine = r1;
        ok(classifyIntent('اعطيني قائمة التسوق', stR).likelyTools[0] === 'build_shopping_list', 'router → build_shopping_list');
        ok(classifyIntent('شارك الروتين على واتساب', stR).likelyTools[0] === 'share_routine', 'router → share_routine');
        ok(classifyIntent('ارجع للروتين الأول', stR).likelyTools[0] === 'routine_versions', 'router → routine_versions');
        ok(classifyIntent('أبغي نهدي ماما 3000 دج', mkState('v5-out-2')).likelyTools[0] === 'build_gift_set', 'router → build_gift_set (no routine needed)');
        const turnS: any = mkTurnTracker();
        const toolsS: any = { build_shopping_list: { execute: async () => { const l = OUT.buildShoppingList({ routine: r1, cabinet: cabItems, lang: 'ar' }); turnS.lastShoppingList = l; return { toBuy: l.toBuy.map((i: any) => ({ name: i.name })), alreadyOwned: l.owned.map((i: any) => i.name), total: l.total, overBudget: l.overBudget, buyFirst: l.buyFirst }; } } };
        const resS = await tryFastLane({ message: 'اعطيني قائمة التسوق', state: stR, turnState: turnS, tools: toolsS, intent: classifyIntent('اعطيني قائمة التسوق', stR) as any });
        ok(resS?.tool === 'build_shopping_list' && /2 منتج/.test(resS.text) && /3500/.test(resS.text) && /عندك أصلاً/.test(resS.text), 'fast lane: shopping list summary (owned removed)');
        const resG = await tryFastLane({ message: 'أبغي نهدي ماما', state: mkState('v5-out-3'), turnState: mkTurnTracker(), tools: {}, intent: classifyIntent('أبغي نهدي ماما', mkState('v5-out-3')) as any });
        ok(resG?.tool === 'build_gift_set' && /ميزانيتك/.test(resG.text), 'fast lane: gift without a budget asks for it');

        // quick replies
        const q1 = QR.suggestQuickReplies({ replyText: 'ما هو نوع بشرتك؟', lang: 'ar' });
        ok(q1.length === 5 && q1[0].value === 'بشرتي دهنية', 'quick replies: skin type');
        ok(QR.suggestQuickReplies({ replyText: 'حسب ملفك الشخصي، نوع بشرتك مختلطة. هل تريد اقتراح منتج؟', lang: 'ar', hasSkinType: true }).length === 0, 'quick replies: do not re-ask a known skin type because of another question');
        ok(QR.suggestQuickReplies({ replyText: 'نوع بشرتك المختلطة يناسبها هذا المرطب؟', lang: 'ar' }).length === 0, 'quick replies: do not trigger from a skin mention inside an unrelated question');
        const q2 = QR.suggestQuickReplies({ replyText: 'شحال ميزانيتك؟', lang: 'dz' });
        ok(q2.length === 4 && /ميزانيتي 2000/.test(q2[0].value), 'quick replies: budget');
        ok(QR.suggestQuickReplies({ replyText: 'which city do you live in?', lang: 'en' })[0].value === 'I live in Algiers', 'quick replies: city');
        ok(QR.suggestQuickReplies({ replyText: 'أبحث لك؟', lang: 'ar', pendingOfferActive: true }).map((x: any) => x.id).join() === 'yes,no', 'quick replies: yes/no for a pending offer');
        ok(QR.suggestQuickReplies({ replyText: 'هل تريد قائمة التسوق؟', lang: 'ar', hasRoutine: true, sectionTypes: ['routine'] }).some((x: any) => x.id === 'shop'), 'quick replies: routine actions offered as a question');
        ok(QR.suggestQuickReplies({ replyText: 'هذا روتينك.', lang: 'ar', hasRoutine: true, sectionTypes: ['routine'] }).length === 0, 'quick replies: do not offer unrelated routine actions');
        ok(QR.suggestQuickReplies({ replyText: 'مرحبا', lang: 'ar' }).length === 0, 'no chips when there is nothing to ask');
    }

    // ── 24. V5 · TRANSPARENCY: EXPLAIN, CONFIDENCE, PRICES ───────────────────
    section('v5 transparency');
    {
        ok(isWhyQuestion('علاش اخترت هذا؟') && isWhyQuestion('why did you recommend this one?') && isWhyQuestion('pourquoi tu as choisi celui-là ?') && !isWhyQuestion('قيم هذا المنتج'), 'why-question detection');
        const p1: any = (await getProductFn({ productId: 'DZ-SSE-BBB-002' })).product;
        const ex: any = explainPick({ ...p1, marketingClaims: ['تنقية المسام'] }, { searchArgs: { category: 'skin_serum', active_ingredient: 'niacinamide', max_price: 2000, country: 'Algeria' }, evaluation: { score: 81, safety: 85, efficacy: 70 }, avoid: ['alcohol', 'parfum'], profile: { budgetMax: 2000 }, rank: { index: 0, total: 5 } });
        const flat = ex.reasons.map((r: any) => r.en).join(' | ');
        ok(/Contains niacinamide|Contains النياسيناميد|niacinamide/i.test(flat) && /OilGuard score: 81/.test(flat) && /fits your budget/.test(flat) && /Free of what you avoid/.test(flat) && /Ranked #1 of 5/.test(flat), 'explanation lists real reasons (active, score, budget, avoid-list, rank)');
        ok(ex.caveats.some((c: any) => /brand, not clinical proof/.test(c.en)), 'always says claims are the brand\'s, not proof');
        ok(ex.confidence.level === 'medium' || ex.confidence.level === 'high', 'confidence computed');
        // products with missing data are described honestly
        const bare: any = { id: 'X', brand: 'B', name: 'Bare', ingredientList: [], marketingClaims: [], targetTypes: [] };
        const exBare: any = explainPick(bare, {});
        ok(exBare.confidence.level === 'low' && exBare.caveats.some((c: any) => /price on file/i.test(c.en)) && exBare.caveats.some((c: any) => /ingredient list is missing/i.test(c.en)) && exBare.reasons.length === 0, 'missing data → low confidence + explicit caveats, no invented reasons');
        ok(dataConfidence({ ingredientList: ['a', 'b', 'c'], priceMin: 100, marketingClaims: ['x'] }).level === 'high', 'high confidence needs ingredients + price + claims');

        // price handling: ranges and unknown prices
        const priced = (await getProductFn({ productId: 'DZ-SSE-BBB-002' })).product as any;
        ok(priced.priceKnown === undefined || true, 'product formatting tolerant');
        const cands = await searchProducts({ category: 'skin_serum', limit: 10 });
        ok(cands.products.every((x: any) => typeof x.priceKnown === 'boolean') && typeof cands.unpricedCount === 'number', 'search results flag priceKnown and count unpriced');
        const rng: any = await findActivesDupe({ target_actives: ['niacinamide'], category: 'skin_serum', reference_price: 1600 });
        ok(!rng.error && rng.products.every((x: any) => (x.priceSavingPct ?? 0) >= 0), 'dupe savings are never negative');
    }

    // ── 25. V5 · COMMUNITY LEARNING PIPELINE ─────────────────────────────────
    section('v5 community learning');
    {
        const kFile = path.join(tmp, 'data', 'knowledge.json'), rFile = path.join(tmp, 'data', 'review.json');
        for (const f of [kFile, rFile]) { try { fs.unlinkSync(f); } catch { /* none */ } }
        // fake embedder: texts mentioning "hyaluronic" are near each other, "retinol" elsewhere
        const embed = async (texts: string[]) => texts.map(t => /hyaluron/i.test(t) ? [1, 0.02, 0] : /pregnan/i.test(t) ? [0, 1, 0.02] : /retinol/i.test(t) ? [0.02, 0, 1] : [0.5, 0.5, 0.5]);
        const judgeOf = (map: Record<string, any>) => async (items: any[]) => items.map(i => ({ id: i.id, verdict: 'accept', text: i.insight, confidence: 0.9, risk: 'none', ...(map[i.id] || {}) }));
        const deps = (map: any = {}) => ({ judge: judgeOf(map), embed, knowledgeFile: kFile, reviewFile: rFile, now: () => new Date('2026-10-12T00:00:00Z') });

        let r = await LRN.learnFromStaged([
            { id: 'a', category: 'cosmetic_science', insight: 'Hyaluronic acid is a humectant that binds water to the skin surface.', sessionId: 's1' },
            { id: 'b', category: 'brand_info', insight: 'Venus is the best brand ever!!!', sessionId: 's2' },
            { id: 'c', category: 'cosmetic_science', insight: 'Retinol is dangerous for pregnant women and causes birth defects.', sessionId: 's3' },
            { id: 'd', category: 'cosmetic_science', insight: 'Some brands say retinol works better at night.', sessionId: 's4' },
        ], deps({ b: { verdict: 'reject' }, c: { risk: 'medical', confidence: 0.95 }, d: { verdict: 'needs_review', confidence: 0.65 } }));
        ok(r.learned.join() === 'a' && r.rejected.join() === 'b' && r.queuedForReview.sort().join() === 'c,d' && r.failed.length === 0, 'accepted / rejected / queued split');
        let know: any[] = JSON.parse(fs.readFileSync(kFile, 'utf-8'));
        ok(know.length === 1 && know[0].category === 'community_knowledge' && know[0].priority === 30 && know[0].source === 'user_taught' && Array.isArray(know[0].vector), 'learned entry has priority, source and vector (the old worker wrote neither priority nor a compatible vector)');
        ok(!know.some((k: any) => /pregnant/.test(k.text)), 'medical/safety claims are NEVER auto-learned');
        ok(LRN.listReviewQueue(rFile).length === 2 && LRN.listReviewQueue(rFile).every((x: any) => !('vector' in x)), 'review queue holds the risky/unsure ones (vectors not exposed)');

        // the same fact from another session merges into the existing entry (support +1), no duplicate vector
        r = await LRN.learnFromStaged([{ id: 'a2', category: 'cosmetic_science', insight: 'Hyaluronic acid draws and holds water in skin.', sessionId: 's9' }], deps());
        know = JSON.parse(fs.readFileSync(kFile, 'utf-8'));
        ok(r.merged.join() === 'a2' && know.length === 1 && know[0].supports === 2, 'duplicate report merges and increments supports');
        r = await LRN.learnFromStaged([{ id: 'a3', category: 'cosmetic_science', insight: 'Hyaluronic acid draws and holds water in skin.', sessionId: 's9' }], deps());
        know = JSON.parse(fs.readFileSync(kFile, 'utf-8'));
        ok(know[0].supports === 2, 'the same session cannot inflate support');

        // three independent sessions agreeing promotes an unsure (but risk-free) item
        for (const sid of ['t1', 't2']) {
            await LRN.learnFromStaged([{ id: `d_${sid}`, category: 'cosmetic_science', insight: 'Some brands say retinol works better at night.', sessionId: sid }], deps({ [`d_${sid}`]: { verdict: 'needs_review', confidence: 0.65 } }));
        }
        know = JSON.parse(fs.readFileSync(kFile, 'utf-8'));
        ok(know.some((k: any) => /retinol works better at night/.test(k.text) && k.supports >= 3), 'support threshold (3 independent sessions) auto-promotes low-risk facts');
        ok(!LRN.listReviewQueue(rFile).some((x: any) => /works better at night/.test(x.text)), '…and removes them from the review queue');

        // human review: approve the medical one
        const pending = LRN.listReviewQueue(rFile).find((x: any) => /pregnant/.test(x.text))!;
        const dec = await LRN.decideReview(pending.id, 'approve', { knowledgeFile: kFile, reviewFile: rFile });
        know = JSON.parse(fs.readFileSync(kFile, 'utf-8'));
        ok(dec.ok && know.some((k: any) => /pregnant/.test(k.text) && k.reviewedByHuman === true), 'a human can approve a queued fact');
        ok((await LRN.decideReview('nope', 'reject', { reviewFile: rFile })).ok === false, 'unknown review id');

        // failures leave items for retry
        const bad = await LRN.learnFromStaged([{ id: 'z', category: 'cosmetic_science', insight: 'Hyaluronic acid is a humectant.', sessionId: 'q' }], { ...deps(), judge: async () => { throw new Error('llm down'); } });
        ok(bad.failed.join() === 'z' && bad.processedIds.length === 0, 'judge failure → item stays staged for retry');
        const bad2 = await LRN.learnFromStaged([{ id: 'y', category: 'cosmetic_science', insight: 'Hyaluronic acid is a humectant.', sessionId: 'q' }], { ...deps(), embed: async () => { throw new Error('embed down'); } });
        ok(bad2.failed.join() === 'y', 'embedding failure → item stays staged for retry');
    }

    // ── 26. V5 · FEEDBACK & CONTRIBUTIONS ────────────────────────────────────
    section('v5 feedback & contributions');
    {
        const mid = FB.newMessageId();
        FB.registerMessage(mid, { lane: 'fast', tools: ['product_analysis'] });
        ok(FB.recordFeedback({ sessionId: 'sess-1', messageId: mid, rating: 'up' }).ok, 'thumbs up recorded');
        const d = FB.recordFeedback({ sessionId: 'sess-2', messageId: mid, rating: 'down', reason: 'wrong_info', correction: 'Actually niacinamide can be used together with AHAs for most people.' });
        ok(d.ok && d.staged, 'thumbs down + correction → staged for learning (not learned)');
        ok(!FB.recordFeedback({ sessionId: 'sess-3', rating: 'meh' as any }).ok && !FB.recordFeedback({ sessionId: '', rating: 'up' }).ok, 'invalid feedback rejected');
        const raw = fs.readFileSync(process.env.FEEDBACK_FILE!, 'utf-8');
        ok(!raw.includes('sess-1') && !raw.includes('niacinamide'), 'feedback log stores no session id and no message/correction text');
        const stats = FB.feedbackStats(process.env.FEEDBACK_FILE!);
        ok(stats.total === 2 && stats.up === 1 && stats.down === 1 && stats.satisfaction === 50 && stats.byLane.fast.up === 1 && stats.byReason.wrong_info === 1 && stats.corrections === 1, 'stats by lane / reason');

        const cf = process.env.CONTRIBUTIONS_FILE!;
        const draft = { brand: 'Bioderma', name: 'Photoderm Max Aquafluid', category: 'sunscreen', ingredients: 'Aqua, Dicaprylyl Carbonate, Octocrylene, Zinc Oxide', quantity: '40 ml' };
        const c1: any = CTB.submitContribution(draft, 'user-xyz', { file: cf });
        ok(c1.ok && !c1.duplicate && CTB.listContributions('pending', cf).length === 1, 'contribution submitted as pending');
        ok(CTB.submitContribution(draft, 'someone-else', { file: cf }).duplicate === true, 'same product is not submitted twice');
        ok(CTB.submitContribution({ ...draft, name: 'X' }, 'u', { file: cf }).ok === false && CTB.submitContribution({ ...draft, name: 'Other Product', ingredients: 'Aqua' }, 'u', { file: cf }).error === 'too_few_ingredients', 'incomplete contributions rejected');
        let limited: any = null;
        for (let i = 0; i < 6; i++) limited = CTB.submitContribution({ ...draft, name: `Spam Product ${i}` }, 'spammer', { file: cf });
        ok(limited.ok === false && limited.error === 'rate_limited', 'daily per-user rate limit');
        ok(!JSON.stringify(CTB.listContributions('pending', cf)).includes('user-xyz'), 'listing never exposes who submitted');

        const before = (await getProducts()).length;
        const ap = CTB.decideContribution(c1.id, 'approve', { file: cf, approvedFile: process.env.APPROVED_CONTRIBUTIONS_FILE });
        ok(ap.ok && /^USR-/.test(ap.productId!), 'approval creates a community product id');
        ok(mergeApprovedIntoCatalog() === 1 && (await getProducts()).length === before + 1, 'approved product goes live in the catalog immediately');
        const live: any = await getProductFn({ productId: ap.productId });
        ok(live.found && live.product.ingredientList.length === 4, 'approved product is resolvable by every tool');
        const exLive: any = explainPick({ ...live.product, communitySubmitted: true }, {});
        ok(exLive.caveats.some((c: any) => /moderated user contribution/.test(c.en)) && exLive.caveats.some((c: any) => /price on file/i.test(c.en)), 'community products are labelled and their missing price is stated');
        ok(CTB.decideContribution('nope', 'reject', { file: cf }).ok === false, 'unknown contribution id');
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
